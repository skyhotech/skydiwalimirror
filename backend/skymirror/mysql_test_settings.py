"""Disposable MySQL test database; credentials never use production variables."""
import os
from .test_settings import *  # noqa: F403

DATABASES = {"default": {
    "ENGINE": "django.db.backends.mysql",
    "NAME": "sky_test_base",
    "USER": os.environ.get("MYSQL_TEST_USER", "root"),
    "PASSWORD": os.environ.get("MYSQL_TEST_PASSWORD", "local-tests-only"),
    "HOST": "127.0.0.1",
    "PORT": os.environ.get("MYSQL_TEST_PORT", "3307"),
    "OPTIONS": {"charset": "utf8mb4", "init_command": "SET sql_mode='STRICT_TRANS_TABLES'"},
    "TEST": {"NAME": "test_sky_disposable"},
}}
