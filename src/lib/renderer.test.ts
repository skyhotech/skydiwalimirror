import { describe, it, expect } from "vitest";
import { templates } from "../templates";
import { productRects } from "./renderer";
describe("poster layout", () => {
  it("keeps the large mirror and all purchased products separate", () => {
    expect(templates).toHaveLength(2);
    for (const t of templates) {
      expect(t.selfie.h).toBeGreaterThan(1000);
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
