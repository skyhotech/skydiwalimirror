import { useStudio, type Photo, type Adjustment, type Layout } from "./store";
import { fromBlob } from "./images";
type StoredPhoto = {
  id: string;
  blob: Blob;
  adjust: Adjustment;
  label: string;
};
type Draft = {
  version: 1;
  selfie: StoredPhoto | null;
  products: StoredPhoto[];
  template: string;
  layout: Layout;
  poster: Blob | null;
};
const DB = "sky-private-photos",
  KEY = "latest-draft";
let startup: Promise<void> | null = null,
  queue: Promise<void> = Promise.resolve(),
  status = "Saving photos on this device",
  dbPromise: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();
function message(value: string) {
  status = value;
  listeners.forEach((fn) => fn());
}
export function storageStatus() {
  return status;
}
export function subscribeStorage(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function database() {
  if (!dbPromise)
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("drafts");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return dbPromise;
}
async function read(): Promise<Draft | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction("drafts").objectStore("drafts").get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function photo(p: Photo | null): StoredPhoto | null {
  return p
    ? { id: p.id, blob: p.blob, adjust: p.adjust, label: p.label }
    : null;
}
async function save(draft: Draft) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite"),
      store = tx.objectStore("drafts");
    if (!draft.selfie && !draft.products.length) store.delete(KEY);
    else store.put(draft, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  message(
    draft.selfie
      ? "Photos saved on this device"
      : "No saved photos on this device",
  );
}
async function restore(p: StoredPhoto | null): Promise<Photo | null> {
  if (!p || !(p.blob instanceof Blob)) return null;
  const decoded = await fromBlob(p.blob);
  return {
    ...decoded,
    id: p.id,
    adjust: {
      x: Number.isFinite(p.adjust?.x) ? p.adjust.x : 0,
      y: Number.isFinite(p.adjust?.y) ? p.adjust.y : 0,
      zoom: Number.isFinite(p.adjust?.zoom) ? p.adjust.zoom : 1,
    },
    label: typeof p.label === "string" ? p.label : "",
  };
}
export function initializePhotoStorage(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    try {
      const draft = await read();
      if (draft?.version === 1) {
        const allocated: Photo[] = [];
        try {
          const selfie = await restore(draft.selfie);
          if (selfie) allocated.push(selfie);
          const products: Photo[] = [];
          for (const record of draft.products.slice(0, 5)) {
            const p = await restore(record);
            if (p) {
              products.push(p);
              allocated.push(p);
            }
          }
          useStudio.setState({
            selfie,
            products,
            template: draft.template,
            layout: draft.layout,
            savedPoster: draft.poster instanceof Blob ? draft.poster : null,
            step: selfie ? (products.length ? "edit" : "product") : "selfie",
          });
        } catch {
          allocated.forEach((p) => URL.revokeObjectURL(p.url));
          throw new Error("Saved photos could not be restored.");
        }
      }
      message(
        draft?.selfie
          ? "Photos restored from this device"
          : "Photos will be saved on this device",
      );
    } catch {
      message(
        "Browser storage unavailable. Keep this tab open and download your poster.",
      );
    }
    useStudio.subscribe((state, previous) => {
      if (
        state.selfie === previous.selfie &&
        state.products === previous.products &&
        state.template === previous.template &&
        state.layout === previous.layout &&
        state.savedPoster === previous.savedPoster
      )
        return;
      const draft: Draft = {
        version: 1,
        selfie: photo(state.selfie),
        products: state.products.map((p) => photo(p)!),
        template: state.template,
        layout: state.layout,
        poster: state.savedPoster,
      };
      message("Saving photos on this device…");
      queue = queue
        .then(() => save(draft))
        .catch(() => {
          message(
            "Photos could not be saved. Storage may be full or disabled; download your poster.",
          );
        });
    });
  })();
  return startup;
}
