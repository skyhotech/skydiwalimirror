import csv
import io
import tempfile
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, IntegrityError, transaction
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from PIL import Image
from rest_framework.test import APIRequestFactory

from .models import Customer, validate_rect
from .throttles import MirrorPollThrottle


def photo():
    out = io.BytesIO()
    Image.new("RGB", (100, 120), "orange").save(out, "JPEG")
    return SimpleUploadedFile("photo.jpg", out.getvalue(), content_type="image/jpeg")


class ReliabilityTests(TestCase):
    def setUp(self):
        self.media = tempfile.TemporaryDirectory()
        self.addCleanup(self.media.cleanup)
        self.settings_override = override_settings(MEDIA_ROOT=self.media.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        cache.clear()
        repeat = patch("mirrors.throttles.RepeatThrottle.get_rate", return_value=None)
        repeat.start()
        self.addCleanup(repeat.stop)
        self.staff = User.objects.create_user("staff", is_staff=True)

    def upload(self, **fields):
        return self.client.post("/api/customers/", {"session": "test-session", "poster": photo(), **fields})

    def test_upload_cannot_assign_a_prize(self):
        response = self.upload(reward="power-bank")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Customer.objects.get(session="test-session").reward, "")

    def test_poster_only_update_keeps_selfie_thumbnail(self):
        self.assertEqual(self.upload(selfie=photo()).status_code, 201)
        customer = Customer.objects.get(session="test-session")
        thumb = customer.selfie_thumb.name
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.upload().status_code, 200)
        customer.refresh_from_db()
        self.assertEqual(customer.selfie_thumb.name, thumb)
        self.assertTrue(customer.selfie_thumb.storage.exists(thumb))

    def test_csv_does_not_execute_customer_formula(self):
        Customer.objects.create(session="formula", name='=HYPERLINK("https://example.invalid")')
        self.client.force_login(self.staff)
        response = self.client.get("/api/admin/customers/export/")
        self.assertTrue(response.streaming)
        rows = list(csv.reader(io.StringIO(b"".join(response.streaming_content).decode())))
        self.assertTrue(rows[1][2].startswith("'="))

    def test_csv_export_is_incremental_and_keeps_requested_filter(self):
        Customer.objects.create(session="one", name="Include")
        Customer.objects.create(session="two", name="Other")
        self.client.force_login(self.staff)
        response = self.client.get("/api/admin/customers/export/?q=Include")
        self.assertTrue(response.streaming)
        chunks = iter(response.streaming_content)
        self.assertIn(b"poster_url", next(chunks))
        rows = list(csv.reader(io.StringIO(b"".join(chunks).decode())))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][2], "Include")

    def test_malformed_filters_are_client_errors(self):
        self.client.force_login(self.staff)
        for path in ("customers/?branch=bad", "customers/?mirror=bad", "customers/export/?branch=bad"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get("/api/admin/" + path).status_code, 400)

    def test_reorder_validates_ids(self):
        self.client.force_login(self.staff)
        for ids in (["bad"], [1, 1], [True], [1.5]):
            with self.subTest(ids=ids):
                self.assertEqual(self.client.post("/api/admin/mirrors/reorder/", {"ids": ids}, content_type="application/json").status_code, 400)

    def test_customer_list_query_count_does_not_grow_with_repeat_faces(self):
        original = Customer.objects.create(session="original", phone="9845011111")
        self.client.force_login(self.staff)
        Customer.objects.create(session="first", repeat_of=original)
        with CaptureQueriesContext(connection) as first:
            self.client.get("/api/admin/customers/")
        for i in range(6):
            Customer.objects.create(session=f"repeat-{i}", repeat_of=original)
        with CaptureQueriesContext(connection) as second:
            self.client.get("/api/admin/customers/")
        self.assertEqual(len(first), len(second))

    def test_untrusted_forwarded_header_does_not_change_throttle_identity(self):
        # Exercise the configured default, rather than overriding NUM_PROXIES.
        factory = APIRequestFactory()
        a = factory.get("/", REMOTE_ADDR="127.0.0.1", HTTP_X_FORWARDED_FOR="1.2.3.4")
        b = factory.get("/", REMOTE_ADDR="127.0.0.1", HTTP_X_FORWARDED_FOR="5.6.7.8")
        self.assertEqual(MirrorPollThrottle().get_ident(a), MirrorPollThrottle().get_ident(b))

    def test_locked_login_does_not_check_password_again(self):
        cache.set("login-fail:ip:127.0.0.1", 5)
        with patch("django.contrib.auth.forms.authenticate") as authenticate:
            self.client.post("/sky/mirror/admin/login/", {"username": "staff", "password": "wrong"})
        authenticate.assert_not_called()

    def test_duplicate_registered_phone_is_rejected_but_anonymous_customers_are_allowed(self):
        Customer.objects.create(session="one", phone="9845011111")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Customer.objects.create(session="two", phone="9845011111")
        Customer.objects.create(session="anonymous-one")
        Customer.objects.create(session="anonymous-two")
        self.assertEqual(Customer.objects.filter(phone__isnull=True).count(), 2)

    def test_upload_with_phone_requires_recorded_consent(self):
        self.assertEqual(self.upload(phone="9845011111").status_code, 400)
        self.assertFalse(Customer.objects.exists())

    def test_invalid_image_is_rejected_without_creating_customer(self):
        response = self.client.post("/api/customers/", {"session": "bad", "poster": SimpleUploadedFile("bad.jpg", b"not an image", content_type="image/jpeg")})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Customer.objects.exists())

    def test_gif_and_excessive_pixel_dimensions_are_rejected(self):
        out = io.BytesIO()
        Image.new("RGB", (20, 20)).save(out, "GIF")
        response = self.client.post("/api/customers/", {"session": "bad", "poster": SimpleUploadedFile("bad.gif", out.getvalue(), content_type="image/gif")})
        self.assertEqual(response.status_code, 400)
        from types import SimpleNamespace
        from rest_framework.exceptions import ValidationError
        from .serializers import _limit_size
        with self.assertRaises(ValidationError):
            _limit_size(SimpleNamespace(size=100, image=SimpleNamespace(format="PNG", width=5001, height=5001)))
        with self.assertRaises(ValidationError):
            _limit_size(SimpleNamespace(size=12 * 1024 * 1024 + 1))

    def test_rect_rejects_fractional_nonfinite_and_boolean_values(self):
        from django.core.exceptions import ValidationError
        for value in (True, 1.2, float("inf"), float("nan")):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_rect({"x": value, "y": 0, "w": 200, "h": 200})

    def test_diagnostics_correlate_requests_without_customer_data(self):
        response = self.client.get("/api/mirrors/version/", {"phone": "9845011111"})
        self.assertRegex(response["X-Request-ID"], r"^[a-f0-9]{32}$")
        self.assertEqual(response["X-Route-Name"], "public-mirrors-version")
        self.assertRegex(response["Server-Timing"], r"^app;dur=[0-9.]+$")

    def test_customer_photos_require_staff_and_are_not_cacheable(self):
        self.upload(selfie=photo())
        customer = Customer.objects.get(session="test-session")
        url = customer.selfie.url
        response = self.client.get(url)
        self.assertEqual(response.status_code, 403)
        self.assertIn("no-store", response["Cache-Control"])
        self.client.force_login(self.staff)
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/jpeg")
        self.assertTrue(b"".join(response.streaming_content).startswith(b"\xff\xd8"))
        self.assertIn("private", response["Cache-Control"])
        missing = self.client.get("/media/customers/missing.jpg")
        self.assertEqual(missing.status_code, 404)

    def test_stats_days_and_total_counts_keep_their_meaning(self):
        from datetime import timedelta
        from django.utils import timezone
        from .views import _customer_stats
        today = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
        old = Customer.objects.create(session="old", reward="smart-watch")
        Customer.objects.filter(pk=old.pk).update(created_at=today - timedelta(days=2))
        Customer.objects.create(session="today", repeat_of=old)
        with CaptureQueriesContext(connection) as queries:
            stats = _customer_stats(Customer.objects.all())
        self.assertEqual(len(queries), 7)
        self.assertEqual((stats["customers"], stats["customers_today"], stats["gifts"], stats["repeat_faces"]), (2, 1, 1, 1))
        self.assertEqual([row["count"] for row in stats["per_day"]], [0, 0, 0, 0, 1, 0, 1])

    def test_media_optimization_database_failure_keeps_original(self):
        from django.core.management import call_command
        out = io.BytesIO()
        Image.new("RGB", (2000, 2000), "orange").save(out, "JPEG")
        customer = Customer.objects.create(session="optimize", poster=SimpleUploadedFile("large.jpg", out.getvalue(), content_type="image/jpeg"))
        old_name, storage = customer.poster.name, customer.poster.storage
        with self.assertRaises(RuntimeError), patch("django.db.models.query.QuerySet.update", side_effect=RuntimeError("Injected database failure")):
            call_command("optimize_media", stdout=io.StringIO())
        customer.refresh_from_db()
        self.assertEqual(customer.poster.name, old_name)
        self.assertTrue(storage.exists(old_name))

    def test_failed_customer_deletion_keeps_original_images(self):
        self.upload(selfie=photo())
        customer = Customer.objects.get(session="test-session")
        name, storage = customer.poster.name, customer.poster.storage
        self.client.force_login(self.staff)
        with self.assertRaises(RuntimeError), patch.object(Customer, "delete", side_effect=RuntimeError("Injected database failure")):
            self.client.delete(f"/api/admin/customers/{customer.pk}/")
        self.assertTrue(storage.exists(name))
        self.assertTrue(Customer.objects.filter(pk=customer.pk).exists())

    def test_truncated_photo_is_rejected_instead_of_stored(self):
        raw = photo().read()[:-40]
        response = self.client.post("/api/customers/", {"session": "truncated", "poster": SimpleUploadedFile("damaged.jpg", raw, content_type="image/jpeg")})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Customer.objects.filter(session="truncated").exists())

    def test_phone_numbers_use_ascii_digits_consistently_with_frontend(self):
        from .serializers import CustomerIntakeSerializer
        serializer = CustomerIntakeSerializer(data={"phone": "9८४५०१२३४५"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("phone", serializer.errors)
        response = self.client.post("/api/customers/register/", {"phone": "9८४५०१२३४५", "consent": True}, content_type="application/json")
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Customer.objects.exists())

    def test_customer_image_urls_keep_staff_session_on_dashboard_origin(self):
        self.upload(selfie=photo())
        self.client.force_login(self.staff)
        response = self.client.get("/api/admin/customers/")
        row = response.json()["results"][0]
        for field in ("selfie", "poster", "selfie_thumb", "poster_thumb"):
            self.assertTrue(row[field].startswith("/media/customers/"))

    def test_staff_json_and_dashboard_are_not_cacheable(self):
        self.client.force_login(self.staff)
        for path in ("/api/admin/customers/", "/sky/mirror/admin/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("private", response["Cache-Control"])
                self.assertIn("no-store", response["Cache-Control"])
