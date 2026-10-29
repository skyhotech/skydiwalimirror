# SKY Diwali Selfie Studio

A mobile-first, browser-only Diwali poster camera for **SKY Mobile & Electronics**. Customers take a selfie, capture their actual purchase in the poster’s small product card, and share the completed poster with a generated SKY Instagram caption.

## Start locally

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

Installation automatically prepares MediaPipe WASM files and downloads the face-landmarker and selfie-segmentation models into `public/ai/`. No API keys, `.env`, backend, database server, or paid services are required. Internet access is needed for the first installation. If an optional model download fails, run `npm run setup` again; manual camera capture remains available.

Open the localhost URL printed by Vite. Phone camera access requires **HTTPS**; an ordinary HTTP LAN address usually cannot use cameras. Browser camera permission must be granted.

## Customer flow

1. Opening the link goes directly to the front-camera poster preview. There is no welcome screen, upload-photo button, or camera-flip button.
2. Swipe or use the bottom slider to select one of the two original frames.
3. Tap **Post on Instagram** inside the poster to capture the selfie. The selfie stays in the large mirror, and the rear camera automatically opens inside the small purchased-product card. If the rear camera is unavailable, the front camera is selected automatically.
4. Tap **Capture product & post**. The product photo is captured without selfie effects or mirroring, the camera stops, and a 1080 × 1920 poster is generated with both actual photos.
5. The app immediately attempts to share the poster and generated SKY caption through the device share sheet. Choose **Instagram → Post/Feed** when available. The caption is also copied when browser permissions allow; paste it if Instagram omits supplied text.

After capture, customers can retake the product, add another product (up to five), download, or open the editor. The editor supports photo positioning and zoom, product layouts, optional customer-entered captions, PNG/JPEG, and optional 2160 × 3840 output. Preview and export use the same Canvas renderer. Camera controls and posting buttons are never included in the exported image.

## Original frames included

- `public/frames/1.jpeg`: Festive Celebration, 900 × 1600.
- `public/frames/2.jpeg`: Golden Mirror, 900 × 1600.

Both load automatically for every visitor. There is no frame-upload prompt. The supplied SKY logo and promotional text remain part of the original artwork. The compositor removes the neutral mirror surface for the selfie and places actual product photos in the existing bottom card. Decorative lights, typography, and frame details remain in front. Check mask edges on real devices, especially near hair, warm highlights, and promotional badges.

## Selfie effects

The Smile filter is always enabled at **100% configured strength**, with no visible filter controls. It uses local MediaPipe face landmarks and a geometric mouth warp; it is a playful camera filter rather than generative expression replacement.

Portrait mode uses a local selfie-segmentation model to keep the person sharp while applying **20% background blur and warm golden bokeh lights** behind them. Here, 20% maps to a 4.8px blur radius at a 1080px short edge, scaled to the processed selfie resolution. Effects are included in captured selfies and exports. Product photos are unfiltered.

Inference runs at a controlled cadence, pauses with camera/tab lifecycle changes, and releases models and media tracks on unmount. Unsupported or failed effects fall back to normal manual photography with a status message. Hair edges, fast movement, lighting, expression appearance and performance need real-phone validation.

## Browser-local photo storage

The latest selfie, product photos, edits, selected frame/layout and generated poster are automatically stored as Blobs in **IndexedDB** on the customer’s browser. Refresh restores a selfie-only draft to product capture, or a completed draft to the editor. This is local storage, not cloud backup.

**Clear saved photos** deletes the saved draft and poster and starts again. **Create another** also clears the previous draft. Only the latest session is retained, not a photo history. Browser data clearing, storage eviction, private browsing or quota restrictions can affect persistence. Saving failures are shown without blocking camera capture or downloads. Important posters can be downloaded separately.

## Instagram behavior and limitations

The generated caption includes SKY Mobile & Electronics, `@skymobileindia`, and festive hashtags. Optional product labels are included only when the customer supplies them; product specifications, prices and discounts are not invented.

A website cannot force a particular installed share app, guarantee Instagram’s Post composer or caption autofill, or confirm actual publication. The customer chooses Instagram in the share sheet and completes the post. If sharing is unsupported, the poster downloads and the app attempts to open instagram.com. Use **Open Instagram** if the browser blocks the new tab, then select **+ → Post**, the saved poster, and paste the caption.

Some browsers expire the click activation while the captured image is encoded and the poster is generated. If the first sharing attempt is refused, the prepared file and caption remain available; tap **Post on Instagram** again for a fresh sharing action. Cancelled or failed sharing preserves the data. No Instagram account token, login, or publishing API is used.

## Privacy

Photos, facial landmarks, segmentation masks and expression scores are processed on the device. Photos and posters are saved only in that browser unless the customer explicitly shares or downloads them. Landmarks, masks and scores are never persisted. There are no analytics, remote photo uploads, or SKY image-processing servers.

Camera tracks stop before switching cameras, after completing a capture, when leaving the camera component, and while the tab is hidden. Blob URLs are revoked when photos are replaced or cleared.

## Build and deploy

```sh
npm run check
npm run build
npm run preview
```

Deploy `dist/` to any HTTPS static host. A typical build configuration is:

- Install: `npm ci` (includes automatic model setup).
- Build: `npm run build`.
- Output directory: `dist`.

Allow same-origin MediaPipe scripts/WASM and local inference if adding a Content Security Policy. Serve `.wasm` as `application/wasm`. Relative asset paths support deployment beneath a subdirectory. No server-side application is needed.

`node_modules/`, `dist/`, test reports and downloaded `public/ai/` files are deliberately excluded from Git. Source, the lockfile, setup script and both original frames are included.

## Tests

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

Unit tests cover smile-warp behavior, both frame layouts, generated captions, portrait strength and confidence alpha. Chromium desktop/mobile tests cover direct camera opening, front/rear selection and fallback, a live product preview in the small product card, combined poster export, share payloads and caption copying, download/open-Instagram fallback, missing-control assertions, foreground/background compositing, and IndexedDB refresh/clear behavior.

Camera streams, share targets and test customer images are synthetic. Automated mobile viewports are not real iPhone/Android hardware tests. Check actual Safari/Chrome camera permissions, rear-camera behavior, mirror orientation, hair/face effect quality, gestures, memory limits, storage availability and Instagram share targets on real phones before a campaign.

## Source guide

- `src/components/CameraStudio.tsx`: inline selfie/product capture and immediate sharing.
- `src/components/Editor.tsx`: editing, export, captions and sharing.
- `src/components/Templates.tsx`: mobile two-frame slider.
- `src/templates/index.ts`: original artwork paths and design-space coordinates.
- `src/lib/renderer.ts`: shared preview/export compositor and mirror masks.
- `src/hooks/useCamera.ts`: camera requests, fallback and cleanup.
- `src/hooks/useExpression.ts`: local Smile and portrait inference.
- `src/lib/portrait.ts`: sharp-person/background-blur and gold-light compositing.
- `src/lib/persistence.ts`: IndexedDB draft restoration and serialized saves.
- `src/lib/store.ts`: session state and Blob lifecycle.
- `src/lib/sharing.ts`: SKY caption and clipboard helpers.
- `scripts/setup.mjs`: automatic local AI runtime/model provisioning.

Implementation references: [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js), [MediaPipe Image Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter), [Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share).
