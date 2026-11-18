import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
test("updated gift artwork replaces the decoded image for the same gift", async () => {
  class FakeImage {
    dataset: Record<string, string> = {};
    crossOrigin = "";
    src = "";
    complete = true;
    naturalWidth = 10;
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("")),
  );
  const { setWheel, wheelItems, rewardImage } = await import("./rewards");
  setWheel([
    { id: "custom", label: "Custom gift", image: "/media/gift-v1.png" },
  ]);
  const first = rewardImage(wheelItems()[0]);
  setWheel([
    { id: "custom", label: "Custom gift", image: "/media/gift-v2.png" },
  ]);
  const second = rewardImage(wheelItems()[0]);
  expect(second).not.toBe(first);
  expect(second?.src).toContain("gift-v2.png");
});
