import { expect, test } from "vitest";
import { diagnosticUrl } from "./telemetry";

test("drops link tokens, phone queries, fragments and URL credentials", () => {
  expect(
    diagnosticUrl(
      "https://user:password@studio.example/?spin=private-token&phone=9845011111#secret",
    ),
  ).toBe("https://studio.example/");
});
test("redacts customer token paths and private image names", () => {
  expect(
    diagnosticUrl(
      "https://api.example/api/customers/link/private-token/?q=secret",
    ),
  ).toBe("https://api.example/api/customers/link/[redacted]/");
  expect(diagnosticUrl("https://api.example/media/customers/private.jpg")).toBe(
    "https://api.example/media/customers/[image]",
  );
});
test("fails closed for malformed and non-HTTP diagnostic URLs", () => {
  for (const value of ["invalid", "data:secret", "javascript:secret"])
    expect(diagnosticUrl(value)).toBeNull();
});
