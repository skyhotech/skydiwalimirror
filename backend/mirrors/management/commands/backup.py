import sqlite3
import tarfile
from datetime import datetime

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = "Snapshot the database and uploaded photos to BACKUP_DIR, keeping the newest BACKUP_KEEP."

    def handle(self, *args, **options):
        out = settings.BACKUP_DIR
        out.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        db_copy = out / f"db-{stamp}.sqlite3"
        # SQLite's online backup API: a consistent copy even while kiosks write.
        connection.ensure_connection()
        dest = sqlite3.connect(db_copy)
        with dest:
            connection.connection.backup(dest)
        dest.close()
        media_copy = out / f"media-{stamp}.tar.gz"
        with tarfile.open(media_copy, "w:gz") as tar:
            if settings.MEDIA_ROOT.exists():
                tar.add(settings.MEDIA_ROOT, arcname="media")
        removed = 0
        for pattern in ("db-*.sqlite3", "media-*.tar.gz"):
            for old in sorted(out.glob(pattern), reverse=True)[settings.BACKUP_KEEP:]:
                old.unlink()
                removed += 1
        self.stdout.write(self.style.SUCCESS(
            f"Backed up to {db_copy.name} and {media_copy.name}"
            + (f" (pruned {removed} old files)" if removed else "")
        ))
