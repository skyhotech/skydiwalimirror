import { committedRequest, deleteIf, openDatabase } from "./indexedDb";
import { combineSignals } from "./abort";
import { withLoader } from "./loading";
import { replaceTemplates, type Template } from "../templates";

// Same-origin by default (Vite proxies /api in dev); set VITE_API_URL otherwise.
/** Backend origin; empty when the studio and API share one site. */
export const API_ORIGIN = (
  import.meta.env.VITE_API_URL ??
  (import.meta.env.PROD ||
  (typeof location !== "undefined" && location.hostname.endsWith(".vercel.app"))
    ? "https://87.232.72.141"
    : "")
).replace(/\/$/, "");
const API = API_ORIGIN + "/api";
/** Where /media files load from. On Vercel they go through its CDN (see
 *  vercel.json), so each image leaves the VPS once and loads from nearby. */
export const MEDIA_ORIGIN =
  typeof location !== "undefined" &&
  location.hostname.endsWith(".vercel.app") &&
  !import.meta.env.VITE_API_URL
    ? ""
    : API_ORIGIN;
// Fallback when the event stream is unavailable (e.g. a proxy that buffers it).
export const POLL_MS = 30_000;

let lastPayload = "";
let lastVersion = "";
let inFlight = false;
let streamRevision = 0;

function apply(text: string) {
  if (text === lastPayload) return;
  replaceTemplates(JSON.parse(text) as Template[]);
  lastPayload = text;
}

async function pollMirrors() {
  if (inFlight) return;
  inFlight = true;
  const revision = streamRevision;
  try {
    const v = await fetch(`${API}/mirrors/version/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!v.ok) return;
    const { version } = (await v.json()) as { version: string };
    if (version === lastVersion) return;

    const res = await fetch(`${API}/mirrors/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const payload = await res.text();
    if (revision !== streamRevision) return;
    apply(payload);
    lastVersion = version;
  } catch {
    // Offline or backend down: keep showing the current themes.
  } finally {
    inFlight = false;
  }
}

export function startMirrorSync() {
  // The server pushes the theme list the instant an admin saves.
  let stream: EventSource | null = null;
  // Only same-origin (local) backends stream; the VPS turns streaming off to
  // save threads, so the studio just checks the version every second there.
  if (typeof EventSource !== "undefined" && !API_ORIGIN) {
    stream = new EventSource(`${API}/mirrors/stream/`);
    stream.addEventListener("mirrors", (e) => {
      try {
        apply((e as MessageEvent<string>).data);
        streamRevision++;
        lastVersion = "";
      } catch {
        // Ignore a malformed event; the next one replaces it.
      }
    });
  }
  const streaming = () => stream?.readyState === EventSource.OPEN;
  void pollMirrors();
  const timer = setInterval(() => {
    if (!streaming() && document.visibilityState === "visible")
      void pollMirrors();
  }, POLL_MS);
  // Catch up immediately when a kiosk tab regains focus.
  const wake = () => {
    if (document.visibilityState === "visible") void pollMirrors();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  return () => {
    stream?.close();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
  };
}

// Indian mobile (10 digits, starts 6–9) that doesn't look made up: rejects one
// digit repeated (9999999999), a digit then zeros (9000000000), a repeated pair
// (9898989898) or half (9876598765), and straight counting up or down with
// wrap-around (9876543210, 6789012345). Kept in sync with PHONE_REGEX in
// backend/mirrors/serializers.py.
const COUNTING = Array.from({ length: 10 }, (_, i) => [
  "0123456789".repeat(2).slice(i, i + 10),
  "9876543210".repeat(2).slice(i, i + 10),
]).flat();
export const PHONE_PATTERN = new RegExp(
  String.raw`^(?!(\d)\1{9}$)(?!\d0{9}$)(?!(\d\d)\2{4}$)(?!(\d{5})\3$)` +
    `(?!(?:${COUNTING.join("|")})$)[6-9]\\d{9}$`,
);
// Customer-facing messages; technical details never reach the screen.
export const ERRORS = {
  offline: "You're offline. Check the Wi-Fi or mobile data and try again.",
  unreachable: "Can't reach SKY right now. Please try again in a moment.",
  timeout: "SKY is taking too long to respond. Please try again.",
  server: "Something went wrong on our side. Please try again in a moment.",
  busy: (seconds: number) =>
    `Too many tries. Please wait ${
      seconds < 90
        ? `${seconds} second${seconds === 1 ? "" : "s"}`
        : `${Math.ceil(seconds / 60)} minutes`
    } and try again.`,
};
const REQUEST_TIMEOUT_MS = 15_000;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Seconds the server asked us to wait (busy or rate-limited). */
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
// The store whose link or QR code opened the studio (?branch=…). Remembered,
// so a counter tablet stays on its branch across reloads and customers.
const BRANCH_KEY = "sky-branch";
export const BRANCH: string = (() => {
  try {
    const fromLink = (new URLSearchParams(location.search).get("branch") ?? "")
      .trim()
      .toLowerCase();
    if (fromLink) localStorage.setItem(BRANCH_KEY, fromLink);
    return fromLink || localStorage.getItem(BRANCH_KEY) || "";
  } catch {
    return "";
  }
})();
// A double tap sends one request: an identical one already on its way is shared.
const pendingPosts = new Map<string, Promise<unknown>>();
function postJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const key =
    body instanceof FormData || signal ? "" : path + JSON.stringify(body);
  const running = key && pendingPosts.get(key);
  if (running) return running as Promise<T>;
  // The wheel shows its own spin; everything else shows the SKY loader.
  const send = sendJson<T>(path, body, headers, signal);
  const request = path === "/customers/spin/" ? send : withLoader(send);
  if (key) {
    pendingPosts.set(key, request);
    void request.finally(() => pendingPosts.delete(key)).catch(() => {});
  }
  return request;
}
async function sendJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  if (!navigator.onLine) throw new ApiError(ERRORS.offline);
  let res: Response;
  try {
    const form = body instanceof FormData;
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        ...(form ? undefined : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: form ? body : JSON.stringify(body),
      signal: combineSignals([
        AbortSignal.timeout(REQUEST_TIMEOUT_MS * (form ? 3 : 1)),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch (e) {
    throw new ApiError(
      (e as Error).name === "TimeoutError"
        ? ERRORS.timeout
        : navigator.onLine
          ? ERRORS.unreachable
          : ERRORS.offline,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const wait = Number(res.headers.get("Retry-After")) || 0;
    if (res.status === 429)
      throw new ApiError(ERRORS.busy(Math.ceil(wait || 30)), 429, wait || 30);
    if (res.status === 503) throw new ApiError(ERRORS.server, 503, wait || 10);
    if (res.status >= 500) throw new ApiError(ERRORS.server, res.status);
    // Validation errors come back as {field: [message]}; show the first.
    const detail = Object.values(data).flat()[0];
    throw new ApiError(
      typeof detail === "string" ? detail : ERRORS.unreachable,
      res.status,
    );
  }
  return data as T;
}
// The secret from the customer's WhatsApp link (?spin=…).
export const SPIN_TOKEN =
  typeof location === "undefined"
    ? ""
    : (new URLSearchParams(location.search).get("spin") ?? "");
/** Who a WhatsApp link belongs to; their prize if they already spun. */
let activeCustomer: { phone: string; token: string } | null = null;
const pendingLinks = new Map<string, ReturnType<typeof readLink>>();
export function fetchLink(token: string) {
  let pending = pendingLinks.get(token);
  if (!pending) {
    const request = readLink(token);
    pendingLinks.set(token, request);
    void request
      .finally(() => {
        if (pendingLinks.get(token) === request) pendingLinks.delete(token);
      })
      .catch(() => {});
    pending = request;
  }
  return withLoader(pending);
}
async function readLink(token: string) {
  let res: Response;
  try {
    res = await fetch(`${API}/customers/link/${encodeURIComponent(token)}/`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(ERRORS.unreachable);
  }
  const data = (await res.json().catch(() => ({}))) as {
    phone?: string;
    reward?: string | null;
    items?: { id: string; label: string; image: string }[];
    poster?: string | null;
    name?: string;
    instagram_id?: string;
    next?: string;
    video_review?: boolean;
    detail?: string;
  };
  if (!res.ok || !data.phone)
    throw new ApiError(data.detail ?? ERRORS.server, res.status);
  activeCustomer = { phone: data.phone, token };
  // Resume a pre-upgrade outbox item only after the server confirmed ownership.
  void flushUploads();
  return {
    phone: data.phone,
    reward: data.reward ?? null,
    name: data.name ?? "",
    instagramId: data.instagram_id ?? "",
    items: data.items ?? [],
    poster: data.poster ? MEDIA_ORIGIN + data.poster : null,
    reviewed: !["terms", "spin", "review"].includes(data.next ?? ""),
    termsAccepted: data.next !== "terms",
    videoReview: Boolean(data.video_review),
  };
}
export type BranchOption = { slug: string; name: string; phone?: string };
/** Active stores for the manager page. */
export async function fetchManagerBranches() {
  let res: Response;
  try {
    res = await fetch(`${API}/manager/branches/`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(ERRORS.unreachable);
  }
  if (!res.ok) throw new ApiError(ERRORS.server, res.status);
  const branches: unknown = await res.json();
  if (!Array.isArray(branches) || branches.some((branch) =>
    !branch || typeof branch.name !== "string" || typeof branch.slug !== "string"
  )) {
    throw new ApiError(ERRORS.server, res.status);
  }
  return branches as BranchOption[];
}
// Phone photos are several MB; this size still reads perfectly and uploads fast.
const UPLOAD_SIDE = 2600;
async function shrinkPhoto(file: File): Promise<Blob> {
  if (file.type === "application/pdf" || file.size < 1_500_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      UPLOAD_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const c = document.createElement("canvas");
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    return await new Promise<Blob>((resolve) =>
      c.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.92),
    );
  } catch {
    return file;
  }
}
/** Django reads the invoice (PDF text, or enhanced OCR) and keeps the
 *  reading for the check; the text comes back to fill in the form. */
export async function scanInvoice(file: File | Blob, name = "invoice") {
  const form = new FormData();
  const upload = file instanceof File ? await shrinkPhoto(file) : file;
  const pdf = upload.type === "application/pdf";
  form.append("invoice", upload, pdf ? "invoice.pdf" : `${name}.jpg`);
  return postJson<{ scan: string; text: string }>("/manager/scan/", form);
}
/** Validates and saves the purchase; returns the customer's spin link. */
export const checkPurchase = (form: FormData) =>
  postJson<{ phone: string; link: string }>("/manager/check/", form);
/** Accepts the terms; the video pledge brings the customer's Instagram ID. */
export const acceptTerms = (
  token: string,
  videoReview: boolean,
  instagramId: string,
) =>
  postJson<{ next: string }>("/customers/terms/", {
    token,
    accept: true,
    video_review: videoReview,
    instagram_id: instagramId,
  });
/** Star rating and review, sent once after the spin. */
export const sendReview = (token: string, rating: number, review: string) =>
  postJson<{ next: string }>("/customers/review/", { token, rating, review });
// One id per open tab, so the admin can count who is on the site right now.
const LIVE_MS = 30_000;
// The screen is read when each ping goes out, so the admin sees where they are.
export function startLivePing() {
  const id = Math.random().toString(36).slice(2);
  const ping = () => {
    if (document.visibilityState !== "visible") return;
    const screen =
      document.querySelector("main h1")?.textContent?.slice(0, 40) ??
      (document.querySelector(".camera-stage") ? "Mirror camera" : "");
    void fetch(`${API}/live/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        role: SPIN_TOKEN ? "customer" : "manager",
        screen,
      }),
      keepalive: true,
    }).catch(() => {});
  };
  ping();
  setInterval(ping, LIVE_MS);
  document.addEventListener("visibilitychange", ping);
}
/** Phones have a 15-digit IMEI that passes the Luhn check; other products
 *  print a serial in any format. Kept in sync with validate_imei in
 *  backend/mirrors/serializers.py. */
export function imeiOrSerialValid(value: string) {
  const v = value.trim();
  return /^\d{15}$/.test(v)
    ? imeiValid(v)
    : /^[A-Z0-9][A-Z0-9_-]{3,29}$/i.test(v);
}
/** Timeline entries; a lost one must never interrupt the customer. */
export function trackSent(phone: string) {
  void fetch(`${API}/manager/sent/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
    keepalive: true,
  }).catch(() => {});
}
/** kind: share_opened_<platform>, shared_<platform> or posted_<platform>. */
export function trackShare(token: string, kind: string, url?: string) {
  void fetch(`${API}/customers/event/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, kind, ...(url && { url }) }),
    keepalive: true,
  }).catch(() => {});
}
/** The Instagram ID or Facebook profile the customer shares from. */
export const saveProfile = (
  token: string,
  platform: "instagram" | "facebook",
  handle: string,
) =>
  postJson<{ handle: string }>("/customers/profile/", {
    token,
    platform,
    handle,
  });
/** Records the link to the customer's own post, as proof they posted
 *  (WhatsApp has no post link: the customer's confirmation is sent alone). */
export const savePostLink = (token: string, platform: string, url = "") =>
  postJson<{ ok: boolean }>("/customers/event/", {
    token,
    kind: `posted_${platform}`,
    ...(url && { url }),
  });
/** A proof screenshot (WhatsApp Status, or our Instagram showing
 *  "Following") for staff to verify. */
export function uploadProof(
  token: string,
  kind: "whatsapp" | "follow",
  screenshot: File,
) {
  const form = new FormData();
  form.append("token", token);
  form.append("screenshot", screenshot);
  return postJson<{ status: string }>(`/customers/${kind}-proof/`, form);
}
export type RewardProgress = {
  instagram_post: boolean;
  instagram_follow: string;
  whatsapp_status: string;
  google_review_opened: boolean;
  ready: boolean;
};
/** Every check the reward depends on: a quiet check, no loader. */
export async function rewardProgress(token: string) {
  const res = await fetch(
    `${API}/customers/follow-proof/?token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error("progress");
  return ((await res.json()) as { progress: RewardProgress }).progress;
}
/** Instagram and WhatsApp are done: the server unlocks the gift. */
export const unlockGift = (token: string) =>
  postJson<{ ok: boolean }>("/customers/event/", {
    token,
    kind: "gift_unlocked",
  });
// The uploaded poster's public address, once the server has it.
let posterUrl = "";
export const getPosterUrl = () => {
  if (
    !posterUrl ||
    new URL(posterUrl, location.href).pathname.startsWith("/media/customers/")
  )
    return "";
  return posterUrl;
};
const absolute = (url: string) =>
  url.startsWith("http") ? url : new URL(url, location.href).href;
// A phone's IMEI is 15 digits passing the Luhn check. Kept in sync with
// imei_valid in backend/mirrors/serializers.py.
export function imeiValid(imei: string) {
  if (!/^\d{15}$/.test(imei)) return false;
  let total = 0;
  for (let i = 0; i < 15; i++) {
    const n = Number(imei[i]) * (i % 2 ? 2 : 1);
    total += n > 9 ? n - 9 : n;
  }
  return total % 10 === 0;
}
// How long a customer may wait in the queue when SKY is busy.
const QUEUE_LIMIT_MS = 60_000;
/** The server picks the prize, once per customer. When it is busy the
 *  customer waits in line (onQueue reports it) and the request is retried. */
export async function spinPrize(
  token: string,
  onQueue?: (waiting: boolean) => void,
  signal?: AbortSignal,
) {
  const budget = combineSignals([
    AbortSignal.timeout(QUEUE_LIMIT_MS),
    ...(signal ? [signal] : []),
  ]);
  budget.throwIfAborted();
  const started = Date.now();
  for (;;) {
    try {
      const { reward } = await postJson<{ reward: string }>(
        "/customers/spin/",
        { token },
        undefined,
        budget,
      );
      onQueue?.(false);
      return reward;
    } catch (e) {
      const err = e as ApiError;
      if (budget.aborted) {
        onQueue?.(false);
        throw new ApiError(
          signal?.aborted ? "Spin cancelled." : ERRORS.timeout,
        );
      }
      // Only a busy server queues. A rate limit (429), network errors and
      // timeouts stop at once with their message.
      const queued = err.status === 503;
      if (!queued || Date.now() - started > QUEUE_LIMIT_MS) {
        onQueue?.(false);
        throw err;
      }
      onQueue?.(true);
      const wait = Math.min(15, err.retryAfter || 5) * 1000;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          budget.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, wait * (0.8 + Math.random() * 0.4));
        const abort = () => {
          clearTimeout(timer);
          budget.removeEventListener("abort", abort);
          reject(
            new ApiError(signal?.aborted ? "Spin cancelled." : ERRORS.timeout),
          );
        };
        budget.addEventListener("abort", abort, { once: true });
        if (budget.aborted) abort();
      });
    }
  }
}
type Upload = {
  token?: string | null;
  session: string;
  phone?: string | null;
  mirror: string;
  reward?: string | null;
  poster: Blob;
  selfie?: Blob;
  branch?: string;
};
// Uploads wait in an on-device outbox until the backend confirms them, so a
// dropped connection, a down backend or a closed tab never loses a customer.
type Pending = Upload & {
  queuedAt: number;
  revision?: string;
  failed?: boolean;
};
const OUTBOX = "sky-upload-outbox",
  RETRY_MS = 30_000;
let outboxDb: Promise<IDBDatabase> | null = null;
function outbox() {
  if (!outboxDb)
    outboxDb = openDatabase(OUTBOX, "uploads")
      .then((db) => {
        db.onversionchange = () => {
          db.close();
          outboxDb = null;
        };
        return db;
      })
      .catch((error) => {
        outboxDb = null;
        throw error;
      });
  return outboxDb;
}
async function outboxRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await outbox();
  return committedRequest(db, "uploads", mode, run);
}
async function send(data: Upload) {
  const form = new FormData();
  form.append("session", data.session);
  const token =
    data.token ||
    (activeCustomer && activeCustomer.phone === data.phone
      ? activeCustomer.token
      : undefined);
  if (token) form.append("token", token);
  form.append("mirror", data.mirror);
  if (data.phone) form.append("phone", data.phone);
  if (data.reward) form.append("reward", data.reward);
  if (data.branch) form.append("branch", data.branch);
  const ext = (b: Blob) =>
    b.type === "image/png" ? "png" : b.type === "image/webp" ? "webp" : "jpg";
  form.append("poster", data.poster, `poster.${ext(data.poster)}`);
  if (data.selfie)
    form.append("selfie", data.selfie, `selfie.${ext(data.selfie)}`);
  const response = await fetch(`${API}/customers/`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  if (response.ok) {
    const result = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (result.poster) posterUrl = absolute(result.poster);
  }
  return response;
}
// Removes an entry only if it wasn't replaced by a newer export meanwhile.
async function settle(sent: Pending) {
  return deleteIf<Pending>(
    await outbox(),
    "uploads",
    sent.session,
    (current) =>
      current.revision === sent.revision && current.queuedAt === sent.queuedAt,
  );
}
// What happened to this customer's poster upload, for an on-screen status line.
export type UploadState = "idle" | "saving" | "saved" | "retrying" | "failed";
let uploadState: UploadState = "idle";
let currentUpload: string | null = null;
let currentRevision = "";
const uploadListeners = new Set<() => void>();
function setUploadState(next: UploadState) {
  uploadState = next;
  uploadListeners.forEach((fn) => fn());
}
export const getUploadState = () => uploadState;
/** A new customer starts with no upload status. */
export const clearUploadState = () => {
  currentUpload = null;
  currentRevision = "";
  setUploadState("idle");
};
export function subscribeUpload(fn: () => void) {
  uploadListeners.add(fn);
  return () => {
    uploadListeners.delete(fn);
  };
}
let flushing = false;
let flushAgain = false;
export async function flushUploads() {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      // Read one Blob record at a time rather than decoding an entire backlog.
      const keys = await outboxRequest("readonly", (s) => s.getAllKeys());
      for (const key of keys) {
        const item = await outboxRequest<Pending | undefined>("readonly", (s) =>
          s.get(key),
        );
        if (!item || item.failed) continue;
        const update = (state: UploadState) => {
          if (
            currentUpload === item.session &&
            currentRevision === item.revision
          )
            setUploadState(state);
        };
        let res: Response;
        try {
          res = await send(item);
        } catch {
          update("retrying"); // Offline or backend down: retry later.
          return;
        }
        // Invalid uploads remain available for staff recovery, but are not
        // automatically retried. A corrected export replaces the failed record.
        const permanent =
          res.status >= 400 &&
          res.status < 500 &&
          res.status !== 408 &&
          res.status !== 429;
        if (res.ok) {
          if (await settle(item)) update("saved");
          else flushAgain = true;
        } else if (permanent) {
          const db = await outbox();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("uploads", "readwrite"),
              store = tx.objectStore("uploads");
            const read = store.get(item.session);
            read.onsuccess = () => {
              const current = read.result as Pending | undefined;
              if (
                current?.revision === item.revision &&
                current?.queuedAt === item.queuedAt
              )
                store.put({ ...current, failed: true }, item.session);
            };
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () => reject(tx.error);
          });
          update("failed");
        } else {
          update("retrying");
          return;
        }
      }
    } while (flushAgain);
  } catch {
    // A committed enqueue can be followed by a failed read transaction.
    // Surface that failure rather than leaving this customer's UI on Saving.
    if (currentUpload && uploadState !== "saved") setUploadState("failed");
  } finally {
    flushing = false;
  }
}
export function startUploadSync() {
  void flushUploads();
  const timer = setInterval(() => void flushUploads(), RETRY_MS);
  const online = () => void flushUploads();
  window.addEventListener("online", online);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", online);
  };
}
// The server stores ≤200 KB photos anyway, so a PNG (3–5 MB) is re-encoded as
// JPEG on the phone first: uploads get ~10× smaller and finish sooner.
async function asJpeg(blob: Blob, maxSide = Infinity): Promise<Blob> {
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (blob.type === "image/jpeg" && scale === 1) {
      return blob;
    }
    canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")!
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas!.toBlob(resolve, "image/jpeg", 0.9),
    );
    return jpeg && jpeg.size < blob.size ? jpeg : blob;
  } catch {
    return blob;
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
}

export async function uploadCustomer(data: Upload) {
  currentUpload = data.session;
  const revision = crypto.randomUUID();
  currentRevision = revision;
  latestExports.set(data.session, revision);
  setUploadState("saving");
  data = {
    ...data,
    branch: data.branch ?? (BRANCH || undefined),
    poster: await asJpeg(data.poster, 1280),
    selfie: data.selfie && (await asJpeg(data.selfie)),
  };
  // Encoding may complete out of order when a customer exports twice.
  if (latestExports.get(data.session) !== revision) return;
  try {
    // Keyed by session: a re-export replaces that customer's queued upload.
    await outboxRequest("readwrite", (s) =>
      s.put(
        { ...data, queuedAt: Date.now(), revision } satisfies Pending,
        data.session,
      ),
    );
  } catch {
    // No on-device storage (e.g. private mode): best-effort direct send.
    const res = await send(data).catch(() => null);
    if (currentUpload === data.session && currentRevision === revision)
      setUploadState(res?.ok ? "saved" : "failed");
    if (latestExports.get(data.session) === revision)
      latestExports.delete(data.session);
    return;
  }
  await flushUploads();
  if (latestExports.get(data.session) === revision)
    latestExports.delete(data.session);
}
const latestExports = new Map<string, string>();
