import { afterEach, describe, expect, it } from "vitest";
import { replaceTemplates, templates } from "./index";
const original = [...templates];
afterEach(() => replaceTemplates(original));
describe("frame catalog validation", () => {
  it("rejects malformed remote data without replacing usable frames", () => {
    for (const value of [
      {},
      [null],
      [{ ...original[0], selfie: { x: 0, y: 0, w: NaN, h: 400 } }],
      [{ ...original[0], product: { x: 0, y: 0, w: 9999, h: 200 } }],
      [{ ...original[0], artwork: "javascript:alert(1)" }],
    ]) {
      expect(() => replaceTemplates(value as typeof templates)).toThrow();
      expect(templates).toEqual(original);
    }
  });
  it("removes all local frames when the server hides every mirror and accepts a restored frame", () => {
    replaceTemplates([]);
    expect(templates).toEqual([]);
    replaceTemplates([{ ...original[0], id: "staff-frame" }]);
    expect(templates[0].id).toBe("staff-frame");
  });
});
