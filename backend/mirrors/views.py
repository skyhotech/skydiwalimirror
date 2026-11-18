import json
import secrets
import threading
import time
from datetime import timedelta
from uuid import uuid4

from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth.views import LoginView
from django.db import IntegrityError, close_old_connections, transaction
from django.core.cache import cache
from django.http import FileResponse, HttpResponse, JsonResponse, StreamingHttpResponse
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.views.decorators.http import require_safe
import re
from django.db.models import Avg, Count, Max, Q, Sum
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .images import POSTER_SIZE, SELFIE_SIZE, THUMB_SIZE, compressed_photo, optimized
from .serializers import MAX_UPLOAD_BYTES
from .models import Branch, Customer, CustomerEvent, Mirror, SpinItem
from .serializers import (
    BranchSerializer,
    PublicBranchSerializer,
    branch_link,
    spin_link,
    ApprovalSerializer,
    reward_progress,
    CustomerDetailSerializer,
    CustomerEventSerializer,
    CustomerIntakeSerializer,
    EventSerializer,
    ProfileSerializer,
    ReviewSerializer,
    TermsSerializer,
    SpinItemSerializer,
    wheel_items,
    CustomerSerializer,
    CustomerUploadSerializer,
    SpinSerializer,
    MirrorSerializer,
    PublicMirrorSerializer,
)
from .throttles import (
    client_ip,
    CustomerRegisterThrottle,
    CustomerSpinThrottle,
    ManagerThrottle,
    RepeatThrottle,
    CustomerUploadThrottle,
    MirrorPollThrottle,
    MirrorVersionThrottle,
)

# Photo compression is CPU-bound; one at a time per server process.
_IMAGE_WORK = threading.BoundedSemaphore(1)
IMAGE_WAIT_SECONDS = 25

NO_TERMS = "Please accept the terms and conditions first."
NO_GIFTS = "Gifts aren't set up yet. Please ask the SKY team."
_DRAW = secrets.SystemRandom()
INVALID_LINK = "This gift link isn't valid. Please ask the SKY team for a new one."

INACTIVE_BRANCH = (
    "This store link is no longer active. Please ask the SKY team for the current QR code."
)


def _link_unsent(customers):
    """Abandoned after passing: checked, but the WhatsApp link never went out."""
    return customers.filter(spin_token__isnull=False).exclude(events__kind="whatsapp_sent")


def _failed_attempts():
    """Abandoned at the check: each number's latest refusal, dropped as soon as
    that number passes or an admin approves or dismisses it."""
    # NOT IN with a NULL in the list matches nothing, so leave NULLs out.
    passed = Customer.objects.filter(spin_token__isnull=False, phone__isnull=False).values("phone")
    rows, seen = [], set()
    failed = CustomerEvent.objects.filter(kind="check_failed").exclude(phone__in=passed)
    for event in failed.order_by("-created_at"):
        if event.detail.get("resolved"):
            seen.add(event.phone)
            continue
        if not event.phone or event.phone not in seen:
            seen.add(event.phone)
            rows.append(event)
    return rows


def _branch(slug, strict=True):
    """The branch a studio link points at; None without one. A link to an
    unknown or switched-off branch is refused rather than filed nowhere,
    except for uploads already queued on a phone (strict=False), which must
    never be lost because a branch was switched off meanwhile."""
    if not slug:
        return None
    if not strict:
        return Branch.objects.filter(slug=slug).first()
    branch = Branch.objects.filter(slug=slug, is_active=True).first()
    if branch is None:
        raise ValidationError({"branch": [INACTIVE_BRANCH]})
    return branch


def _log(customer, kind, **detail):
    CustomerEvent.objects.create(
        customer=customer, phone=customer.phone or "", kind=kind, detail=detail
    )


def _file_under(customer, branch):
    """Files a customer under the branch whose link they used, once: the store
    where they first came in keeps them. Returns the fields that changed."""
    if branch is None or customer.branch_id:
        return []
    customer.branch, customer.branch_name = branch, branch.name
    return ["branch", "branch_name"]



# --- Public API used by the selfie studio ---------------------------------


_MIRROR_LIST_KEY = "mirrors_list_data"
_MIRROR_LIST_TTL = 5  # seconds; aligns with mirrors_version polling window


def _mirror_list_data(request):
    cached = cache.get(_MIRROR_LIST_KEY)
    if cached is not None:
        return cached
    data = PublicMirrorSerializer(
        Mirror.objects.filter(is_active=True), many=True, context={"request": request}
    ).data
    cache.set(_MIRROR_LIST_KEY, data, _MIRROR_LIST_TTL)
    return data


class PublicMirrorList(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MirrorPollThrottle]

    def get(self, request):
        return Response(_mirror_list_data(request))


class PublicMirrorVersion(APIView):
    """Tiny fingerprint of the active theme list; the studio polls it every second."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MirrorVersionThrottle]

    def get(self, request):
        return Response({"version": mirrors_version()})


def mirrors_version():
    # Every open studio asks once a second; a 5 s cache saves the DB query.
    from django.core.cache import cache
    cached = cache.get("mirrors_version")
    if cached:
        return cached
    version = _mirrors_version_uncached()
    cache.set("mirrors_version", version, 5)
    return version


def _mirrors_version_uncached():
    agg = Mirror.objects.aggregate(updated=Max("updated_at"), n=Count("id"))
    updated = agg["updated"].timestamp() if agg["updated"] else 0
    # Count catches deletes, which leave no newer updated_at behind.
    return f"{updated:.6f}-{agg['n']}"


# Server-sent events: the studio holds this connection open and receives the
# full theme list the moment an admin saves. Plain Django, no extra services.
STREAM_CHECK_SECONDS = 0.3
STREAM_HEARTBEAT_SECONDS = 15
# Connections are recycled so a threaded dev server never pins workers forever;
# EventSource reconnects automatically.
STREAM_LIFETIME_SECONDS = 300


MAX_STREAMS_PER_IP = 20


def mirror_stream(request):
    # Each open stream holds a worker thread; cap them per network.
    ip = client_ip(request)
    key = f"mirror-streams:{ip}"
    cache.add(key, 0, timeout=STREAM_LIFETIME_SECONDS + 60)
    if cache.incr(key) > MAX_STREAMS_PER_IP:
        cache.decr(key)
        return JsonResponse({"detail": "Too many live connections."}, status=429)

    def events():
        last, last_beat, started = None, time.monotonic(), time.monotonic()
        yield "retry: 1000\n\n"
        try:
            while time.monotonic() - started < STREAM_LIFETIME_SECONDS:
                version = mirrors_version()
                if version != last:
                    last = version
                    data = PublicMirrorSerializer(
                        Mirror.objects.filter(is_active=True), many=True,
                        context={"request": request},
                    ).data
                    yield f"event: mirrors\ndata: {json.dumps(data)}\n\n"
                    last_beat = time.monotonic()
                elif time.monotonic() - last_beat > STREAM_HEARTBEAT_SECONDS:
                    yield ": ping\n\n"
                    last_beat = time.monotonic()
                close_old_connections()
                time.sleep(STREAM_CHECK_SECONDS)
        finally:
            close_old_connections()
            try:
                cache.decr(key)
            except ValueError:
                pass

    response = StreamingHttpResponse(events(), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"  # stop nginx from buffering events
    return response


class CustomerRegister(APIView):
    """Sign-in by mobile number. Returns the customer's prize if already spun."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerRegisterThrottle, RepeatThrottle]

    def post(self, request):
        from .serializers import RegisterSerializer
        ser = RegisterSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        phone = ser.validated_data["phone"]
        branch = _branch(ser.validated_data.get("branch"))
        customer, created = Customer.objects.get_or_create(
            phone=phone, defaults={"session": f"phone-{phone}"}
        )
        changed = _file_under(customer, branch)
        if not customer.consent_at:
            customer.consent_at = timezone.now()
            changed.append("consent_at")
        if changed:
            customer.save(update_fields=[*changed, "updated_at"])
        return Response(
            {"phone": phone, "reward": customer.reward or None, "returning": not created},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class CustomerUpload(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerUploadThrottle, RepeatThrottle]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        upload = CustomerUploadSerializer(data=request.data)
        upload.is_valid(raise_exception=True)
        data = upload.validated_data
        if data.get("phone") and not data.get("token") and Customer.objects.filter(phone=data["phone"], consent_at__isnull=False).exists():
            # Older deployed clients delete permanently rejected (4xx) outbox
            # items. A retryable response preserves the photo during rollout.
            return Response({"detail": "Reopen your customer link to update the studio and save your poster. Keep this tab open until it is saved.", "code": "customer_link_required"}, status=503, headers={"Retry-After": "30"})
        if data.get("phone") and not Customer.objects.filter(
            phone=data["phone"], spin_token=data.get("token", ""), consent_at__isnull=False,
        ).exists():
            raise ValidationError({"token": "Open your customer link before uploading photos."})
        if not data.get("phone") and data["session"].startswith("phone-"):
            raise ValidationError({"session": "Open your customer link before uploading photos."})
        if Customer.objects.filter(session=data["session"]).exclude(phone=data.get("phone") or None).exists():
            raise ValidationError({"session": "This photo session belongs to a different customer."})
        mirror = Mirror.objects.filter(slug=data.get("mirror") or "").first()
        branch = _branch(data.get("branch"), strict=False)
        # Compress one upload at a time per process so a rush of
        # uploads queues briefly instead of slowing every request down.
        if not _IMAGE_WORK.acquire(timeout=IMAGE_WAIT_SECONDS):
            return Response(
                {"detail": "SKY is busy saving other photos. Retrying shortly."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={"Retry-After": "10"},
            )
        try:
            # Compress photos to ≤200 KB at the highest quality that fits.
            for field, size in (("poster", POSTER_SIZE), ("selfie", SELFIE_SIZE)):
                if field in data:
                    data[field] = compressed_photo(data[field], size) or data[field]
            thumbs = {"poster_thumb": optimized(data["poster"], THUMB_SIZE, 78)}
            if not thumbs["poster_thumb"]:
                raise ValidationError({"poster": "This image could not be decoded. Choose another image."})
            if "selfie" in data:
                thumbs["selfie_thumb"] = optimized(data["selfie"], THUMB_SIZE, 78)
                if not thumbs["selfie_thumb"]:
                    raise ValidationError({"selfie": "This image could not be decoded. Choose another image."})
        finally:
            _IMAGE_WORK.release()
        replaced = []
        with transaction.atomic():
            # Registered customers are matched by mobile number, others by session.
            lookup = (
                {"phone": data["phone"]} if data.get("phone") else {"session": data["session"]}
            )
            customer, created = Customer.objects.select_for_update().get_or_create(
                **lookup, defaults={"session": data["session"], "poster": data["poster"]}
            )
            if customer.phone and (customer.phone != data.get("phone") or customer.spin_token != data.get("token")):
                raise ValidationError({"token": "This link does not own the photo session."})
            # Old files are deleted only after the new ones are saved, so a
            # failed save never leaves a customer without photos.
            if not created:
                if customer.poster:
                    replaced.append(customer.poster.name)
                customer.poster = data["poster"]
            # The selfie preview is replaced only together with a new selfie.
            thumbs_replaced = ("poster_thumb", "selfie_thumb") if "selfie" in data else ("poster_thumb",)
            for thumb in thumbs_replaced:
                if getattr(customer, thumb):
                    replaced.append(getattr(customer, thumb).name)
            customer.poster_thumb = thumbs["poster_thumb"]
            if "selfie" in data:
                if customer.selfie:
                    replaced.append(customer.selfie.name)
                customer.selfie = data["selfie"]
                customer.selfie_thumb = thumbs["selfie_thumb"]
            customer.mirror = mirror
            customer.mirror_name = mirror.name if mirror else data.get("mirror", "")
            _file_under(customer, branch)
            if data.get("name"):
                customer.name = data["name"]
            customer.save()
            # Only once the new files are committed are the old ones removed.
            storage = customer.poster.storage
            transaction.on_commit(lambda: [storage.delete(n) for n in replaced if n])
            _log(customer, "poster_saved", mirror=customer.mirror_name)
        return Response(
            # Private poster address; staff sessions or the customer bearer token authorize reads.
            {"id": customer.pk, "poster": customer.poster.url if customer.poster else None},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class CustomerLink(APIView):
    """Who a WhatsApp link belongs to, and their prize if they already spun."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerRegisterThrottle, RepeatThrottle]

    def get(self, request, token):
        customer = Customer.objects.filter(spin_token=token).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        _log(customer, "link_opened", version=customer.link_version)
        # The wheel shows every gift; the bill decides only which one is won
        # (CustomerSpin), so a range with a single gift still spins a full wheel.
        items = cache.get("spin_items_active")
        if items is None:
            items = list(SpinItem.objects.filter(is_active=True))
            cache.set("spin_items_active", items, 10)
        won = next((i for i in items if i.slug == customer.reward), None)
        if won is None and customer.reward:
            won = SpinItem.objects.filter(slug=customer.reward).first()
        if won and won not in items:
            items.append(won)
        return Response({
            "phone": customer.phone, "name": customer.name, "reward": customer.reward or None,
            "items": wheel_items(items),
            "next": customer.next_step,
            "video_review": customer.video_review,
            "instagram_id": customer.instagram_id,
            "poster": customer.poster.url if customer.poster else None,
        })


class CustomerSpin(APIView):
    """Picks the prize on the server, once per customer. Only the token from
    the WhatsApp link can spin; the selfie comes after the prize."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle, RepeatThrottle]

    def post(self, request):
        ser = SpinSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            customer = (
                Customer.objects.select_for_update()
                .filter(spin_token=ser.validated_data["token"])
                .first()
            )
            if customer is None:
                return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
            if not customer.terms_accepted_at:
                return Response({"detail": NO_TERMS}, status=status.HTTP_400_BAD_REQUEST)
            if not customer.reward:
                items = SpinItem.for_bill(customer.bill_value)
                if not items:
                    return Response({"detail": NO_GIFTS}, status=status.HTTP_400_BAD_REQUEST)
                customer.reward = _DRAW.choices(items, [max(i.weight, 1) for i in items])[0].slug
                customer.save(update_fields=["reward", "updated_at"])
                _log(customer, "spun", reward=customer.reward)
        return Response({"reward": customer.reward})


# --- Store manager API ------------------------------


class ManagerBranches(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ManagerThrottle, RepeatThrottle]

    def get(self, request):
        branches = Branch.objects.filter(is_active=True)
        return Response(PublicBranchSerializer(branches, many=True).data)


def _save_purchase(data, branch, **log):
    """Files a checked purchase (by the manager's check or an admin's
    approval) and gives it a spin link."""
    uploaded_invoice = None
    try:
        with transaction.atomic():
            customer = Customer.objects.select_for_update().filter(phone=data["phone"]).first()
            if customer and customer.reward:
                raise ValidationError({"phone": ["This customer has already claimed a gift."]})
            others = Customer.objects.exclude(pk=customer.pk if customer else None)
            if data["imei"] and others.filter(imei=data["imei"]).exists():
                raise ValidationError({"imei": ["This IMEI is already registered."]})
            if others.filter(branch=branch, invoice_number=data["invoice_number"]).exists():
                raise ValidationError(
                    {"invoice_number": ["This invoice is already registered at this branch."]}
                )
            customer = customer or Customer(
                phone=data["phone"], session=f"phone-{data['phone']}"
            )
            new = customer.pk is None
            # Changed details get a fresh link; the old one stops working.
            changed = not new and (
                customer.name, customer.email, customer.product_details, customer.imei,
                customer.invoice_number, customer.bill_value, customer.branch_id,
            ) != (
                data["name"], data.get("email", ""), data["product_details"], data["imei"],
                data["invoice_number"], data["bill_value"], branch.pk,
            )
            customer.name = data["name"]
            customer.email = data.get("email", "")
            customer.product_details = data["product_details"]
            customer.imei = data["imei"]
            customer.invoice_number = data["invoice_number"]
            customer.bill_value = data["bill_value"]
            customer.branch, customer.branch_name = branch, branch.name
            customer.consent_at = customer.consent_at or timezone.now()
            customer.ocr_text = data["ocr_text"]
            customer.blur_score = data["blur_score"]
            if changed or not customer.spin_token:
                customer.spin_token = secrets.token_urlsafe(24)
                customer.link_version += 1
            previous_invoice = customer.invoice_image.name
            preview = data.get("invoice_preview")
            if preview:
                storage = customer.invoice_image.storage
                name = storage.save(f"customers/invoice-{uuid4().hex}.jpg", ContentFile(preview))
                uploaded_invoice = (storage, name)
                customer.invoice_image = name
            customer.save()
            if preview and previous_invoice and previous_invoice != customer.invoice_image.name:
                storage = customer.invoice_image.storage
                transaction.on_commit(lambda: storage.delete(previous_invoice), robust=True)
            _log(customer, "checked", version=customer.link_version, link_changed=changed, **log)
    except Exception as exc:
        if uploaded_invoice:
            storage, name = uploaded_invoice
            storage.delete(name)
        if isinstance(exc, IntegrityError):
            # Two counters submitted the same purchase at the same moment.
            raise ValidationError({"imei": ["This purchase is already registered."]}) from exc
        raise
    return customer


class ManagerCheck(APIView):
    """Checks a purchase and, if it holds up, saves it and returns the spin
    link. Pressing Check again after a correction updates the same customer
    until they have spun."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ManagerThrottle, RepeatThrottle]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        try:
            return self.check(request)
        except ValidationError as exc:
            CustomerEvent.objects.create(
                phone=str(request.data.get("phone", ""))[:20], kind="check_failed",
                detail={
                    "errors": json.loads(json.dumps(exc.detail, default=str)),
                    **{
                        field: str(request.data.get(field, ""))[:160]
                        for field in ("branch", "name", "email", "product_details",
                                      "imei", "invoice_number", "bill_value")
                    },
                    # What the scanner read, to see why a real bill was refused.
                    "ocr_text": (cache.get(f"invoice-scan:{request.data.get('scan', '')}") or "")[:4000],
                },
            )
            raise

    def check(self, request):
        ser = CustomerIntakeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        customer = _save_purchase(data, _branch(data["branch"]))
        return Response({"phone": customer.phone, "link": spin_link(customer.spin_token)})


# OCR is CPU-heavy: at most three invoices are read at once per worker.
_OCR_WORK = threading.BoundedSemaphore(3)
SCAN_SECONDS = 30 * 60


class ManagerScan(APIView):
    """Reads an uploaded invoice (photo or PDF) on the server and keeps the
    text and compressed preview briefly for the check."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ManagerThrottle]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        from .extract import MAX_BYTES, UnreadableInvoice, extract_text, invoice_preview

        upload = request.FILES.get("invoice")
        if upload is None:
            return Response({"invoice": ["Upload the invoice image or PDF."]}, status=400)
        if upload.size > MAX_BYTES:
            return Response({"invoice": ["The invoice file is too large (max 15 MB)."]}, status=400)
        if not _OCR_WORK.acquire(timeout=5):
            return Response(
                {"detail": "SKY is busy reading other invoices. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE, headers={"Retry-After": "5"},
            )
        try:
            raw = upload.read(MAX_BYTES + 1)
            text = extract_text(raw, upload.name)
            from .serializers import NOT_AN_INVOICE, looks_like_invoice

            if not looks_like_invoice(text):
                raise UnreadableInvoice(NOT_AN_INVOICE)
            preview = invoice_preview(raw)
        except UnreadableInvoice as exc:
            return Response({"invoice": [str(exc)]}, status=400)
        finally:
            _OCR_WORK.release()
        scan = secrets.token_urlsafe(16)
        cache.set_many({
            f"invoice-scan:{scan}": text,
            f"invoice-preview:{scan}": preview,
        }, SCAN_SECONDS)
        return Response(
            {"scan": scan, "text": text},
            headers={"Cache-Control": "private, no-store"},
        )


class ManagerSent(APIView):
    """The manager opened WhatsApp with this customer's link."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ManagerThrottle, RepeatThrottle]

    def post(self, request):
        customer = Customer.objects.filter(phone=str(request.data.get("phone", ""))).first()
        if customer is None:
            return Response({"detail": "Customer not found."}, status=404)
        _log(customer, "whatsapp_sent", version=customer.link_version)
        return Response({"ok": True})


class CustomerTerms(APIView):
    """Terms accepted on the link's first screen; no spin without them."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle, RepeatThrottle]

    def post(self, request):
        ser = TermsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        customer = Customer.objects.filter(spin_token=ser.validated_data["token"]).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        data = ser.validated_data
        customer.terms_accepted_at = customer.terms_accepted_at or timezone.now()
        customer.video_review = data["video_review"]
        customer.instagram_id = data.get("instagram_id", "").lstrip("@") if data["video_review"] else ""
        with transaction.atomic():
            customer.save(update_fields=["terms_accepted_at", "video_review", "instagram_id", "updated_at"])
            _log(customer, "terms_accepted", video_review=customer.video_review)
        return Response({"next": customer.next_step})


class CustomerReview(APIView):
    """Star rating and review, given after the spin."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle, RepeatThrottle]

    def post(self, request):
        ser = ReviewSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        customer = Customer.objects.filter(spin_token=ser.validated_data["token"]).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        if not customer.reward:
            return Response({"detail": "Spin the wheel first."}, status=status.HTTP_400_BAD_REQUEST)
        customer.rating = ser.validated_data["rating"]
        customer.review = ser.validated_data.get("review", "").strip()
        with transaction.atomic():
            customer.save(update_fields=["rating", "review", "updated_at"])
            _log(customer, "reviewed", rating=customer.rating)
        return Response({"next": customer.next_step})


LIVE_KEY = "live-visitors"
LIVE_SECONDS = 70  # visitors ping every 30 s; two misses and they're gone


def live_visitors():
    """Open pages right now, newest first: who (customer or manager) and where."""
    now = time.time()
    rows = []
    for visitor, seen in (cache.get(LIVE_KEY) or {}).items():
        seen = seen if isinstance(seen, dict) else {"t": seen}
        if now - seen["t"] < LIVE_SECONDS:
            rows.append({"id": visitor, "seconds_ago": round(now - seen["t"]),
                         "role": seen.get("role", ""), "screen": seen.get("screen", "")})
    return sorted(rows, key=lambda r: r["seconds_ago"])


def live_count():
    return len(live_visitors())


class ClientError(APIView):
    """A crash on a customer's phone, with its browser, to fix pages that
    break only on some phones."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MirrorPollThrottle]

    def post(self, request):
        detail = {k: str(request.data.get(k, ""))[:1500] for k in ("where", "message", "stack", "url")}
        detail["browser"] = request.headers.get("User-Agent", "")[:300]
        CustomerEvent.objects.create(kind="client_error", detail=detail)
        return Response(status=status.HTTP_204_NO_CONTENT)


class LivePing(APIView):
    """A customer page saying it is still open, for the admin's live count."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MirrorPollThrottle]

    def post(self, request):
        visitor = str(request.data.get("id", ""))[:40]
        if visitor:
            now = time.time()
            seen = {
                k: v for k, v in (cache.get(LIVE_KEY) or {}).items()
                if now - (v["t"] if isinstance(v, dict) else v) < LIVE_SECONDS
            }
            seen[visitor] = {
                "t": now,
                "role": str(request.data.get("role", ""))[:20],
                "screen": str(request.data.get("screen", ""))[:40],
            }
            cache.set(LIVE_KEY, seen, LIVE_SECONDS * 2)
        return Response(status=status.HTTP_204_NO_CONTENT)


class CustomerEventView(APIView):
    """Records which share button a customer pressed."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle, RepeatThrottle]

    def post(self, request):
        ser = EventSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        customer = Customer.objects.filter(spin_token=ser.validated_data["token"]).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        url, kind = ser.validated_data.get("url", ""), ser.validated_data["kind"]
        if kind == CustomerEvent.GIFT_UNLOCKED:
            # The reward is granted only once everything checks out: a checked
            # Instagram post link and a WhatsApp screenshot verified by staff.
            done = set(customer.events.values_list("kind", flat=True))
            if not reward_progress(customer, done)["ready"]:
                return Response({"detail": "SKY is still checking your shares."}, status=400)
        _log(customer, kind, **({"url": url} if url else {}))
        return Response({"ok": True})


PROOFS = {"whatsapp": ("whatsapp_proof", "whatsapp_proof_status", "posted_whatsapp"),
          "follow": ("follow_proof", "follow_proof_status", "follow_proof_sent")}


class CustomerProof(APIView):
    """A screenshot proving a step (WhatsApp Status, or following our
    Instagram), kept for staff to verify. GET returns every check's state so
    the customer's waiting screen can show progress."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle, RepeatThrottle]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get(self, request, kind="whatsapp"):
        customer = Customer.objects.filter(spin_token=str(request.query_params.get("token", ""))).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        progress = reward_progress(customer, set(customer.events.values_list("kind", flat=True)))
        return Response({"status": getattr(customer, PROOFS[kind][1]) or "", "progress": progress})

    def post(self, request, kind="whatsapp"):
        image_field, status_field, event = PROOFS[kind]
        customer = Customer.objects.filter(spin_token=str(request.data.get("token", ""))).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        shot = request.FILES.get("screenshot")
        if shot is None:
            return Response({"screenshot": ["Upload a screenshot as proof."]}, status=400)
        if shot.size > MAX_UPLOAD_BYTES:
            return Response({"screenshot": ["The screenshot is too large (max 12 MB)."]}, status=400)
        if optimized(shot, THUMB_SIZE) is None:
            return Response({"screenshot": ["That file isn't an image."]}, status=400)
        small = compressed_photo(shot, SELFIE_SIZE)
        old = getattr(customer, image_field).name
        setattr(customer, image_field, small or shot)
        setattr(customer, status_field, "pending")
        with transaction.atomic():
            customer.save(update_fields=[image_field, status_field, "updated_at"])
            if old:
                storage = getattr(customer, image_field).storage
                transaction.on_commit(lambda: storage.delete(old))
            _log(customer, event, proof=getattr(customer, image_field).url)
        return Response({"status": "pending"})


@api_view(["POST"])
@permission_classes([IsAdminUser])
def verify_proof(request, pk, kind="whatsapp"):
    """Staff mark a proof screenshot (WhatsApp Status or Instagram follow) as
    verified or rejected."""
    image_field, status_field, _ = PROOFS.get(kind, PROOFS["whatsapp"])
    customer = Customer.objects.filter(pk=pk).first()
    if customer is None or not getattr(customer, image_field):
        return Response({"detail": "No screenshot for this customer."}, status=404)
    verdict = "verified" if request.data.get("verified") in (True, "true", "1") else "rejected"
    setattr(customer, status_field, verdict)
    with transaction.atomic():
        customer.save(update_fields=[status_field, "updated_at"])
        _log(customer, f"{kind}_{verdict}", by=request.user.get_username())
    return Response({"status": verdict})


class CustomerProfile(APIView):
    """The Instagram ID or Facebook profile a customer shares from."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [CustomerSpinThrottle]

    def post(self, request):
        ser = ProfileSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        customer = Customer.objects.filter(spin_token=ser.validated_data["token"]).first()
        if customer is None:
            return Response({"detail": INVALID_LINK}, status=status.HTTP_404_NOT_FOUND)
        platform, handle = ser.validated_data["platform"], ser.validated_data["handle"]
        field = "instagram_id" if platform == "instagram" else "facebook_profile"
        setattr(customer, field, handle)
        with transaction.atomic():
            customer.save(update_fields=[field, "updated_at"])
            _log(customer, f"profile_{platform}", handle=handle)
        return Response({"handle": handle})


# --- Staff API used by /sky/mirror/admin/ -----------------------------------


class AdminPagination(PageNumberPagination):
    page_size = 24
    page_size_query_param = "page_size"
    max_page_size = 100


def _positive_id(value, field):
    """A filter id from the query string, or a 400 (not a 500) if it's junk."""
    value = str(value)
    if not (value.isascii() and value.isdigit() and 0 < int(value) < 2**63):
        raise ValidationError({field: "Expected a positive id."})
    return int(value)


def _csv_cell(value):
    """Spreadsheets run cells starting = + - @ as formulas; a customer could
    type one. A leading apostrophe makes it plain text."""
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


class MirrorViewSet(viewsets.ModelViewSet):
    serializer_class = MirrorSerializer
    permission_classes = [IsAdminUser]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        return Mirror.objects.annotate(customer_count=Count("customers"))

    def perform_create(self, serializer):
        last = Mirror.objects.order_by("-order").values_list("order", flat=True).first()
        serializer.save(order=(last or 0) + 1)

    def perform_update(self, serializer):
        old_artwork = serializer.instance.artwork.name
        mirror = serializer.save()
        if old_artwork and mirror.artwork.name != old_artwork:
            storage = mirror.artwork.storage
            transaction.on_commit(lambda: storage.delete(old_artwork))

    def perform_destroy(self, instance):
        storage, name = instance.artwork.storage, instance.artwork.name
        with transaction.atomic():
            instance.delete()
            if name:
                transaction.on_commit(lambda: storage.delete(name))

    @action(detail=False, methods=["post"])
    def reorder(self, request):
        ids = request.data.get("ids")
        if (not isinstance(ids, list) or len(ids) > 1000 or len(set(map(str, ids))) != len(ids)
                or any(type(pk) is not int or pk <= 0 for pk in ids)):
            return Response({"ids": "Expected up to 1000 unique positive mirror ids."}, status=400)
        with transaction.atomic():
            for position, pk in enumerate(ids, start=1):
                Mirror.objects.filter(pk=pk).update(order=position, updated_at=timezone.now())
        return Response({"ok": True})


class CustomerViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = CustomerSerializer
    permission_classes = [IsAdminUser]
    pagination_class = AdminPagination

    def get_serializer_class(self):
        return CustomerDetailSerializer if self.action == "retrieve" else CustomerSerializer

    def get_queryset(self):
        qs = Customer.objects.select_related("mirror", "branch", "repeat_of").prefetch_related("events")
        if self.request.query_params.get("abandoned"):
            qs = _link_unsent(qs)
        if self.request.query_params.get("video"):
            qs = qs.filter(video_review=True)
        reached = self.request.query_params.get("reached")
        if reached == "shared":
            qs = qs.filter(events__kind__in=CustomerEvent.SHARE_KINDS).distinct()
        elif reached:
            qs = qs.filter(events__kind=reached).distinct()
        # ?season=karthigai → only Karthigai Deepam mirror; =other → everything else
        season = self.request.query_params.get("season")
        if season == "karthigai":
            qs = qs.filter(mirror__slug="karthigai-deepam")
        elif season == "other":
            qs = qs.exclude(mirror__slug="karthigai-deepam")
        mirror = self.request.query_params.get("mirror")
        if mirror:
            qs = qs.filter(mirror_id=_positive_id(mirror, "mirror"))
        branch = self.request.query_params.get("branch")
        if branch == "none":
            qs = qs.filter(branch__isnull=True)
        elif branch:
            qs = qs.filter(branch_id=_positive_id(branch, "branch"))
        search = self.request.query_params.get("q")
        if search:
            qs = qs.filter(
                Q(name__icontains=search) | Q(phone__icontains=search)
                | Q(imei__icontains=search) | Q(invoice_number__icontains=search)
            )
        date_from = self.request.query_params.get("date_from")
        date_to = self.request.query_params.get("date_to")
        if date_from:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__date__lte=date_to)
        return qs

    def perform_destroy(self, instance):
        files = [(f.storage, f.name) for f in (
            instance.poster, instance.selfie, instance.poster_thumb, instance.selfie_thumb,
            instance.invoice_image, instance.whatsapp_proof, instance.follow_proof,
        ) if f]
        with transaction.atomic():
            instance.delete()
            transaction.on_commit(lambda: [storage.delete(name) for storage, name in files])

    @action(detail=False, methods=["get"])
    def failed(self, request):
        """Latest checks that were refused; these never became customers."""
        rows = CustomerEvent.objects.filter(kind="check_failed").order_by("-created_at")[:200]
        return Response(CustomerEventSerializer(rows, many=True).data)

    @action(detail=False, methods=["get"])
    def abandoned(self, request):
        """Everyone who filled the form but never got a link."""
        unsent = CustomerSerializer(
            _link_unsent(Customer.objects.all()).order_by("-created_at")[:200], many=True
        ).data
        return Response({
            "link_not_sent": unsent,
            "check_failed": CustomerEventSerializer(_failed_attempts()[:200], many=True).data,
        })

    @action(detail=False, methods=["get"], url_path="export")
    def export(self, request):
        """Stream customer records without retaining the full CSV in memory."""
        import csv
        class Output:
            def write(self, value):
                return value
        rows = self.get_queryset().order_by("created_at")
        writer = csv.writer(Output())
        def content():
            yield writer.writerow(['id', 'phone', 'name', 'branch', 'mirror', 'reward', 'same_face_as', 'consent_at', 'created_at', 'poster_url', 'selfie_url', 'stage', 'rating', 'review', 'terms_accepted_at', 'video_review', 'instagram_id', 'email', 'product_details', 'imei', 'invoice_number', 'bill_value', 'invoice_image_url'])
            for c in rows.iterator(chunk_size=500):
                yield writer.writerow([_csv_cell(v) for v in [c.pk, c.phone, c.name, c.branch_name, c.mirror_name, c.reward, c.repeat_of.phone if c.repeat_of else '', c.consent_at.isoformat() if c.consent_at else '', c.created_at.isoformat(), request.build_absolute_uri(c.poster.url) if c.poster else '', request.build_absolute_uri(c.selfie.url) if c.selfie else '', c.stage, c.rating or '', c.review, c.terms_accepted_at.isoformat() if c.terms_accepted_at else '', 'yes' if c.video_review else 'no', c.instagram_id, c.email, c.product_details, c.imei, c.invoice_number, c.bill_value or '', request.build_absolute_uri(c.invoice_image.url) if c.invoice_image else '']])
        response = StreamingHttpResponse(content(), content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="sky-customers-{timezone.localdate():%Y%m%d}.csv"'
        return response


def _platform_counts(customers, kinds):
    """{"whatsapp": 3, ...}: how many such events per platform."""
    rows = (
        CustomerEvent.objects.filter(customer__in=customers, kind__in=kinds)
        .values("kind").annotate(n=Count("id"))
    )
    return {r["kind"].rsplit("_", 1)[1]: r["n"] for r in rows}


def _customer_stats(customers):
    """Counts the dashboard shows, for all customers or one branch."""
    today = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
    days = [today - timedelta(days=offset) for offset in range(6, -1, -1)]
    # Counts that used to take a query each now come back together.
    totals = customers.aggregate(
        customers=Count("id"),
        customers_today=Count("id", filter=Q(created_at__gte=today)),
        gifts=Count("id", filter=~Q(reward="")),
        repeat_faces=Count("id", filter=Q(repeat_of__isnull=False)),
        rating_avg=Avg("rating"), rating_n=Count("rating"),
        **{
            f"day{i}": Count("id", filter=Q(created_at__gte=d, created_at__lt=d + timedelta(days=1)))
            for i, d in enumerate(days)
        },
    )
    per_day = [{"date": d.date().isoformat(), "count": totals.pop(f"day{i}")} for i, d in enumerate(days)]
    platform_rows = list(CustomerEvent.objects.filter(customer__in=customers, kind__in=CustomerEvent.SHARE_KINDS + CustomerEvent.OPEN_KINDS + CustomerEvent.POSTED_KINDS).values("kind").annotate(n=Count("id")))
    def platform_counts(kinds):
        return {r["kind"].rsplit("_", 1)[1]: r["n"] for r in platform_rows if r["kind"] in kinds}
    rating = {"avg": totals.pop("rating_avg"), "n": totals.pop("rating_n")}
    steps = {
        "checked": Q(events__kind="checked"),
        "whatsapp_sent": Q(events__kind="whatsapp_sent"),
        "link_opened": Q(events__kind="link_opened"),
        "spun": Q(events__kind="spun"),
        "poster_saved": Q(events__kind="poster_saved"),
        "shared": Q(events__kind__in=CustomerEvent.SHARE_KINDS),
    }
    funnel = customers.aggregate(**{k: Count("id", filter=q, distinct=True) for k, q in steps.items()})
    rewards = (
        customers.exclude(reward="").values("reward").annotate(n=Count("id")).order_by("-n")
    )
    top = (
        customers.exclude(mirror_name="").values("mirror_name")
        .annotate(n=Count("id")).order_by("-n")[:5]
    )
    return {
        "funnel": funnel,
        "abandoned": _link_unsent(customers).count(),
        "shares": platform_counts(CustomerEvent.SHARE_KINDS),
        "share_opened": platform_counts(CustomerEvent.OPEN_KINDS),
        "posted": platform_counts(CustomerEvent.POSTED_KINDS),
        "rating": rating,
        "reviews": list(
            customers.exclude(rating=None).order_by("-updated_at")
            .values("id", "name", "branch_name", "rating", "review")[:6]
        ),
        **totals,
        "per_day": per_day,
        "rewards": [{"id": r["reward"], "n": r["n"]} for r in rewards],
        "top_mirrors": [{"name": m["mirror_name"], "n": m["n"]} for m in top],
    }


@api_view(["GET"])
@permission_classes([IsAdminUser])
def database_backup(request):
    """The whole database (every table and row) as a .sql file, streamed."""
    import os
    import subprocess

    from django.db import connection

    db = settings.DATABASES["default"]
    name = f"sky-database-{timezone.localtime():%Y%m%d-%H%M}.sql"
    if connection.vendor == "mysql":
        proc = subprocess.Popen(
            ["mysqldump", "--single-transaction", "--quick", "--no-tablespaces",
             "--routines", "-h", db["HOST"] or "127.0.0.1", "-P", str(db["PORT"] or 3306),
             "-u", db["USER"], db["NAME"]],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**os.environ, "MYSQL_PWD": db["PASSWORD"]},  # never on the command line
        )

        def chunks():
            try:
                yield from iter(lambda: proc.stdout.read(64 * 1024), b"")
            finally:
                proc.stdout.close()
                proc.wait()

        body = chunks()
    else:
        connection.ensure_connection()
        body = (line + "\n" for line in connection.connection.iterdump())
    response = StreamingHttpResponse(body, content_type="application/sql")
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["Cache-Control"] = "no-store"
    return response


@api_view(["GET"])
@permission_classes([IsAdminUser])
def sharers(request, platform):
    """Everyone who shared on one platform: each customer once, with how often
    they shared and their proof (an Instagram post link, or a WhatsApp Status
    confirmation). Newest first, 15 a page."""
    if platform not in ("instagram", "whatsapp", "facebook", "more"):
        return Response({"detail": "Unknown platform."}, status=404)
    kinds = [f"share_opened_{platform}", f"shared_{platform}", f"posted_{platform}"]
    if platform == "instagram":
        kinds += ["follow_opened", "follow_proof_sent"]
    events = CustomerEvent.objects.filter(kind__in=kinds, customer__isnull=False)
    proof_filter = request.query_params.get("proof")
    if proof_filter in ("pending", "verified", "rejected") and platform in ("instagram", "whatsapp"):
        field = "whatsapp_proof_status" if platform == "whatsapp" else "follow_proof_status"
        events = events.filter(**{f"customer__{field}": proof_filter})
    rows = (
        events
        .values("customer").annotate(last=Max("created_at"),
                                     shares=Count("id", filter=Q(kind=f"shared_{platform}")),
                                     opened=Count("id", filter=Q(kind=f"share_opened_{platform}")))
        .order_by("-last")
    )
    total = rows.count()
    page = request.query_params.get("page", "1")
    page = int(page) if page.isdigit() and int(page) > 0 else 1
    chunk = list(rows[(page - 1) * 15: page * 15])
    customers = {c.pk: c for c in Customer.objects.filter(pk__in=[r["customer"] for r in chunk])}
    proof = {}
    for e in CustomerEvent.objects.filter(customer__in=customers, kind=f"posted_{platform}").order_by("created_at"):
        proof[e.customer_id] = e.detail.get("url", "") or "screenshot"
    results = []
    for r in chunk:
        c = customers[r["customer"]]
        image = c.whatsapp_proof if platform == "whatsapp" else c.follow_proof if platform == "instagram" else None
        image_status = c.whatsapp_proof_status if platform == "whatsapp" else c.follow_proof_status if platform == "instagram" else ""
        results.append({
            "customer": c.pk, "name": c.name, "phone": c.phone, "branch": c.branch_name,
            "instagram_id": c.instagram_id, "facebook": c.facebook_profile, "reward": c.reward,
            "shares": r["shares"], "opened": r["opened"], "last": r["last"],
            "customer_link": spin_link(c.spin_token) if c.spin_token else "",
            "proof": proof.get(c.pk, ""),
            "screenshot": image.url if image else "",
            "screenshot_status": image_status,
        })
    return Response({"count": total, "results": results,
                     "proved": len(set(CustomerEvent.objects.filter(kind=f"posted_{platform}").values_list("customer", flat=True)))})


@api_view(["GET"])
@permission_classes([IsAdminUser])
def rejections(request):
    """Refused checks still waiting: what was typed and what Django read."""
    return Response(CustomerEventSerializer(_failed_attempts()[:200], many=True, context={"ids": True}).data)


def _resolve(event, how, user):
    """Marks a refusal (and that number's earlier ones) as handled."""
    for e in CustomerEvent.objects.filter(kind="check_failed", phone=event.phone):
        e.detail = {**e.detail, "resolved": how, "resolved_by": user.get_username()}
        e.save(update_fields=["detail"])


@api_view(["POST"])
@permission_classes([IsAdminUser])
def approve_rejection(request, pk):
    """An admin checked the refused purchase by hand: file it with the
    corrected details and return the spin link to send."""
    event = CustomerEvent.objects.filter(pk=pk, kind="check_failed").first()
    if event is None:
        return Response({"detail": "This rejection no longer exists."}, status=404)
    ser = ApprovalSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    data["ocr_text"] = event.detail.get("ocr_text", "")
    customer = _save_purchase(data, _branch(data["branch"]), approved_by=request.user.get_username())
    _resolve(event, "approved", request.user)
    return Response({"phone": customer.phone, "link": spin_link(customer.spin_token)})


@api_view(["POST"])
@permission_classes([IsAdminUser])
def dismiss_rejection(request, pk):
    event = CustomerEvent.objects.filter(pk=pk, kind="check_failed").first()
    if event is None:
        return Response({"detail": "This rejection no longer exists."}, status=404)
    _resolve(event, "dismissed", request.user)
    return Response({"ok": True})


@api_view(["GET"])
@permission_classes([IsAdminUser])
def server_status(request):
    """The VPS's CPU, memory, storage and network, and who is online now."""
    from .server import snapshot

    return Response({**snapshot(), "live": live_visitors()})


@api_view(["GET"])
@permission_classes([IsAdminUser])
def database_backup(request):
    """The whole database (every table and row) as a .sql file, streamed."""
    import os
    import subprocess

    from django.db import connection

    db = settings.DATABASES["default"]
    name = f"sky-database-{timezone.localtime():%Y%m%d-%H%M}.sql"
    if connection.vendor == "mysql":
        proc = subprocess.Popen(
            ["mysqldump", "--single-transaction", "--quick", "--no-tablespaces",
             "--routines", "-h", db["HOST"] or "127.0.0.1", "-P", str(db["PORT"] or 3306),
             "-u", db["USER"], db["NAME"]],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**os.environ, "MYSQL_PWD": db["PASSWORD"]},  # never on the command line
        )

        def chunks():
            try:
                yield from iter(lambda: proc.stdout.read(64 * 1024), b"")
            finally:
                proc.stdout.close()
                proc.wait()

        body = chunks()
    else:
        connection.ensure_connection()
        body = (line + "\n" for line in connection.connection.iterdump())
    response = StreamingHttpResponse(body, content_type="application/sql")
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["Cache-Control"] = "no-store"
    return response


def _dump_database(dest):
    """Write the whole database as SQL to the open binary file ``dest``."""
    import os
    import subprocess

    from django.db import connection

    db = settings.DATABASES["default"]
    if connection.vendor == "mysql":
        subprocess.run(
            ["mysqldump", "--single-transaction", "--quick", "--no-tablespaces",
             "--routines", "-h", db["HOST"] or "127.0.0.1", "-P", str(db["PORT"] or 3306),
             "-u", db["USER"], db["NAME"]],
            stdout=dest, stderr=subprocess.PIPE, check=True,
            env={**os.environ, "MYSQL_PWD": db["PASSWORD"]},  # never on the command line
        )
    else:
        connection.ensure_connection()
        for line in connection.connection.iterdump():
            dest.write((line + "\n").encode())


class _Chunks:
    """File-like sink for tarfile's stream mode; hands out what was written."""

    def __init__(self):
        self.parts = []

    def write(self, data):
        self.parts.append(bytes(data))
        return len(data)

    def take(self):
        out, self.parts = b"".join(self.parts), []
        return out


FULL_BACKUP_LOCK = "full-backup-running"


@api_view(["GET"])
@permission_classes([IsAdminUser])
def full_backup(request):
    """Database dump + every uploaded file (MEDIA_ROOT) + manifest, as one
    streamed .tar. Photos are already compressed, so the tar is not gzipped
    (faster, less CPU). One backup at a time."""
    import json
    import os
    import tarfile
    import tempfile
    from pathlib import Path

    from django.core.cache import cache

    if not cache.add(FULL_BACKUP_LOCK, 1, timeout=3600):
        return Response({"detail": "A full backup is already being prepared. Please wait for it to finish."},
                        status=status.HTTP_409_CONFLICT)
    stamp = f"{timezone.localtime():%Y%m%d-%H%M}"
    root = f"sky-backup-{stamp}"
    media = Path(settings.MEDIA_ROOT)
    try:
        sql = tempfile.NamedTemporaryFile(prefix="sky-db-", suffix=".sql", delete=False)
        with sql:
            _dump_database(sql)
    except Exception:
        cache.delete(FULL_BACKUP_LOCK)
        try:
            os.unlink(sql.name)
        except Exception:
            pass
        return Response({"detail": "The database could not be exported. Please try again."},
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    files = []
    if media.is_dir():
        for path in sorted(media.rglob("*")):
            if path.is_file() and not path.is_symlink():
                files.append(path)

    def stream():
        sink = _Chunks()
        try:
            with tarfile.open(fileobj=sink, mode="w|", format=tarfile.PAX_FORMAT) as tar:
                tar.add(sql.name, arcname=f"{root}/database.sql")
                yield sink.take()
                total = 0
                for path in files:
                    try:
                        tar.add(str(path), arcname=f"{root}/media/{path.relative_to(media).as_posix()}")
                        total += path.stat().st_size
                    except (FileNotFoundError, PermissionError):
                        continue  # deleted or unreadable while the backup ran
                    chunk = sink.take()
                    if chunk:
                        yield chunk
                manifest = json.dumps({
                    "created": timezone.localtime().isoformat(),
                    "database": "database.sql",
                    "database_bytes": os.path.getsize(sql.name),
                    "media_files": len(files),
                    "media_bytes": total,
                    "restore": [
                        "MySQL: mysql -u <user> -p <database> < database.sql",
                        "Media: copy media/ into MEDIA_ROOT (e.g. /var/lib/skymirror/media)",
                    ],
                }, indent=2).encode()
                info = tarfile.TarInfo(f"{root}/manifest.json")
                info.size = len(manifest)
                info.mtime = int(timezone.now().timestamp())
                import io
                tar.addfile(info, io.BytesIO(manifest))
            yield sink.take()
        finally:
            try:
                os.unlink(sql.name)
            except Exception:
                pass
            cache.delete(FULL_BACKUP_LOCK)

    response = StreamingHttpResponse(stream(), content_type="application/x-tar")
    response["Content-Disposition"] = f'attachment; filename="{root}.tar"'
    response["Cache-Control"] = "no-store"
    response["X-Accel-Buffering"] = "no"
    return response


@api_view(["GET"])
@permission_classes([IsAdminUser])
def stats(request):
    season = request.query_params.get("season")
    if season == "karthigai":
        customers = Customer.objects.filter(mirror__slug="karthigai-deepam")
    elif season == "other":
        customers = Customer.objects.exclude(mirror__slug="karthigai-deepam")
    else:
        customers = Customer.objects.all()

    cache_key = f"admin_stats:{season or 'all'}"
    cached = cache.get(cache_key)
    if cached:
        return Response(cached)

    data = _customer_stats(customers)
    data.update(
        **Mirror.objects.aggregate(mirrors=Count("id"), active_mirrors=Count("id", filter=Q(is_active=True))),
        branches=Branch.objects.count(),
        branch_sales=[
            {"id": b.pk, "name": b.name, "value": b.value, "n": b.n}
            for b in Branch.objects.annotate(
                value=Sum("customers__bill_value"), n=Count("customers")
            ).filter(value__gt=0).order_by("-value")[:8]
        ],
        live=live_count(),
        failed_checks=CustomerEvent.objects.filter(kind="check_failed").count(),
        abandoned=_link_unsent(Customer.objects.all()).count() + len(_failed_attempts()),
        top_branches=list(
            Branch.objects.annotate(n=Count("customers")).order_by("-n", "name").values("id", "name", "n")
        ),
        season=season or "all",
    )
    cache.set(cache_key, data, 10)
    return Response(data)


class SpinItemViewSet(viewsets.ModelViewSet):
    """Wheel gifts and the bill range each one is for."""

    serializer_class = SpinItemSerializer
    permission_classes = [IsAdminUser]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    queryset = SpinItem.objects.all()


class BranchViewSet(viewsets.ModelViewSet):
    """Stores: add, edit, delete; each has a studio link and a QR code.
    Deleting a branch keeps its customers (their records keep the name)."""

    serializer_class = BranchSerializer
    permission_classes = [IsAdminUser]

    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        return Branch.objects.annotate(
            customer_count=Count("customers"), sales=Sum("customers__bill_value")
        ).order_by("-customer_count", "name")

    def get_serializer_context(self):
        """How far each branch's customers have got, for the cards' bars."""
        steps = {"sent": ["whatsapp_sent"], "opened": ["link_opened"], "spun": ["spun"],
                 "posters": ["poster_saved"], "shared": CustomerEvent.SHARE_KINDS}
        journey = {}
        for step, kinds in steps.items():
            rows = (
                CustomerEvent.objects.filter(kind__in=kinds, customer__branch__isnull=False)
                .values("customer__branch").annotate(n=Count("customer", distinct=True))
            )
            for row in rows:
                journey.setdefault(row["customer__branch"], {})[step] = row["n"]
        return {**super().get_serializer_context(), "journey": journey}

    @action(detail=True, methods=["get"])
    def stats(self, request, pk=None):
        branch = self.get_object()
        return Response(_customer_stats(Customer.objects.filter(branch=branch)))

    @action(detail=True, methods=["get"])
    def qr(self, request, pk=None):
        """PNG QR code of the branch link; ?download=1 saves it as a file."""
        from io import BytesIO

        import qrcode
        from django.http import HttpResponse

        branch = self.get_object()
        code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=3)
        code.add_data(branch_link(branch))
        code.make(fit=True)
        out = BytesIO()
        code.make_image(fill_color="#17120d", back_color="white").save(out, format="PNG")
        response = HttpResponse(out.getvalue(), content_type="image/png")
        response["Cache-Control"] = "private, no-store"
        if request.query_params.get("download"):
            response["Content-Disposition"] = f'attachment; filename="SKY-{branch.slug}-QR.png"'
        return response


class PublicBranch(APIView):
    """Branch name for the studio, from its link (?branch=<slug>)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MirrorPollThrottle]

    def get(self, request, slug):
        key = f"branch_public:{slug}"
        data = cache.get(key)
        if data is None:
            branch = Branch.objects.filter(slug=slug, is_active=True).first()
            if branch is None:
                return Response({"detail": INACTIVE_BRANCH}, status=status.HTTP_404_NOT_FOUND)
            data = PublicBranchSerializer(branch).data
            cache.set(key, data, 30)
        return Response(data)


@staff_member_required(login_url="mirror-login")
@ensure_csrf_cookie
def dashboard(request):
    return render(request, "mirrors/dashboard.html")


class LockoutLoginView(LoginView):
    """Staff login that locks a username or network out after repeated failures."""

    template_name = "mirrors/login.html"
    max_failures = 5
    lockout_seconds = 15 * 60

    def _keys(self):
        ip = client_ip(self.request)
        user = self.request.POST.get("username", "").strip().lower()[:150]
        return [f"login-fail:ip:{ip}", f"login-fail:user:{user}"]

    def _locked(self):
        return any((cache.get(k) or 0) >= self.max_failures for k in self._keys())

    def post(self, request, *args, **kwargs):
        if self._locked():
            # A bound login form checks the password when validated, which
            # would let a locked-out guesser keep testing passwords.
            form = self.form_class(request=self.request)
            form.cleaned_data = {}
            form.add_error(None, "Too many failed sign-ins. Try again in 15 minutes.")
            return self.render_to_response(self.get_context_data(form=form))
        return super().post(request, *args, **kwargs)

    def form_invalid(self, form):
        for key in self._keys():
            cache.add(key, 0, timeout=self.lockout_seconds)
            cache.incr(key)
        return super().form_invalid(form)

    def form_valid(self, form):
        cache.delete_many(self._keys())
        return super().form_valid(form)


@require_safe
def invoice_media(request, filename):
    """Serve an invoice preview to authenticated staff only."""
    if not (request.user.is_authenticated and request.user.is_staff):
        response = HttpResponse(status=403)
    else:
        try:
            response = FileResponse(default_storage.open(f"customers/{filename}", "rb"), content_type="image/jpeg")
        except FileNotFoundError:
            response = HttpResponse(status=404)
    response["Cache-Control"] = "private, no-store, max-age=0"
    response["X-Content-Type-Options"] = "nosniff"
    response["Vary"] = "Cookie"
    return response


@require_safe
def customer_media(request, filename):
    """Staff may view customer images; a bearer token may read its own poster."""
    path = f"customers/{filename}"
    allowed = request.user.is_authenticated and request.user.is_staff
    if not allowed:
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        allowed = bool(scheme.lower() == "bearer" and token and len(token) <= 128 and
                       Customer.objects.filter(spin_token=token).filter(
                           Q(poster=path) | Q(selfie=path) | Q(poster_thumb=path) | Q(selfie_thumb=path),
                       ).exists())
    if not allowed:
        response = HttpResponse(status=403)
    elif not re.fullmatch(r"[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)", filename, flags=re.IGNORECASE):
        response = HttpResponse(status=404)
    else:
        try:
            response = FileResponse(default_storage.open(path, "rb"))
        except FileNotFoundError:
            response = HttpResponse(status=404)
    response["Cache-Control"] = "private, no-store, max-age=0"
    response["X-Content-Type-Options"] = "nosniff"
    response["Vary"] = "Cookie, Authorization"
    return response
