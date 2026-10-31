import type { Template } from "../templates";
type Asset = {
  image: HTMLImageElement | null;
  status: "loading" | "ready" | "missing";
};
const assets = new Map<string, Asset>();
const listeners = new Set<() => void>();
export function subscribeFrames(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function frameAsset(template: Template): Asset {
  // Keyed by artwork URL so a re-uploaded theme loads its new image.
  const cached = assets.get(template.artwork);
  if (cached) return cached;
  const asset: Asset = { image: null, status: "loading" };
  assets.set(template.artwork, asset);
  const image = new Image();
  image.onload = () => {
    asset.image = image;
    asset.status = "ready";
    listeners.forEach((fn) => fn());
  };
  image.onerror = () => {
    asset.status = "missing";
    listeners.forEach((fn) => fn());
  };
  const remote = /^https?:\/\//.test(template.artwork);
  // Backend artwork may be cross-origin; CORS keeps the export canvas untainted.
  if (remote) image.crossOrigin = "anonymous";
  image.src = remote
    ? template.artwork
    : new URL(import.meta.env.BASE_URL + template.artwork, location.href).href;
  return asset;
}
