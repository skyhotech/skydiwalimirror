import sqlite3
import tarfile
from datetime import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection


class Command(BaseCommand):
    help = "Snapshot the database and uploaded photos to BACKUP_DIR, keeping the newest BACKUP_KEEP."

    def handle(self, *args, **options):
        if connection.vendor != "sqlite":
            raise CommandError("This command backs up SQLite only. Use the MySQL dump/media backup procedure for MySQL.")
        if settings.BACKUP_KEEP < 1:
            raise CommandError("BACKUP_KEEP must be at least 1; refusing to delete all backups.")
        out = settings.BACKUP_DIR
        if out.resolve().is_relative_to(settings.MEDIA_ROOT.resolve()):
            raise CommandError("BACKUP_DIR must be outside MEDIA_ROOT.")
        out.mkdir(parents=True, exist_ok=True, mode=0o700)
        out.chmod(0o700)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        db_copy = out / f"db-{stamp}.sqlite3"
        db_temp = db_copy.with_suffix(".sqlite3.tmp")
        # SQLite's online backup API: a consistent copy even while kiosks write.
        connection.ensure_connection()
        media_copy = out / f"media-{stamp}.tar.gz"
        media_temp = media_copy.with_suffix(".gz.tmp")
        try:
            dest = sqlite3.connect(db_temp)
            try:
                with dest:
                    connection.connection.backup(dest)
            finally:
                dest.close()
            db_temp.chmod(0o600)
            with tarfile.open(media_temp, "w:gz") as tar:
                if settings.MEDIA_ROOT.exists():
                    tar.add(settings.MEDIA_ROOT, arcname="media")
            media_temp.chmod(0o600)
            db_temp.replace(db_copy)
            media_temp.replace(media_copy)
        finally:
            db_temp.unlink(missing_ok=True)
            media_temp.unlink(missing_ok=True)
        removed = 0
        for pattern in ("db-*.sqlite3", "media-*.tar.gz"):
            for old in sorted(out.glob(pattern), reverse=True)[settings.BACKUP_KEEP:]:
                old.unlink()
                removed += 1
        self.stdout.write(self.style.SUCCESS(
            f"Backed up to {db_copy.name} and {media_copy.name}"
            + (f" (pruned {removed} old files)" if removed else "")
        ))
