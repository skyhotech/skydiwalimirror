import io
import os
import sqlite3
import stat
import tarfile
import tempfile
from pathlib import Path
from unittest import skipUnless
from unittest.mock import patch

from django.core.management import call_command, CommandError
from django.db import connection
from django.test import TransactionTestCase, override_settings

from .models import Customer


@skipUnless(connection.vendor == "sqlite", "SQLite backup command; MySQL uses mysqldump")
class BackupTests(TransactionTestCase):
    def test_snapshot_can_be_restored_and_retention_keeps_a_complete_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media, backups = root / "media", root / "backups"
            media.mkdir()
            (media / "synthetic.txt").write_text("synthetic backup data")
            Customer.objects.create(session="backup-check")
            with override_settings(BACKUP_DIR=backups, MEDIA_ROOT=media, BACKUP_KEEP=1):
                call_command("backup", stdout=io.StringIO())
                call_command("backup", stdout=io.StringIO())
            self.assertEqual(len(list(backups.glob("db-*.sqlite3"))), 1)
            self.assertEqual(len(list(backups.glob("media-*.tar.gz"))), 1)
            database = next(backups.glob("db-*.sqlite3"))
            with sqlite3.connect(database) as restored:
                self.assertEqual(restored.execute("SELECT session FROM mirrors_customer").fetchall(), [("backup-check",)])
                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            with tarfile.open(next(backups.glob("media-*.tar.gz"))) as archive:
                self.assertEqual(archive.extractfile("media/synthetic.txt").read(), b"synthetic backup data")
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(database.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(backups.stat().st_mode), 0o700)
            self.assertFalse(list(backups.glob("*.tmp")))

    def test_unsafe_backup_settings_are_refused(self):
        with override_settings(BACKUP_KEEP=0), self.assertRaises(CommandError):
            call_command("backup", stdout=io.StringIO())
        with tempfile.TemporaryDirectory() as directory:
            with override_settings(MEDIA_ROOT=Path(directory), BACKUP_DIR=Path(directory) / "backups"), self.assertRaises(CommandError):
                call_command("backup", stdout=io.StringIO())

    def test_sqlite_command_refuses_mysql_before_writing_files(self):
        with patch.object(connection, "vendor", "mysql"), self.assertRaises(CommandError):
            call_command("backup", stdout=io.StringIO())
