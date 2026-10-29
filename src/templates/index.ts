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
// Coordinates use the shared 1080 × 1920 export design space.
export const templates: Template[] = [
  {
    id: "golden",
    name: "Golden Mirror",
    subtitle: "Your supplied gold mirror frame",
    bg: "#17120d",
    ink: "#fff9f0",
    gold: "#d6a447",
    accent: "#d6a447",
    light: false,
    arch: true,
    selfie: { x: 126, y: 115, w: 828, h: 1215 },
    product: { x: 361, y: 1344, w: 620, h: 342 },
    logo: { x: 0, y: 0, w: 0, h: 0 },
    heading: { x: 0, y: 0 },
    animation: "quiet",
    fit: "cover",
    artwork: "frames/2.jpeg",
  },
  {
    id: "celebration",
    name: "Festive Celebration",
    subtitle: "Your supplied fireworks frame",
    bg: "#101426",
    ink: "#fff9f0",
    gold: "#e8bd62",
    accent: "#ed1224",
    light: false,
    arch: true,
    selfie: { x: 207, y: 160, w: 666, h: 1040 },
    product: { x: 344, y: 1253, w: 396, h: 259 },
    logo: { x: 0, y: 0, w: 0, h: 0 },
    heading: { x: 0, y: 0 },
    animation: "quiet",
    fit: "cover",
    artwork: "frames/1.jpeg",
  },
];
export const getTemplate = (id: string) =>
  templates.find((t) => t.id === id) ?? templates[0];
