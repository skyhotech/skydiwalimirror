import { useStudio, type Photo, type Adjustment, type Layout } from "./store";
import { fromBlob } from "./images";
import { SPIN_TOKEN } from "./backend";
import { DEFAULT_TEMPLATE_ID } from "../templates";
import { committedRequest, openDatabase } from "./indexedDb";
type StoredPhoto = {
  id: string;
  blob: Blob;
  adjust: Adjustment;
  label: string;
};
type Draft = {
  version: 1;
  templateSetVersion?: 2;
  selfie: StoredPhoto | null;
  products: StoredPhoto[];
  template: string;
  layout: Layout;
  poster: Blob | null;
  reward?: string | null;
  phone?: string | null;
  token?: string | null;
};
const DB = "sky-private-photos",
  KEY = "latest-draft";
let startup: Promise<void> | null = null,
  pendingDraft: Draft | null = null,
  saving = false,
  status = "Saving photos on this device",
  dbPromise: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();
function message(value: string) {
  // A new pending write does not establish recovery from a storage failure.
  if (
    /^Saving photos/i.test(value) &&
    /unavailable|could not|full|disabled/i.test(status)
  )
    return;
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
    dbPromise = openDatabase(DB, "drafts")
      .then((db) => {
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        return db;
      })
      .catch((error) => {
        dbPromise = null;
        throw error;
      });
  return dbPromise;
}
async function read(): Promise<Draft | undefined> {
  const db = await database();
  return committedRequest(db, "drafts", "readonly", (s) => s.get(KEY));
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
async function flushDrafts() {
  if (saving) return;
  saving = true;
  try {
    while (pendingDraft) {
      const draft = pendingDraft;
      pendingDraft = null;
      try {
        await save(draft);
      } catch {
        message(
          "Photos could not be saved. Storage may be full or disabled; download your poster.",
        );
      }
    }
  } finally {
    saving = false;
  }
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
      const owner = useStudio.getState().phone;
      if (
        draft?.version === 1 &&
        owner &&
        (draft.phone === undefined || draft.phone === owner) &&
        (draft.token === undefined || draft.token === SPIN_TOKEN)
      ) {
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
            template:
              draft.templateSetVersion === 2
                ? draft.template
                : DEFAULT_TEMPLATE_ID,
            layout: draft.layout,
            savedPoster: draft.poster instanceof Blob ? draft.poster : null,
            reward: draft.reward ?? null,
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
        state.savedPoster === previous.savedPoster &&
        state.reward === previous.reward
      )
        return;
      const draft: Draft = {
        version: 1,
        templateSetVersion: 2,
        selfie: photo(state.selfie),
        products: state.products.map((p) => photo(p)!),
        template: state.template,
        layout: state.layout,
        poster: state.savedPoster,
        reward: state.reward,
        phone: state.phone,
        token: state.token,
      };
      message("Saving photos on this device…");
      // Bound retained snapshots during drags: save the newest draft after
      // the current transaction commits, rather than keeping every update.
      pendingDraft = draft;
      void flushDrafts();
    });
  })();
  return startup;
}
