import { replaceTemplates, type Template } from "../templates";

// Same-origin by default (Vite proxies /api in dev); set VITE_API_URL otherwise.
const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "") + "/api";
// Fallback when the event stream is unavailable (e.g. a proxy that buffers it).
export const POLL_MS = 1000;

let lastPayload = "";
let lastVersion = "";
let inFlight = false;

function apply(text: string) {
  if (text === lastPayload) return;
  lastPayload = text;
  replaceTemplates(JSON.parse(text) as Template[]);
}

async function pollMirrors() {
  if (inFlight) return;
  inFlight = true;
  try {
    const v = await fetch(`${API}/mirrors/version/`, { cache: "no-store" });
    if (!v.ok) return;
    const { version } = (await v.json()) as { version: string };
    if (version === lastVersion) return;

    const res = await fetch(`${API}/mirrors/`, { cache: "no-store" });
    if (!res.ok) return;
    lastVersion = version;
    apply(await res.text());
  } catch {
    // Offline or backend down: keep showing the current themes.
  } finally {
    inFlight = false;
  }
}

export function startMirrorSync() {
  // The server pushes the theme list the instant an admin saves.
  let stream: EventSource | null = null;
  if (typeof EventSource !== "undefined") {
    stream = new EventSource(`${API}/mirrors/stream/`);
    stream.addEventListener("mirrors", (e) => {
      try {
        apply((e as MessageEvent<string>).data);
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
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Object.values(data as Record<string, unknown>).flat()[0];
    throw new Error(
      typeof detail === "string" ? detail : "Could not reach SKY. Try again.",
    );
  }
  return data as T;
}
/** Signs the customer in by mobile number; returns their prize if already spun. */
export const registerPhone = (phone: string) =>
  postJson<{ phone: string; reward: string | null }>("/customers/register/", {
    phone,
    // The sign-in screen only submits after the consent box is ticked.
    consent: true,
  });
/** The server picks the prize, once per mobile number. */
export const spinPrize = async (phone: string, face: number[] | null) =>
  (await postJson<{ reward: string }>("/customers/spin/", { phone, face }))
    .reward;
type Upload = {
  session: string;
  phone?: string | null;
  mirror: string;
  reward?: string | null;
  poster: Blob;
  selfie?: Blob;
};
// Uploads wait in an on-device outbox until the backend confirms them, so a
// dropped connection, a down backend or a closed tab never loses a customer.
type Pending = Upload & { queuedAt: number };
const OUTBOX = "sky-upload-outbox",
  RETRY_MS = 30_000;
let outboxDb: Promise<IDBDatabase> | null = null;
function outbox() {
  if (!outboxDb)
    outboxDb = new Promise((resolve, reject) => {
      const req = indexedDB.open(OUTBOX, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("uploads");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return outboxDb;
}
async function outboxRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await outbox();
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction("uploads", mode).objectStore("uploads"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function send(data: Upload) {
  const form = new FormData();
  form.append("session", data.session);
  form.append("mirror", data.mirror);
  if (data.phone) form.append("phone", data.phone);
  if (data.reward) form.append("reward", data.reward);
  const ext = (b: Blob) => (b.type === "image/png" ? "png" : "jpg");
  form.append("poster", data.poster, `poster.${ext(data.poster)}`);
  if (data.selfie)
    form.append("selfie", data.selfie, `selfie.${ext(data.selfie)}`);
  return fetch(`${API}/customers/`, { method: "POST", body: form });
}
// Removes an entry only if it wasn't replaced by a newer export meanwhile.
async function settle(sent: Pending) {
  const current = await outboxRequest<Pending | undefined>("readonly", (s) =>
    s.get(sent.session),
  );
  if (current?.queuedAt === sent.queuedAt)
    await outboxRequest("readwrite", (s) => s.delete(sent.session));
}
let flushing = false;
export async function flushUploads() {
  if (flushing) return;
  flushing = true;
  try {
    const pending = await outboxRequest<Pending[]>("readonly", (s) =>
      s.getAll(),
    );
    for (const item of pending) {
      let res: Response;
      try {
        res = await send(item);
      } catch {
        return; // Offline or backend down: retry later.
      }
      // 4xx other than throttling means the upload itself is invalid; drop it
      // rather than retrying forever.
      const permanent =
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408 &&
        res.status !== 429;
      if (res.ok || permanent) await settle(item);
      else return;
    }
  } catch {
    // IndexedDB unavailable; uploadCustomer already sent directly.
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
export async function uploadCustomer(data: Upload) {
  try {
    // Keyed by session: a re-export replaces that customer's queued upload.
    await outboxRequest("readwrite", (s) =>
      s.put({ ...data, queuedAt: Date.now() } satisfies Pending, data.session),
    );
  } catch {
    // No on-device storage (e.g. private mode): best-effort direct send.
    await send(data).catch(() => {});
    return;
  }
  await flushUploads();
}
