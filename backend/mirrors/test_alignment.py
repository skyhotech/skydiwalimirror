import io
import tempfile
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image

from .models import Customer


def photo():
    stream = io.BytesIO()
    Image.new("RGB", (100, 120), "orange").save(stream, "JPEG")
    return SimpleUploadedFile("photo.jpg", stream.getvalue(), content_type="image/jpeg")


class AlignmentSafetyTests(TestCase):
    def setUp(self):
        media = tempfile.TemporaryDirectory()
        self.addCleanup(media.cleanup)
        config = override_settings(MEDIA_ROOT=media.name)
        config.enable()
        self.addCleanup(config.disable)
        cache.clear()
        guard = patch("mirrors.throttles.RepeatThrottle.get_rate", return_value=None)
        guard.start()
        self.addCleanup(guard.stop)
        self.customer = Customer.objects.create(session="secure-customer", phone="9845011111", spin_token="private-link", consent_at=timezone.now(), reward="power-bank")

    def upload(self, token=None):
        body = {"phone": self.customer.phone, "session": self.customer.session, "poster": photo()}
        if token is not None:
            body["token"] = token
        return self.client.post("/api/customers/", body)

    def test_upload_requires_customer_bound_link_authority(self):
        for token, status in ((None, 503), ("wrong-link", 400)):
            with self.subTest(token=token):
                self.assertEqual(self.upload(token).status_code, status)
        self.assertEqual(self.upload("private-link").status_code, 200)
        self.customer.refresh_from_db()
        self.assertTrue(self.customer.poster)
        self.assertEqual(self.customer.reward, "power-bank")

    def test_private_image_is_available_only_to_owner_or_staff(self):
        self.assertEqual(self.upload("private-link").status_code, 200)
        self.customer.refresh_from_db()
        url = self.customer.poster.url
        self.assertEqual(self.client.get(url).status_code, 403)
        self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION="Bearer wrong-link").status_code, 403)
        owner = self.client.get(url, HTTP_AUTHORIZATION="Bearer private-link")
        self.assertEqual(owner.status_code, 200)
        self.assertIn("no-store", owner["Cache-Control"])
        self.assertTrue(b"".join(owner.streaming_content))
        second = Customer.objects.create(session="other", phone="9845022223", spin_token="other-link")
        self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION=f"Bearer {second.spin_token}").status_code, 403)
        self.client.force_login(User.objects.create_user("proof-staff", is_staff=True))
        staff = self.client.get(url)
        self.assertEqual(staff.status_code, 200)
        self.assertTrue(b"".join(staff.streaming_content))

    def test_terms_and_audit_event_roll_back_together(self):
        self.client.raise_request_exception = False
        with patch("mirrors.views._log", side_effect=RuntimeError("injected audit failure")):
            response = self.client.post("/api/customers/terms/", {"token": "private-link", "accept": True}, content_type="application/json")
        self.assertEqual(response.status_code, 500)
        self.customer.refresh_from_db()
        self.assertIsNone(self.customer.terms_accepted_at)
        self.assertFalse(self.customer.events.exists())

    def test_review_and_audit_event_roll_back_together(self):
        self.client.raise_request_exception = False
        with patch("mirrors.views._log", side_effect=RuntimeError("injected audit failure")):
            response = self.client.post("/api/customers/review/", {"token": "private-link", "rating": 5, "review": "Synthetic"}, content_type="application/json")
        self.assertEqual(response.status_code, 500)
        self.customer.refresh_from_db()
        self.assertIsNone(self.customer.rating)
        self.assertEqual(self.customer.review, "")

    def test_proof_status_and_event_roll_back_without_removing_old_file(self):
        self.customer.whatsapp_proof.save("original.jpg", photo(), save=False)
        self.customer.whatsapp_proof_status = "verified"
        self.customer.save()
        old_name = self.customer.whatsapp_proof.name
        storage = self.customer.whatsapp_proof.storage
        self.client.raise_request_exception = False
        with patch("mirrors.views._log", side_effect=RuntimeError("injected audit failure")):
            response = self.client.post("/api/customers/whatsapp-proof/", {"token": "private-link", "screenshot": photo()})
        self.assertEqual(response.status_code, 500)
        self.customer.refresh_from_db()
        self.assertEqual(self.customer.whatsapp_proof.name, old_name)
        self.assertEqual(self.customer.whatsapp_proof_status, "verified")
        self.assertTrue(storage.exists(old_name))

    def test_platform_lists_include_facebook_and_other_apps(self):
        from .models import CustomerEvent
        CustomerEvent.objects.create(customer=self.customer, kind="share_opened_more")
        CustomerEvent.objects.create(customer=self.customer, kind="shared_facebook")
        self.client.force_login(User.objects.create_user("sharing-staff", is_staff=True))
        more = self.client.get("/api/admin/sharers/more/").json()["results"][0]
        self.assertEqual((more["shares"], more["opened"]), (0, 1))
        self.assertIn("spin=private-link", more["customer_link"])
        facebook = self.client.get("/api/admin/sharers/facebook/").json()["results"][0]
        self.assertEqual(facebook["screenshot"], "")
        self.assertEqual(facebook["screenshot_status"], "")

    def test_postal_text_is_not_mistaken_for_a_media_url(self):
        from .serializers import _local_images
        data = {"review": "See https://example.test/media/review", "poster": "https://api.test/media/customers/poster.jpg"}
        result = _local_images(data)
        self.assertEqual(result["review"], data["review"])
        self.assertEqual(result["poster"], "/media/customers/poster.jpg")

    def test_poster_save_and_event_roll_back_together(self):
        self.client.raise_request_exception = False
        with patch("mirrors.views._log", side_effect=RuntimeError("injected audit failure")):
            response = self.upload("private-link")
        self.assertEqual(response.status_code, 500)
        self.customer.refresh_from_db()
        self.assertFalse(self.customer.poster)
