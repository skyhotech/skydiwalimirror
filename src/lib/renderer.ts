import type { Template, Rect } from "../templates";
import type { Photo, Layout } from "./store";
import { frameAsset } from "./frameAssets";
export const WIDTH = 1080,
  HEIGHT = 1920;
type Source = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
function size(source: Source) {
  return source instanceof HTMLVideoElement
    ? [source.videoWidth, source.videoHeight]
    : source instanceof HTMLCanvasElement
      ? [source.width, source.height]
      : [source.naturalWidth, source.naturalHeight];
}
function rounded(ctx: CanvasRenderingContext2D, r: Rect, radius = 20) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}
export function imageIn(
  ctx: CanvasRenderingContext2D,
  source: Source,
  r: Rect,
  adjust = { x: 0, y: 0, zoom: 1 },
  fit: "cover" | "contain" = "cover",
  mirror = false,
) {
  const [w, h] = size(source);
  if (!w || !h) return;
  const scale =
    (fit === "cover"
      ? Math.max(r.w / w, r.h / h)
      : Math.min(r.w / w, r.h / h)) * adjust.zoom;
  const dw = w * scale,
    dh = h * scale;
  ctx.save();
  rounded(ctx, r, 24);
  ctx.clip();
  ctx.translate(
    r.x + r.w / 2 + (adjust.x * r.w) / 2,
    r.y + r.h / 2 + (adjust.y * r.h) / 2,
  );
  if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
export function productRects(
  region: Rect,
  count: number,
  layout: Layout,
): Rect[] {
  if (!count) return [];
  const cols = count <= 3 ? count : 3;
  const rows = count > 3 ? 2 : 1;
  const gap = 20;
  const w = (region.w - gap * (cols - 1)) / cols,
    h = (region.h - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / cols),
      inRow = Math.min(cols, count - row * cols);
    return {
      x:
        region.x +
        (region.w - (inRow * w + (inRow - 1) * gap)) / 2 +
        (i % cols) * (w + gap),
      y: region.y + row * (h + gap),
      w,
      h: layout === "spotlight" && count === 1 ? region.h : h,
    };
  });
}
export type Composition = {
  template: Template;
  selfie: Photo | null;
  products: Photo[];
  logo: Photo | null;
  layout: Layout;
  video?: HTMLVideoElement | HTMLCanvasElement;
  mirror?: boolean;
  productVideo?: HTMLVideoElement;
};
// Mirror contours are calibrated to the two supplied 900 × 1600 posters.
function mirrorPath(ctx: CanvasRenderingContext2D, t: Template) {
  ctx.beginPath();
  if (t.id === "dream") {
    ctx.moveTo(236, 1115);
    ctx.lineTo(236, 730);
    ctx.lineTo(184, 730);
    ctx.lineTo(184, 350);
    ctx.quadraticCurveTo(184, 230, 330, 165);
    ctx.quadraticCurveTo(540, 120, 750, 165);
    ctx.quadraticCurveTo(896, 230, 896, 350);
    ctx.lineTo(896, 730);
    ctx.lineTo(833, 730);
    ctx.lineTo(833, 1115);
    ctx.closePath();
  } else if (t.id === "golden") {
    ctx.moveTo(128, 1330);
    ctx.lineTo(128, 280);
    ctx.quadraticCurveTo(128, 120, 305, 115);
    ctx.lineTo(775, 115);
    ctx.quadraticCurveTo(952, 120, 952, 280);
    ctx.lineTo(952, 1330);
    ctx.closePath();
  } else {
    ctx.moveTo(207, 1200);
    ctx.lineTo(207, 340);
    ctx.bezierCurveTo(207, 210, 280, 145, 390, 150);
    ctx.quadraticCurveTo(540, 45, 690, 150);
    ctx.bezierCurveTo(800, 145, 873, 210, 873, 340);
    ctx.lineTo(873, 1200);
    ctx.closePath();
  }
}
const overlays = new Map<string, HTMLCanvasElement>();
function artworkOverlay(t: Template, image: HTMLImageElement) {
  const cached = overlays.get(t.id);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = WIDTH;
  c.height = HEIGHT;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(image, 0, 0, WIDTH, HEIGHT);
  // Remove the neutral mirror surface while retaining the original coloured artwork.
  // Preserve the logo, camera badges, bright typography and warm decorative lights.
  const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const mask = document.createElement("canvas");
  mask.width = WIDTH;
  mask.height = HEIGHT;
  const m = mask.getContext("2d")!;
  mirrorPath(m, t);
  m.fill();
  const clip = m.getImageData(0, 0, WIDTH, HEIGHT).data;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      if (!clip[i + 3]) continue;
      const logo = ((x - 540) / 155) ** 2 + ((y - 144) / 158) ** 2 < 1;
      const cameraBadge =
        t.id === "golden"
          ? ((x - 94) / 65) ** 2 + ((y - 431) / 49) ** 2 < 1
          : ((x - 110) / 60) ** 2 + ((y - 568) / 43) ** 2 < 1;
      const lantern =
        t.id === "dream" &&
        [270, 804].some(
          (cx) => ((x - cx) / 48) ** 2 + ((y - 289) / 85) ** 2 < 1,
        );
      if (logo || (t.id !== "dream" && cameraBadge) || lantern) continue;
      const r = pixels.data[i],
        g = pixels.data[i + 1],
        b = pixels.data[i + 2],
        max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      const saturation = max ? (max - min) / max : 0;
      // Gray mirror pixels become transparent; warm frame lights and gold stay in front.
      const removal =
        Math.max(0, Math.min(1, (0.32 - saturation) / 0.09)) *
        (t.id === "dream" ? 1 : Math.max(0, Math.min(1, (220 - max) / 20))) *
        Math.max(0, Math.min(1, (min - 35) / 20));
      pixels.data[i + 3] = Math.round(
        255 * (1 - (removal * clip[i + 3]) / 255),
      );
    }
  ctx.putImageData(pixels, 0, 0);
  overlays.set(t.id, c);
  return c;
}
export function renderPoster(
  ctx: CanvasRenderingContext2D,
  state: Composition,
) {
  const { template: t, selfie, products, layout, video, mirror } = state;
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const asset = frameAsset(t);
  if (asset.image) ctx.drawImage(asset.image, 0, 0, WIDTH, HEIGHT);
  ctx.save();
  mirrorPath(ctx, t);
  ctx.clip();
  if (video && (!(video instanceof HTMLVideoElement) || video.readyState >= 2))
    imageIn(ctx, video, t.selfie, undefined, "cover", mirror);
  else if (selfie) imageIn(ctx, selfie.image, t.selfie, selfie.adjust, "cover");
  ctx.restore();
  if (asset.image) ctx.drawImage(artworkOverlay(t, asset.image), 0, 0);
  if (products.length) {
    ctx.save();
    rounded(ctx, t.product, 24);
    ctx.clip();
    ctx.fillStyle = t.id === "golden" ? "#f6ebda" : "#29231f";
    ctx.fillRect(t.product.x, t.product.y, t.product.w, t.product.h);
    const cards = productRects(t.product, products.length, layout);
    products.forEach((p, i) => {
      const r = cards[i];
      imageIn(
        ctx,
        p.image,
        { x: r.x + 8, y: r.y + 8, w: r.w - 16, h: r.h - 16 },
        p.adjust,
        "contain",
      );
    });
    ctx.restore();
  }
  if (state.productVideo && state.productVideo.readyState >= 2) {
    ctx.save();
    rounded(ctx, t.product, 24);
    ctx.clip();
    ctx.fillStyle = "#171410";
    ctx.fillRect(t.product.x, t.product.y, t.product.w, t.product.h);
    imageIn(
      ctx,
      state.productVideo,
      {
        x: t.product.x + 8,
        y: t.product.y + 8,
        w: t.product.w - 16,
        h: t.product.h - 16,
      },
      undefined,
      "contain",
      false,
    );
    ctx.restore();
  }
  if (!asset.image) {
    ctx.fillStyle = "#fff4dc";
    ctx.textAlign = "center";
    ctx.font = "32px Arial";
    ctx.fillText(
      asset.status === "loading"
        ? "Loading your frame…"
        : "Frame artwork not installed",
      WIDTH / 2,
      HEIGHT / 2,
    );
    ctx.font = "22px Arial";
    ctx.fillText(t.name, WIDTH / 2, HEIGHT / 2 + 45);
  }
}
