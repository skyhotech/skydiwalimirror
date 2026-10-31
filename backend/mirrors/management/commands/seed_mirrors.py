from pathlib import Path

from django.conf import settings
from django.core.files import File
from django.core.management.base import BaseCommand

from mirrors.models import Mirror

FRAMES = Path(settings.BASE_DIR).parent / "public" / "frames"

# Mirrors the built-in themes in src/templates/index.ts.
SEED = [
    dict(slug="dream", name="Dream Diwali", subtitle="Your SKY Dream Diwali frame",
         bg="#f7e7cc", ink="#3c2418", gold="#d6a447", accent="#d22856", light=True,
         selfie={"x": 184, "y": 165, "w": 712, "h": 950},
         product={"x": 337, "y": 1215, "w": 405, "h": 245}, file="0.jpeg"),
    dict(slug="golden", name="Golden Mirror", subtitle="Your supplied gold mirror frame",
         bg="#17120d", ink="#fff9f0", gold="#d6a447", accent="#d6a447", light=False,
         selfie={"x": 126, "y": 115, "w": 828, "h": 1215},
         product={"x": 361, "y": 1344, "w": 620, "h": 342}, file="2.jpeg"),
    dict(slug="celebration", name="Festive Celebration", subtitle="Your supplied fireworks frame",
         bg="#101426", ink="#fff9f0", gold="#e8bd62", accent="#ed1224", light=False,
         selfie={"x": 207, "y": 160, "w": 666, "h": 1040},
         product={"x": 344, "y": 1253, "w": 396, "h": 259}, file="1.jpeg"),
]


class Command(BaseCommand):
    help = "Import the studio's built-in mirror themes from public/frames."

    def handle(self, *args, **options):
        for order, spec in enumerate(SEED, start=1):
            spec = dict(spec)
            filename = spec.pop("file")
            if Mirror.objects.filter(slug=spec["slug"]).exists():
                self.stdout.write(f"skip {spec['slug']} (exists)")
                continue
            path = FRAMES / filename
            if not path.exists():
                self.stderr.write(f"missing {path}")
                continue
            mirror = Mirror(order=order, **spec)
            with path.open("rb") as fh:
                mirror.artwork.save(filename, File(fh), save=False)
            mirror.save()
            self.stdout.write(self.style.SUCCESS(f"created {mirror.slug}"))
