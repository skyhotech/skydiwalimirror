from django.core.management.base import BaseCommand
from django.db import transaction

from mirrors.images import (
    FRAME_SIZE,
    POSTER_SIZE,
    SELFIE_SIZE,
    THUMB_SIZE,
    compressed_photo,
    optimized,
)
from mirrors.models import Customer, Mirror


class Command(BaseCommand):
    help = (
        "Shrink existing mirror artwork and customer photos and create dashboard "
        "thumbnails. Run `manage.py backup` first: originals are replaced."
    )

    def _replace(self, obj, field, size, quality=None):
        current = getattr(obj, field)
        if not current or not current.storage.exists(current.name):
            return 0  # nothing stored, or the file is already gone
        with current.open("rb") as fh:
            # Frames: plain resize. Customer photos: ≤200 KB, best quality.
            small = (
                optimized(fh, size, quality, name=current.name)
                if quality
                else compressed_photo(fh, size, name=current.name)
            )
        if not small or small.size >= current.size:
            return 0
        old_name, saved = current.name, current.size - small.size
        getattr(obj, field).save(small.name, small, save=False)
        transaction.on_commit(lambda storage=current.storage, name=old_name: storage.delete(name))
        return saved

    def _thumb(self, obj, source, thumb):
        src = getattr(obj, source)
        existing = getattr(obj, thumb)
        # Keep good thumbnails; rebuild ones saved as heavy PNGs earlier.
        if existing and not existing.name.endswith(".png"):
            return
        if not src or not src.storage.exists(src.name):
            return
        with src.open("rb") as fh:
            small = optimized(fh, THUMB_SIZE, 78, name=src.name)
        if small:
            if existing:
                transaction.on_commit(lambda storage=existing.storage, name=existing.name: storage.delete(name))
            getattr(obj, thumb).save(small.name, small, save=False)

    def handle(self, *args, **options):
        saved = 0
        for mirror in Mirror.objects.all():
            with transaction.atomic():
                n = self._replace(mirror, "artwork", FRAME_SIZE, 88)
                if n:
                    # update() avoids running the image optimisation twice.
                    from django.utils import timezone
                    Mirror.objects.filter(pk=mirror.pk).update(
                        artwork=mirror.artwork.name, updated_at=timezone.now()
                    )
                    saved += n
        customers = 0
        for c in Customer.objects.all().iterator():
            with transaction.atomic():
                saved += self._replace(c, "poster", POSTER_SIZE)
                saved += self._replace(c, "selfie", SELFIE_SIZE)
                self._thumb(c, "poster", "poster_thumb")
                self._thumb(c, "selfie", "selfie_thumb")
                Customer.objects.filter(pk=c.pk).update(
                    poster=c.poster.name, selfie=c.selfie.name,
                    poster_thumb=c.poster_thumb.name, selfie_thumb=c.selfie_thumb.name,
                )
            customers += 1
        self.stdout.write(self.style.SUCCESS(
            f"Optimised {customers} customers and all mirrors; saved {saved / 1024 / 1024:.1f} MB."
        ))
