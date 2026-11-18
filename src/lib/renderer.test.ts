import { describe, it, expect } from "vitest";
import { templates, DEFAULT_TEMPLATE_ID } from "../templates";
import { fitPosterArtwork, positionOnArtwork, productRects, WIDTH, HEIGHT } from "./renderer";
describe("poster layout", () => {
  it("fits artwork at its original proportions and scales photo placements with it", () => {
    expect(fitPosterArtwork(1080, 1350)).toEqual({ x: 0, y: 0, w: 1080, h: 1350 });
    const wide = fitPosterArtwork(1500, 750);
    expect(wide).toEqual({ x: 0, y: 405, w: 1080, h: 540 });
    const tall = fitPosterArtwork(600, 1200);
    expect(tall).toEqual({ x: 202.5, y: 0, w: 675, h: 1350 });
    expect(positionOnArtwork({ x: 270, y: 480, w: 540, h: 960 }, tall)).toEqual({
      x: 371.25, y: 337.5, w: 337.5, h: 675,
    });
  });
  it("keeps the large mirror and all purchased products separate", () => {
    expect([WIDTH, HEIGHT]).toEqual([1080, 1350]);
    expect(templates).toHaveLength(4);
    expect(templates[0].id).toBe(DEFAULT_TEMPLATE_ID);
    expect(templates[0].artwork).toBe("frames/karthigai-deepam.webp");
    for (const t of templates) {
      expect(t.selfie.h).toBeGreaterThan(300);
      expect(t.selfie.y + t.selfie.h).toBeLessThan(t.product.y);
      for (let n = 1; n <= 5; n++) {
        const cards = productRects(t.product, n, "gallery");
        expect(cards).toHaveLength(n);
        cards.forEach((r) => {
          expect(r.x).toBeGreaterThanOrEqual(t.product.x);
          expect(r.y).toBeGreaterThanOrEqual(t.product.y);
          expect(r.x + r.w).toBeLessThanOrEqual(
            t.product.x + t.product.w + 0.01,
          );
          expect(r.y + r.h).toBeLessThanOrEqual(
            t.product.y + t.product.h + 0.01,
          );
        });
      }
    }
  });
});
