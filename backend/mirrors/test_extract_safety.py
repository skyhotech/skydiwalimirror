import math
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase
from PIL import Image

from .extract import MAX_OCR_PIXELS, MAX_OCR_SIDE, UnreadableInvoice, _pdf_first_page, enhance, ocr_image


class InvoiceSafetyTests(SimpleTestCase):
    def test_skinny_photo_cannot_explode_when_enlarged_for_ocr(self):
        with Image.new("RGB", (1, 20000), "white") as source:
            result = enhance(source)
        try:
            self.assertLessEqual(result.width * result.height, MAX_OCR_PIXELS)
            self.assertLessEqual(max(result.size), MAX_OCR_SIDE)
            self.assertGreaterEqual(min(result.size), 1)
        finally:
            result.close()

    def test_large_pdf_page_is_bounded_and_native_resources_are_closed(self):
        image = Image.new("RGB", (2, 2), "orange")
        bitmap = Mock()
        bitmap.to_pil.return_value = image
        page = Mock()
        page.get_size.return_value = (100000, 100000)
        page.render.return_value = bitmap
        pdf = Mock()
        pdf.__getitem__ = Mock(return_value=page)
        fake = SimpleNamespace(PdfDocument=Mock(return_value=pdf))
        with patch.dict("sys.modules", {"pypdfium2": fake}):
            result = _pdf_first_page(b"synthetic")
        try:
            scale = page.render.call_args.kwargs["scale"]
            self.assertLessEqual(100000 * scale, MAX_OCR_SIDE)
            self.assertLessEqual((100000 * scale) ** 2, MAX_OCR_PIXELS + 1)
            bitmap.close.assert_called_once()
            page.close.assert_called_once()
            pdf.close.assert_called_once()
            self.assertEqual(result.getpixel((0, 0)), (255, 165, 0))
        finally:
            image.close()
            result.close()

    def test_pdf_resources_close_when_rendering_fails(self):
        page = Mock()
        page.get_size.return_value = (595, 842)
        page.render.side_effect = ValueError("injected render failure")
        pdf = Mock()
        pdf.__getitem__ = Mock(return_value=page)
        with patch.dict("sys.modules", {"pypdfium2": SimpleNamespace(PdfDocument=Mock(return_value=pdf))}):
            with self.assertRaises(ValueError):
                _pdf_first_page(b"synthetic")
        page.close.assert_called_once()
        pdf.close.assert_called_once()

    def test_invalid_pdf_dimensions_are_rejected_before_render(self):
        page = Mock()
        page.get_size.return_value = (math.inf, 842)
        pdf = Mock()
        pdf.__getitem__ = Mock(return_value=page)
        with patch.dict("sys.modules", {"pypdfium2": SimpleNamespace(PdfDocument=Mock(return_value=pdf))}):
            with self.assertRaises(UnreadableInvoice):
                _pdf_first_page(b"synthetic")
        page.render.assert_not_called()
        page.close.assert_called_once()
        pdf.close.assert_called_once()

    def test_ocr_timeout_is_bounded_and_explained(self):
        clean = Image.new("L", (10, 10), "white")
        with patch("mirrors.extract.enhance", return_value=clean), patch("pytesseract.image_to_string", side_effect=RuntimeError("Tesseract process timeout")) as engine:
            with self.assertRaisesRegex(UnreadableInvoice, "took too long"):
                ocr_image(clean)
        self.assertEqual(engine.call_args.kwargs["timeout"], 15)
        with self.assertRaises(ValueError):
            clean.getpixel((0, 0))
