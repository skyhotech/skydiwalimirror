import io

from django.core.files.base import ContentFile
from django.test import SimpleTestCase
from PIL import Image

from .images import compressed_photo, optimized, PHOTO_TARGET_BYTES, SELFIE_SIZE


class ImageProcessingTests(SimpleTestCase):
    def test_small_encoded_file_still_obeys_decoded_dimension_limit(self):
        out = io.BytesIO()
        Image.new("RGB", (2000, 2000), "orange").save(out, "JPEG", quality=70)
        file = ContentFile(out.getvalue(), name="small-but-large.jpg")
        self.assertLess(file.size, PHOTO_TARGET_BYTES)
        result = compressed_photo(file, SELFIE_SIZE)
        self.assertIsNotNone(result)
        with Image.open(result) as image:
            self.assertLessEqual(image.width, SELFIE_SIZE[0])
            self.assertLessEqual(image.height, SELFIE_SIZE[1])

    def test_exif_rotation_is_applied_and_orientation_removed(self):
        out = io.BytesIO()
        image = Image.new("RGB", (200, 100), "red")
        exif = image.getexif(); exif[274] = 6
        image.save(out, "JPEG", exif=exif)
        result = optimized(ContentFile(out.getvalue(), name="rotated.jpg"), (200, 200))
        with Image.open(result) as decoded:
            self.assertEqual(decoded.size, (100, 200))
            self.assertIsNone(decoded.getexif().get(274))

    def test_detailed_photo_fits_byte_budget_and_decodes(self):
        out = io.BytesIO()
        Image.effect_noise((1100, 1600), 100).convert("RGB").save(out, "JPEG", quality=98)
        result = compressed_photo(ContentFile(out.getvalue(), name="noise.jpg"), (1080, 1920))
        self.assertIsNotNone(result)
        self.assertLessEqual(result.size, PHOTO_TARGET_BYTES)
        with Image.open(result) as image:
            image.load()
            self.assertGreater(image.width, 0)
            self.assertLessEqual(image.width, 1080)

    def test_transparency_is_preserved_for_frame_artwork(self):
        out = io.BytesIO()
        Image.new("RGBA", (100, 100), (255, 0, 0, 0)).save(out, "PNG")
        result = optimized(ContentFile(out.getvalue(), name="frame.png"), (50, 50))
        with Image.open(result) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.getchannel("A").getextrema(), (0, 0))

    def test_artwork_dimension_budget_takes_priority_over_encoded_byte_savings(self):
        out = io.BytesIO()
        Image.new("RGB", (400, 400), "orange").save(out, "PNG", optimize=True)
        original = ContentFile(out.getvalue(), name="large.png")
        # A uniform PNG compresses better than JPEG even though its decoded
        # dimensions exceed the target. The pixel budget must still win.
        result = optimized(original, (399, 399), only_if_smaller=True)
        self.assertIsNotNone(result)
        with Image.open(result) as image:
            self.assertEqual(image.size, (399, 399))
