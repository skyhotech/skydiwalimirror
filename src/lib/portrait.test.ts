import { describe, it, expect } from "vitest";
import {
  PORTRAIT_BLUR_STRENGTH,
  portraitBlurRadius,
  foregroundAlpha,
} from "./portrait";
describe("portrait background configuration", () => {
  it("fixes blur strength at twenty percent and scales with image resolution", () => {
    expect(PORTRAIT_BLUR_STRENGTH).toBe(0.2);
    expect(portraitBlurRadius(1080, 1920)).toBeCloseTo(4.8);
    expect(portraitBlurRadius(540, 960)).toBeCloseTo(2.4);
  });
  it("keeps confident person pixels opaque and background transparent with soft boundaries", () => {
    expect(foregroundAlpha(1)).toBe(255);
    expect(foregroundAlpha(0)).toBe(0);
    expect(foregroundAlpha(0.5)).toBeGreaterThan(100);
    expect(foregroundAlpha(0.5)).toBeLessThan(155);
  });
});
