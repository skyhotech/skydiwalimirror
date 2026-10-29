export const PORTRAIT_BLUR_STRENGTH = 0.2;
export function portraitBlurRadius(width: number, height: number) {
  return Math.max(
    1,
    (Math.min(width, height) / 1080) * 24 * PORTRAIT_BLUR_STRENGTH,
  );
}
export function foregroundAlpha(confidence: number) {
  const x = Math.max(0, Math.min(1, (confidence - 0.2) / 0.6));
  return Math.round(x * x * (3 - 2 * x) * 255);
}
export function createPortraitRenderer() {
  const foreground = document.createElement("canvas"),
    downsample = document.createElement("canvas"),
    glow = document.createElement("canvas");
  const fg = foreground.getContext("2d")!,
    small = downsample.getContext("2d")!,
    gold = glow.getContext("2d")!;
  function prepare(w: number, h: number) {
    if (foreground.width === w && foreground.height === h) return;
    foreground.width = glow.width = w;
    foreground.height = glow.height = h;
    const lights = [
      [0.08, 0.14, 0.08],
      [0.89, 0.2, 0.065],
      [0.15, 0.52, 0.055],
      [0.91, 0.62, 0.09],
      [0.08, 0.84, 0.075],
      [0.78, 0.91, 0.06],
      [0.63, 0.09, 0.04],
      [0.38, 0.8, 0.035],
    ];
    gold.fillStyle = "rgba(214,164,71,.075)";
    gold.fillRect(0, 0, w, h);
    for (const [x, y, r] of lights) {
      const radius = r * Math.min(w, h),
        gradient = gold.createRadialGradient(
          x * w,
          y * h,
          0,
          x * w,
          y * h,
          radius,
        );
      gradient.addColorStop(0, "rgba(255,229,158,.65)");
      gradient.addColorStop(0.25, "rgba(255,204,104,.32)");
      gradient.addColorStop(1, "rgba(235,160,38,0)");
      gold.fillStyle = gradient;
      gold.fillRect(x * w - radius, y * h - radius, radius * 2, radius * 2);
    }
  }
  return function render(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    mask: HTMLCanvasElement | null,
  ) {
    const w = source.width,
      h = source.height;
    prepare(w, h);
    ctx.clearRect(0, 0, w, h);
    // No mask means no trustworthy person boundary: retain the unmodified photo.
    if (!mask) {
      ctx.drawImage(source, 0, 0);
      return;
    }
    const radius = portraitBlurRadius(w, h);
    const supportsFilter = "filter" in ctx;
    ctx.save();
    if (supportsFilter) ctx.filter = `blur(${radius}px)`;
    if (!supportsFilter || ctx.filter === "none" || !ctx.filter) {
      downsample.width = Math.max(8, Math.round(w / (radius * 2)));
      downsample.height = Math.max(8, Math.round(h / (radius * 2)));
      small.drawImage(source, 0, 0, downsample.width, downsample.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(downsample, 0, 0, w, h);
    } else {
      const pad = radius * 3;
      ctx.drawImage(source, -pad, -pad, w + pad * 2, h + pad * 2);
    }
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(glow, 0, 0);
    ctx.restore();
    fg.clearRect(0, 0, w, h);
    fg.globalCompositeOperation = "source-over";
    fg.drawImage(source, 0, 0);
    fg.globalCompositeOperation = "destination-in";
    fg.imageSmoothingEnabled = true;
    fg.drawImage(mask, 0, 0, w, h);
    fg.globalCompositeOperation = "source-over";
    ctx.drawImage(foreground, 0, 0);
  };
}
