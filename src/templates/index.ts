export type Rect = { x: number; y: number; w: number; h: number };
export type Template = {
  id: string;
  name: string;
  subtitle: string;
  bg: string;
  ink: string;
  gold: string;
  accent: string;
  light: boolean;
  arch: boolean;
  selfie: Rect;
  product: Rect;
  logo: Rect;
  heading: { x: number; y: number };
  animation: "quiet";
  fit: "cover";
  artwork: string;
};
// Keep the original coordinates for mirrors already saved in the database.
export const MIRROR_DESIGN_HEIGHT = 1920;
export const DEFAULT_TEMPLATE_ID = "karthigai-deepam";
export const templates: Template[] = [
  {
    id: DEFAULT_TEMPLATE_ID,
    name: "Karthigai Deepam",
    subtitle: "இனிய கார்த்திகை தீபத் திருநாள் நல்வாழ்த்துகள்!",
    bg: "#f7e7cc",
    ink: "#3c2418",
    gold: "#d6a447",
    accent: "#a02b24",
    light: true,
    arch: false,
    selfie: { x: 174, y: 385, w: 732, h: 556 },
    product: { x: 264, y: 1050, w: 552, h: 225 },
    logo: { x: 0, y: 0, w: 0, h: 0 },
    heading: { x: 0, y: 0 },
    animation: "quiet",
    fit: "cover",
    artwork: "frames/karthigai-deepam.webp",
  },
];
// Built-in themes are the offline fallback; the backend replaces them live.
const listeners = new Set<() => void>();
export function subscribeTemplates(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
// Mutates in place so every module holding `templates` sees the new list.
export function replaceTemplates(next: Template[]) {
  if (!Array.isArray(next) || !next.every(isTemplate))
    throw new Error(
      "The frame catalog is invalid. Keeping the current frames.",
    );
  templates.splice(0, templates.length, ...next);
  listeners.forEach((fn) => fn());
}
function isTemplate(value: unknown): value is Template {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (
    !["id", "name", "subtitle", "artwork", "bg", "ink", "gold", "accent"].every(
      (k) => typeof t[k] === "string",
    )
  )
    return false;
  if (
    !t.id ||
    !t.artwork ||
    typeof t.arch !== "boolean" ||
    typeof t.light !== "boolean"
  )
    return false;
  for (const key of ["selfie", "product"]) {
    const r = t[key] as Rect | undefined;
    if (
      !r ||
      ![r.x, r.y, r.w, r.h].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.w < 20 ||
      r.h < 20 ||
      r.x + r.w > 1080 ||
      r.y + r.h > MIRROR_DESIGN_HEIGHT
    )
      return false;
  }
  const artwork = t.artwork as string;
  return (
    !/^\s*(?:javascript|data|blob):/i.test(artwork) && !artwork.startsWith("//")
  );
}
export const getTemplate = (id: string) =>
  templates.find((t) => t.id === id) ?? templates[0];
