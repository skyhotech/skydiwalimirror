import { describe, it, expect } from "vitest";
import { expressionDisplacement } from "./expression";
describe("local facial expression warp", () => {
  it("keeps Natural and zero intensity unchanged", () => {
    expect(expressionDisplacement(0.3, 0.5, "natural", 1)).toEqual({
      x: 0,
      y: 0,
    });
    for (const effect of ["smile"] as const) {
      const d = expressionDisplacement(0.3, 0.4, effect, 0);
      expect(Math.abs(d.x) + Math.abs(d.y)).toBe(0);
    }
  });
  it("anchors patch edges to prevent visible boundary movement", () => {
    for (const effect of ["smile"] as const)
      for (const [u, v] of [
        [0, 0.5],
        [1, 0.5],
        [0.5, 0],
        [0.5, 1],
      ]) {
        const d = expressionDisplacement(u, v, effect, 1);
        expect(Math.abs(d.x)).toBeLessThan(1e-10);
        expect(Math.abs(d.y)).toBeLessThan(1e-10);
      }
  });
  it("raises both mouth sides for a smile", () => {
    expect(expressionDisplacement(0.3, 0.5, "smile", 1).y).toBeLessThan(0);
    expect(expressionDisplacement(0.7, 0.5, "smile", 1).y).toBeLessThan(0);
  });
});
