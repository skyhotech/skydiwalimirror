"""Reads the text of an invoice on the server, so Django checks what is really
printed on the bill. PDFs that hold text are read directly; image-only PDFs
and photos are enhanced, then read with Tesseract OCR."""

import io
import re
import shutil
import math
from contextlib import ExitStack

from PIL import Image, ImageFilter, ImageOps

MAX_BYTES = 15 * 1024 * 1024
# Small print reads best at about this width (≈300 dpi for an A4 bill).
OCR_WIDTH = 2400
MAX_OCR_PIXELS = 12_000_000
MAX_OCR_SIDE = 8000
OCR_PASS_TIMEOUT = 15
MIN_PDF_TEXT = 40
# Tesseract's LSTM engine, read as one block of lines (psm 6) and as sparse
# text (psm 11). Tested on photos of real SKY invoices: only together do they
# give both the line layout and the table cells.
OCR_CONFIGS = ("--oem 1 --psm 6", "--oem 1 --psm 11")


class UnreadableInvoice(Exception):
    """The file is not an image or PDF we can read."""


def ocr_available():
    return shutil.which("tesseract") is not None


def _pdf_text(data):
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n".join((page.extract_text() or "") for page in reader.pages[:2])


def _pdf_first_page(data):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    page = bitmap = None
    try:
        page = pdf[0]
        width, height = page.get_size()
        if width <= 0 or height <= 0 or not math.isfinite(width * height):
            raise UnreadableInvoice("The invoice page has invalid dimensions.")
        scale = min(300 / 72, MAX_OCR_SIDE / max(width, height), math.sqrt(MAX_OCR_PIXELS / (width * height)))
        bitmap = page.render(scale=scale)
        # The PIL image must not retain PDFium's buffer after it is closed.
        return bitmap.to_pil().copy()
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        pdf.close()


# Hand-held photos lean a few degrees; this covers it in half-degree steps.
SKEW_LIMIT, SKEW_STEP = 8, 0.5


def _row_spread(image):
    """How sharply rows alternate between ink and paper: highest when the
    text lines are exactly level."""
    rows = list(image.resize((1, image.height), Image.Resampling.BOX).getdata())
    mean = sum(rows) / len(rows)
    return sum((r - mean) ** 2 for r in rows)


def deskew(image):
    """Turns a leaning photo so its text lines are level (searches the angle
    on a small black-and-white copy, then rotates the full image once)."""
    small = image.copy()
    small.thumbnail((900, 900))
    small = _binarized(ImageOps.autocontrast(small, cutoff=1))
    steps = int(SKEW_LIMIT / SKEW_STEP)
    angle = max(
        (i * SKEW_STEP for i in range(-steps, steps + 1)),
        key=lambda a: _row_spread(small.rotate(a, resample=Image.Resampling.BILINEAR, fillcolor=255)),
    )
    if not angle:
        return image
    return image.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def enhance(image):
    """Upright, grey, level, large enough, full contrast and sharp: what OCR
    needs from a phone photo taken at an angle in shop lighting."""
    if image.width * image.height > 25_000_000:
        raise UnreadableInvoice("Invoice dimensions are too large (max 25 megapixels).")
    image = ImageOps.exif_transpose(image).convert("L")
    # Bound both total pixels and aspect ratios before rotations/upscaling.
    # A narrow receipt must never become a multi-billion-pixel image.
    scale = min(1, MAX_OCR_SIDE / max(image.size), math.sqrt(MAX_OCR_PIXELS / (image.width * image.height)))
    if scale < 1:
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    image = deskew(image)
    scale = min(OCR_WIDTH / image.width, MAX_OCR_SIDE / max(image.size), math.sqrt(MAX_OCR_PIXELS / (image.width * image.height)))
    if scale != 1:
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    image = ImageOps.autocontrast(image, cutoff=1)
    return image.filter(ImageFilter.UnsharpMask(radius=2, percent=160, threshold=3))


def _binarized(image):
    """Pure black on white: rescues faint or unevenly lit print."""
    histogram = image.histogram()
    total = sum(histogram)
    # Otsu's threshold: the split that best separates ink from paper.
    best, threshold, weight, mean_sum = 0, 128, 0, sum(i * h for i, h in enumerate(histogram))
    below = 0
    for level, count in enumerate(histogram):
        weight += count
        if not weight or weight == total:
            continue
        below += level * count
        m1, m2 = below / weight, (mean_sum - below) / (total - weight)
        between = weight * (total - weight) * (m1 - m2) ** 2
        if between > best:
            best, threshold = between, level
    return image.point(lambda p: 255 if p > threshold else 0)


def ocr_image(image):
    """Two readings combined. The block reading keeps each printed line
    together (name under Billed To, labels beside values); the sparse reading
    finds text inside table boxes, which the block reading skips on photos
    (the IMEI sits in the Particulars cell)."""
    import pytesseract

    clean = enhance(image)
    try:
        return "\n".join(
            pytesseract.image_to_string(clean, config=config, timeout=OCR_PASS_TIMEOUT) for config in OCR_CONFIGS
        )
    except RuntimeError as exc:
        if "timeout" in str(exc).lower():
            raise UnreadableInvoice("Reading the invoice took too long. Upload a clearer photo or a text PDF.") from exc
        raise
    finally:
        clean.close()


def extract_text(data, name=""):
    """All the text on an invoice file (PDF or image)."""
    if len(data) > MAX_BYTES:
        raise UnreadableInvoice("The invoice file is too large (max 15 MB).")
    is_pdf = data[:5] == b"%PDF-" or name.lower().endswith(".pdf")
    try:
        if is_pdf:
            text = _pdf_text(data)
            if len(text.strip()) >= MIN_PDF_TEXT:
                return text
            with _pdf_first_page(data) as image:
                return ocr_image(image)
        with Image.open(io.BytesIO(data)) as image:
            return ocr_image(image)
    except UnreadableInvoice:
        raise
    except Exception as exc:  # corrupt or unsupported file
        raise UnreadableInvoice("We couldn't read this invoice. Please upload a clear photo or the PDF.") from exc


# The dashboard already displays invoices as images. Re-encode uploads as a
# private JPEG proof, stripping PDF actions, image metadata and attachments.
INVOICE_PROOF_LIMIT = 200_000


def invoice_preview(data):
    """Return a readable first-page preview strictly below 200 KB."""
    try:
        if data.startswith(b"%PDF-"):
            with _pdf_first_page(data) as source:
                image = source.convert("L")
        else:
            with Image.open(io.BytesIO(data)) as source:
                if source.width * source.height > 25_000_000:
                    raise UnreadableInvoice("Invoice dimensions are too large.")
                image = ImageOps.exif_transpose(source).convert("L")
        with image:
            image.thumbnail((1800, 2500), Image.Resampling.LANCZOS)
            for bounds in ((1800, 2500), (1440, 2000), (1152, 1600), (900, 1250)):
                image.thumbnail(bounds, Image.Resampling.LANCZOS)
                for quality in (85, 72, 58, 45):
                    with io.BytesIO() as output:
                        image.save(output, "JPEG", quality=quality, optimize=True)
                        if output.tell() < INVOICE_PROOF_LIMIT:
                            return output.getvalue()
    except (OSError, ValueError) as exc:
        raise UnreadableInvoice("A preview could not be made from this invoice.") from exc
    raise UnreadableInvoice("The invoice preview could not be compressed below 200 KB.")



def invoice_pdf(data):
    """Create an inert, size-limited PDF with every uploaded page."""
    try:
        with ExitStack() as stack:
            if data.startswith(b"%PDF-"):
                import pypdfium2 as pdfium

                document = pdfium.PdfDocument(data)
                stack.callback(document.close)
                if not 1 <= len(document) <= 8:
                    raise UnreadableInvoice("Upload an invoice PDF with one to eight pages.")
                pages = []
                for index in range(len(document)):
                    page = document[index]
                    try:
                        width, height = page.get_size()
                        if width <= 0 or height <= 0 or not math.isfinite(width * height):
                            raise UnreadableInvoice("The invoice page has invalid dimensions.")
                        bitmap = page.render(scale=min(150 / 72, 1600 / max(width, height)))
                        try:
                            pages.append(stack.enter_context(bitmap.to_pil().convert("L")))
                        finally:
                            bitmap.close()
                    finally:
                        page.close()
            else:
                image = stack.enter_context(Image.open(io.BytesIO(data)))
                if image.width * image.height > 25_000_000:
                    raise UnreadableInvoice("Invoice dimensions are too large.")
                pages = [stack.enter_context(ImageOps.exif_transpose(image).convert("L"))]
            for bounds, quality in ((1600, 82), (1350, 72), (1150, 60), (950, 50), (800, 42)):
                for page in pages:
                    page.thumbnail((bounds, bounds), Image.Resampling.LANCZOS)
                with io.BytesIO() as output:
                    pages[0].save(output, "PDF", save_all=True, append_images=pages[1:], quality=quality)
                    if output.tell() < INVOICE_PROOF_LIMIT:
                        return output.getvalue()
    except UnreadableInvoice:
        raise
    except Exception as exc:
        raise UnreadableInvoice("A PDF could not be made from this invoice.") from exc
    raise UnreadableInvoice("This invoice could not fit under 200 KB. Upload a clearer PDF.")

_PREFIX = re.compile(r"^(?:S[1Il|!]|5[Il|!1]|5I)(?=\d{4})")


def normalize_invoice_number(value):
    """SKY invoice numbers start "SI" + the year pair (SI2627…); scans often
    read that "I" as "1" (S12627…). Fixes only that well-known slip."""
    value = re.sub(r"\s+", "", value.strip().upper())
    return _PREFIX.sub("SI", value)
