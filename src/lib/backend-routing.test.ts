import { afterEach, expect, it, vi } from "vitest";
import deployment from "../../vercel.json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps Vercel API requests and staff/media rewrites on the confirmed VPS", async () => {
  vi.stubGlobal("location", new URL("https://audit.vercel.app"));
  vi.stubEnv("VITE_API_URL", undefined);
  const backend = await import("./backend");
  expect(backend.API_ORIGIN).toBe("https://87.232.72.141");
  expect(backend.MEDIA_ORIGIN).toBe("");
  for (const rewrite of deployment.rewrites) {
    expect(new URL(rewrite.destination).origin).toBe(backend.API_ORIGIN);
  }
});

it("preserves explicit API origin overrides", async () => {
  vi.stubGlobal("location", new URL("https://audit.vercel.app"));
  vi.stubEnv("VITE_API_URL", "https://staging.example.test/");
  const backend = await import("./backend");
  expect(backend.API_ORIGIN).toBe("https://staging.example.test");
  expect(backend.MEDIA_ORIGIN).toBe(backend.API_ORIGIN);
});

it("preserves same-origin routing outside Vercel", async () => {
  vi.stubGlobal("location", new URL("http://localhost:5173"));
  vi.stubEnv("VITE_API_URL", undefined);
  expect((await import("./backend")).API_ORIGIN).toBe("");
});

it("coalesces duplicate link reads without caching later real visits", async () => {
  vi.stubGlobal("location", new URL("http://localhost:5173/?spin=test-link"));
  const response = {
    phone: "9845012345",
    next: "terms",
    items: [],
    reward: null,
  };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetcher);
  const backend = await import("./backend");
  const [a, b] = await Promise.all([
    backend.fetchLink("test-link"),
    backend.fetchLink("test-link"),
  ]);
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await backend.fetchLink("test-link");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("adds authority to a legacy upload only for the server-confirmed customer", async () => {
  vi.stubGlobal("location", new URL("http://localhost:5173/?spin=valid-link"));
  const forms: FormData[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/customers/link/"))
        return new Response(
          JSON.stringify({
            phone: "9845012345",
            next: "mirror",
            items: [],
            reward: "power-bank",
          }),
        );
      forms.push(init!.body as FormData);
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }),
  );
  const backend = await import("./backend");
  await backend.fetchLink("valid-link");
  await backend.uploadCustomer({
    session: "legacy",
    phone: "9845012345",
    mirror: "dream",
    poster: new Blob(["photo"], { type: "image/jpeg" }),
  });
  expect(forms[0].get("token")).toBe("valid-link");
  await backend.uploadCustomer({
    session: "different",
    phone: "9845022223",
    mirror: "dream",
    poster: new Blob(["photo"], { type: "image/jpeg" }),
  });
  expect(forms[1].get("token")).toBeNull();
});
