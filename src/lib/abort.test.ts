import { describe, expect, it, vi } from "vitest";
import { combineSignals } from "./abort";

describe("request cancellation compatibility", () => {
  it("propagates an already-aborted request", () => {
    const request = new AbortController();
    request.abort("cancelled");
    expect(combineSignals([request.signal]).reason).toBe("cancelled");
  });
  it("works without native any() and releases parent listeners after abort", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });
    try {
      const request = new AbortController(),
        deadline = new AbortController();
      const remove = vi.spyOn(deadline.signal, "removeEventListener");
      const combined = combineSignals([request.signal, deadline.signal]);
      request.abort("cancelled");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("cancelled");
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(AbortSignal, "any", descriptor);
    }
  });
});
