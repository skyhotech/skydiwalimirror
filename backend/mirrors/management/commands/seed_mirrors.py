from pathlib import Path

from django.conf import settings
from django.core.files import File
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from mirrors.models import Mirror

ARTWORK = Path(settings.BASE_DIR).parent / "public" / "frames" / "karthigai-deepam.webp"
SLUG = "karthigai-deepam"
LEGACY_FRAMES = {
    "dream": "Dream Diwali",
    "golden": "Golden Mirror",
    "celebration": "Festive Celebration",
}


class Command(BaseCommand):
    help = "Import the built-in Karthigai Deepam mirror."

    def add_arguments(self, parser):
        parser.add_argument(
            "--hide-legacy",
            action="store_true",
            help="Hide the three original built-in mirrors after installing the Deepam mirror.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        mirror = Mirror.objects.filter(slug=SLUG).first()
        if mirror is None:
            if not ARTWORK.is_file():
                raise CommandError(f"Missing artwork: {ARTWORK}")
            order = (Mirror.objects.aggregate(last=Max("order"))["last"] or 0) + 1
            mirror = Mirror(
                slug=SLUG, name="Karthigai Deepam", order=order,
                subtitle="இனிய கார்த்திகை தீபத் திருநாள் நல்வாழ்த்துகள்!",
                accent="#a02b24", arch=False,
                selfie={"x": 174, "y": 385, "w": 732, "h": 556},
                product={"x": 264, "y": 1050, "w": 552, "h": 225},
            )
            with ARTWORK.open("rb") as artwork:
                mirror.artwork.save(ARTWORK.name, File(artwork), save=False)
            mirror.save()
            self.stdout.write(self.style.SUCCESS(f"created {mirror.slug}"))
        else:
            self.stdout.write(f"skip {SLUG} (exists)")

        if options["hide_legacy"]:
            if not mirror.is_active:
                raise CommandError("Show the Deepam mirror in the admin before hiding the original frames.")
            legacy = Q()
            for slug, name in LEGACY_FRAMES.items():
                legacy |= Q(slug=slug, name=name)
            hidden = Mirror.objects.filter(legacy, is_active=True).update(
                is_active=False, updated_at=timezone.now(),
            )
            self.stdout.write(f"hid {hidden} original mirrors")
