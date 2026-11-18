# SKY Karthigai Deepam Selfie Studio

The studio creates 1080 × 1350 (4:5) Instagram feed posters. On an existing
installation, run `python manage.py seed_mirrors --hide-legacy` from
`backend/` to install the Deepam frame and hide the three original built-in
mirrors. Staff can create, edit, reorder, hide, show, or delete frames under
**Mirrors** in the staff dashboard.

A React/TypeScript camera studio for SKY Mobile & Electronics, with a Django
API and staff dashboard. The public manager/kiosk scans invoices and IMEIs,
selects a branch and creates private customer links. Customers use their link to
accept terms, review the offer, spin for a server-selected gift, capture a selfie
and product photos, and share their poster. Staff review submitted links and
WhatsApp/follow screenshot proof in the authenticated dashboard.

## Local setup

Use Node.js 22.12+ and Python 3.12 or 3.13.

```sh
npm ci
python3.13 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
# Set a random DJANGO_SECRET_KEY in backend/.env.
backend/.venv/bin/python backend/manage.py migrate
backend/.venv/bin/python backend/manage.py seed_mirrors
backend/.venv/bin/python backend/manage.py createsuperuser
npm run dev
```

`mysqlclient` needs MySQL/MariaDB client development libraries and `pkg-config`
on macOS/Linux. SQLite-only development can install the other pinned packages;
MySQL deployment still requires the complete requirements file.

`npm ci` copies MediaPipe WASM and downloads optional face/gesture models into
`public/ai/`. Retry `npm run setup` if a model download fails. No AI API key is
needed; inference stays on the device. Manual photography works without models.

`npm run dev` starts Vite and an available `backend/.venv` Django environment.
The studio is at `http://localhost:5173`; the staff dashboard is at
`http://localhost:5173/sky/mirror/admin/`. The backend is required for first-time
registration and prize selection. `npm run dev:frontend` starts Vite alone.
Remembered drafts can be opened when the API is unavailable, but registration,
spinning and uploads need a connection.

Phone camera access requires HTTPS or localhost and browser camera permission.
An ordinary HTTP LAN URL generally cannot use the camera.

## Customer workflow

1. A public manager/kiosk creates the purchase link using invoice, IMEI and branch
   information. Invoice PDFs use native text first, then bounded OCR when needed.
2. The customer opens their private link, accepts terms and completes the offer
   and review steps. The server assigns a gift once.
3. The customer captures a selfie and product photos, chooses a frame and prepares
   a poster. Manual capture works when optional gesture models are unavailable.
4. Sharing records opened/shared actions and submitted post links. These signals
   do not prove a public post was published. Staff can request a WhatsApp status
   screenshot through a prefilled WhatsApp draft and review uploaded proof.
5. The four dashboard platform cards open the corresponding sharer lists.

Private links are bearer credentials: keep them private. The manager/kiosk remains
public by explicit product decision; throttles and upload limits reduce abuse but
are not staff authentication. No screenshot request is automatically sent.

## Camera, images and storage

Camera attempts are invalidated on pause, hide, unmount and device changes.
Late permission results are stopped, capture waits for playable video, and
interrupted tracks offer retry. Denied permission is retried only by a user
request or a granted-permission change. A startup deadline reports failure;
it never declares an unready camera successful.

Frame downloads have explicit failure/retry states and a bounded cache.
Customer uploads accept JPEG, PNG and WebP, up to 12 MB and 25 megapixels.
Opaque photos are resized and compressed toward a 200 KB target; transparent
images retain transparency. Staff thumbnails are generated separately.

The latest draft and poster are stored as Blobs in IndexedDB, associated with
the customer number and private token. Rapid edits coalesce to the newest pending save. Storage
failure is reported and does not prevent camera use. Download important photos.

Uploads are stored in a separate durable outbox. Network failures leave them
queued; invalid uploads stay marked as failed for staff recovery rather than
being silently deleted. A corrected export replaces that entry. **Next customer**
clears the active draft but deliberately retains pending uploads for delivery.
Browser storage eviction/private mode can still prevent recovery; this is not
an off-device backup or guaranteed delivery service.

## Sharing

The share payload includes the poster, SKY caption and `@skymobileandelectronics`.
The customer chooses Instagram and completes publication. A website cannot
force a share target, guarantee caption autofill or confirm publication.
Unsupported sharing downloads the poster and attempts to open Instagram.
Cancelled sharing keeps the prepared poster available for another tap.

## Staff API and privacy

The dashboard manages themes, customers, branches, QR codes and CSV exports.
Staff APIs require a Django staff session and CSRF protection. Customer image
URLs require staff authentication or the owning customer token for their own
poster/selfie; invoice and proof files remain staff-only. Responses use private,
no-store caching. Deploy the matching proxy and frontend changes together.
Previously cached public copies require separate cache purging.

## Verification

```sh
npm run check
npx playwright install chromium
npm run test:e2e
backend/.venv/bin/python backend/manage.py test mirrors --settings=skymirror.test_settings
backend/.venv/bin/python backend/manage.py makemigrations --check --dry-run --settings=skymirror.test_settings
npx playwright test --config=playwright.integration.config.ts
```

SQLite tests use an isolated in-memory database/cache and skip `backend/.env`.
The integration suite starts disposable loopback servers on 8001/5174, with
synthetic media, a temporary database and a test staff account. It does not use
local or production databases. Synthetic camera streams and Chromium mobile
viewports do not replace Safari/Android/iPhone hardware testing.

## Deployment

Build with `npm run build` and serve `dist/` over HTTPS. Same-origin `/api` and
`/media` proxy to Django; `VITE_API_URL` selects a separate API origin. The
existing Vercel/VPS routing is in `vercel.json` and `deploy/`. Serve WASM as
`application/wasm`, allow same-origin model resources and configure CORS for
remote frame artwork so Canvas exports are not tainted.

Set a random production `DJANGO_SECRET_KEY` of at least 50 characters,
`DJANGO_DEBUG=0`, explicit allowed hosts/CORS/CSRF origins, `STUDIO_URL`, shared
`REDIS_URL` for multiple workers, and the exact `TRUSTED_PROXIES` count. The
built-in Django admin defaults off in production; the dashboard login has a
failure lockout. Failed/slow backend requests emit structured diagnostics with
request IDs and no customer body/query data. Responses include `X-Request-ID`
and `Server-Timing`. Monitoring/alert routing still needs operational setup.

Set `STUDIO_URL` to the public frontend URL. Django redirects its home path
there and preserves branch and customer link parameters.
