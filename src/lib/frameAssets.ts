import type { Template } from "../templates";
import { MEDIA_ORIGIN } from "./backend";
type Asset = {
  image: HTMLImageElement | null;
  status: "loading" | "ready" | "missing" | "stale";
};
const assets = new Map<string, Asset>();
const MAX_CACHED_FRAMES = 6;
// Last loaded image per theme id: shown while a new URL for the same theme
// (e.g. the backend copy of a built-in frame) downloads, instead of a blank.
const lastReady = new Map<string, HTMLImageElement>();
const listeners = new Set<() => void>();
export function subscribeFrames(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function frameAsset(template: Template, priority = true): Asset {
  // Keyed by artwork URL so a re-uploaded theme loads its new image.
  const cached = assets.get(template.artwork);
  if (cached) {
    assets.delete(template.artwork);
    assets.set(template.artwork, cached);
    return cached;
  }
  const previous = lastReady.get(template.id);
  const asset: Asset = previous
    ? { image: previous, status: "loading" }
    : { image: null, status: "loading" };
  assets.set(template.artwork, asset);
  while (assets.size > MAX_CACHED_FRAMES)
    assets.delete(assets.keys().next().value!);
  const image = new Image();
  image.decoding = "async";
  // The frame on screen downloads first; background preloads wait their turn.
  image.fetchPriority = priority ? "high" : "low";
  const finish = () => {
    clearTimeout(deadline);
    image.onload = image.onerror = null;
    listeners.forEach((fn) => fn());
  };
  const deadline = window.setTimeout(() => {
    asset.status = asset.image ? "stale" : "missing";
    finish();
    image.src = "";
  }, 20_000);
  image.onload = () => {
    asset.image = image;
    asset.status = "ready";
    lastReady.set(template.id, image);
    while (lastReady.size > MAX_CACHED_FRAMES)
      lastReady.delete(lastReady.keys().next().value!);
    finish();
  };
  image.onerror = () => {
    // Keep showing the previous image for this theme if we have one.
    asset.status = asset.image ? "stale" : "missing";
    finish();
  };
  // Backend artwork arrives as "/media/…" (served by the API's site); built-in
  // frames are relative to the studio. A different API origin needs CORS so
  // the export canvas stays untainted.
  const fromBackend = template.artwork.startsWith("/");
  const url = fromBackend
    ? new URL(MEDIA_ORIGIN + template.artwork, location.href)
    : /^https?:\/\//.test(template.artwork)
      ? new URL(template.artwork)
      : new URL(import.meta.env.BASE_URL + template.artwork, location.href);
  if (url.origin !== location.origin) image.crossOrigin = "anonymous";
  image.src = url.href;
  return asset;
}
/** Explicit recovery for a failed download without refreshing the studio. */
export function retryFrame(template: Template) {
  assets.delete(template.artwork);
  frameAsset(template);
  listeners.forEach((fn) => fn());
}
/** Downloads the other themes one at a time, after the given one is ready, so
 * background loading never slows the frame the customer is looking at. */
export async function preloadFrames(templates: Template[], firstId?: string) {
  const first = templates.find((t) => t.id === firstId) ?? templates[0];
  if (!first) return;
  await framesSettled([first]);
  for (const t of templates) if (t !== first) await framesSettled([t]);
}
/** Resolves once every current theme's artwork has loaded (or failed). */
export function framesSettled(templates: Template[]) {
  const pending = templates.map((t) => frameAsset(t, false));
  return new Promise<void>((resolve) => {
    const check = () => {
      if (pending.every((asset) => asset.status !== "loading")) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = subscribeFrames(check);
    check();
  });
}
