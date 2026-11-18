"""Disposable loopback-only backend for full-stack tests. No local/live data."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
os.environ["DJANGO_SETTINGS_MODULE"] = "skymirror.test_settings"
import django
django.setup()
from django.conf import settings
from django.core.management import call_command
from django.contrib.auth.models import User

with tempfile.TemporaryDirectory(prefix="sky-integration-") as directory:
    settings.DATABASES["default"]["NAME"] = str(Path(directory) / "test.sqlite3")
    settings.DATABASES["default"]["OPTIONS"] = {
        "init_command": "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        "transaction_mode": "IMMEDIATE", "timeout": 20,
    }
    settings.MEDIA_ROOT = Path(directory) / "media"
    settings.DEBUG = True  # Django serves synthetic media on loopback only.
    settings.CORS_ALLOWED_ORIGINS = ["http://127.0.0.1:5174"]
    settings.CSRF_TRUSTED_ORIGINS = ["http://127.0.0.1:8001"]
    settings.STUDIO_URL = "http://127.0.0.1:5174"
    call_command("migrate", verbosity=0)
    call_command("seed_mirrors", verbosity=0)
    User.objects.create_user("audit-staff", password="local-test-password", is_staff=True)
    call_command("runserver", "127.0.0.1:8001", use_reloader=False)
