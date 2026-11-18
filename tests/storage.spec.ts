import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await page.goto("/");
});

test("a request that succeeds but later aborts is never reported as committed", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const module = "/src/lib/indexedDb.ts";
    const { committedRequest } = await import(module);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("commit-regression", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("items");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    let rejected = false;
    try {
      await committedRequest(
        db,
        "items",
        "readwrite",
        (store: IDBObjectStore) => {
          const request = store.put("photo", "key");
          request.addEventListener("success", () =>
            request.transaction!.abort(),
          );
          return request;
        },
      );
    } catch {
      rejected = true;
    }
    const saved = await committedRequest(
      db,
      "items",
      "readonly",
      (s: IDBObjectStore) => s.get("key"),
    );
    db.close();
    return { rejected, saved: saved ?? null };
  });
  expect(result).toEqual({ rejected: true, saved: null });
});

test("a newer export survives acknowledgement of an older upload", async ({
  page,
}) => {
  const bodies: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/customers/", async (r) => {
    bodies.push(r.request().postData() ?? "");
    if (bodies.length === 1) await gate;
    await r.fulfill({ status: 201, json: { id: 1 } });
  });
  const first = page.evaluate(async () => {
    const module = "/src/lib/backend.ts";
    const api = await import(module);
    await api.uploadCustomer({
      session: "same",
      mirror: "dream",
      poster: new Blob(["first"], { type: "image/jpeg" }),
    });
  });
  await expect.poll(() => bodies.length).toBe(1);
  await page.evaluate(async () => {
    const module = "/src/lib/backend.ts";
    const api = await import(module);
    await api.uploadCustomer({
      session: "same",
      mirror: "dream",
      poster: new Blob(["second"], { type: "image/jpeg" }),
    });
  });
  release();
  await first;
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain("first");
  expect(bodies[1]).toContain("second");
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/backend.ts";
      return (await import(module)).getUploadState();
    }),
  ).toBe("saved");
});

test("invalid uploads are retained without automatic retry and a corrected export recovers", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/customers/", (r) => {
    calls++;
    return r.fulfill({ status: calls === 1 ? 400 : 201, json: {} });
  });
  const failed = await page.evaluate(async () => {
    const module = "/src/lib/backend.ts",
      api = await import(module);
    await api.uploadCustomer({
      session: "invalid",
      mirror: "dream",
      poster: new Blob(["bad"]),
    });
    await api.flushUploads();
    return api.getUploadState();
  });
  expect(failed).toBe("failed");
  expect(calls).toBe(1);
  const count = await page.evaluate(async () => {
    const open = indexedDB.open("sky-upload-outbox", 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    return new Promise<number>((resolve) => {
      const request = db.transaction("uploads").objectStore("uploads").count();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
    });
  });
  expect(count).toBe(1);
  const recovered = await page.evaluate(async () => {
    const module = "/src/lib/backend.ts",
      api = await import(module);
    await api.uploadCustomer({
      session: "invalid",
      mirror: "dream",
      poster: new Blob(["corrected"]),
    });
    return api.getUploadState();
  });
  expect(recovered).toBe("saved");
  expect(calls).toBe(2);
});

test("a stalled upload times out while its durable copy remains queued", async ({
  page,
}) => {
  await page.route("**/api/customers/", () => {});
  const state = await page.evaluate(async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => timeout(ms === 45_000 ? 30 : ms);
    const module = "/src/lib/backend.ts",
      api = await import(module);
    await api.uploadCustomer({
      session: "timeout",
      mirror: "dream",
      poster: new Blob(["photo"]),
    });
    return api.getUploadState();
  });
  expect(state).toBe("retrying");
});

test("failed frame downloads can be retried without refreshing", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/frames/retry.jpeg", (r) => {
    calls++;
    return calls === 1
      ? r.abort()
      : r.fulfill({ path: "public/frames/0.jpeg", contentType: "image/jpeg" });
  });
  await page.evaluate(async () => {
    const path = "/src/lib/frameAssets.ts",
      catalog = "/src/templates/index.ts";
    const assets = await import(path),
      { templates } = await import(catalog);
    const template = {
      ...templates[0],
      id: "retry",
      artwork: "frames/retry.jpeg",
    };
    Object.assign(window, { retryTemplate: template });
    await assets.framesSettled([template]);
    if (assets.frameAsset(template).status !== "missing")
      throw new Error("Failure was not surfaced");
    assets.retryFrame(template);
    await assets.framesSettled([template]);
    if (assets.frameAsset(template).status !== "ready")
      throw new Error("Retry did not recover");
  });
  expect(calls).toBe(2);
});

test("cancelling a queued spin prevents further requests", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/customers/spin/", (r) => {
    calls++;
    return r.fulfill({
      status: 503,
      json: {},
      headers: { "Retry-After": "10" },
    });
  });
  const result = await page.evaluate(async () => {
    const path = "/src/lib/backend.ts",
      api = await import(path);
    const controller = new AbortController();
    try {
      await api.spinPrize(
        "storage-token",
        (queued: boolean) => {
          if (queued) controller.abort();
        },
        controller.signal,
      );
      return "unexpected success";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(result).toBe("Spin cancelled.");
  expect(calls).toBe(1);
});

test("registration remains usable without native AbortSignal.any", async ({
  page,
}) => {
  await page.route("**/api/customers/profile/", (r) =>
    r.fulfill({ json: { handle: "sky.customer" } }),
  );
  const customer = await page.evaluate(async () => {
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });
    const path = "/src/lib/backend.ts";
    return (await import(path)).saveProfile(
      "storage-token",
      "instagram",
      "sky.customer",
    );
  });
  expect(customer).toEqual({ handle: "sky.customer" });
});

test("outbox read failure leaves an actionable state instead of Saving", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/lib/backend.ts",
      api = await import(path);
    const read = IDBObjectStore.prototype.getAllKeys;
    IDBObjectStore.prototype.getAllKeys = function (...args) {
      if (this.name === "uploads")
        throw new DOMException("Injected storage failure", "SecurityError");
      return read.apply(this, args);
    };
    try {
      await api.uploadCustomer({
        session: "read-failure",
        mirror: "dream",
        poster: new Blob(["photo"]),
      });
      return api.getUploadState();
    } finally {
      IDBObjectStore.prototype.getAllKeys = read;
    }
  });
  expect(result).toBe("failed");
});

test("custom frame bounds, changed bounds and transparent artwork preserve the selfie", async ({
  page,
}) => {
  const gray = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 20;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgb(120,120,120)";
    ctx.fillRect(0, 0, 20, 20);
    const gray = c.toDataURL("image/png").split(",")[1];
    ctx.clearRect(0, 0, 20, 20);
    return { gray, transparent: c.toDataURL("image/png").split(",")[1] };
  });
  await page.route("**/frames/mask-test.png", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from(gray.gray, "base64"),
    }),
  );
  await page.route("**/frames/transparent-test.png", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from(gray.transparent, "base64"),
    }),
  );
  const pixels = await page.evaluate(async () => {
    const rendererPath = "/src/lib/renderer.ts",
      assetsPath = "/src/lib/frameAssets.ts",
      catalogPath = "/src/templates/index.ts";
    const { renderPoster, HEIGHT } = await import(rendererPath),
      assets = await import(assetsPath),
      { templates } = await import(catalogPath);
    const template = {
      ...templates[0],
      id: "custom",
      artwork: "frames/mask-test.png",
      arch: false,
      selfie: { x: 40, y: 900, w: 200, h: 300 },
    };
    await assets.framesSettled([template]);
    const red = document.createElement("canvas");
    red.width = red.height = 20;
    const redCtx = red.getContext("2d")!;
    redCtx.fillStyle = "red";
    redCtx.fillRect(0, 0, 20, 20);
    const image = new Image();
    image.src = red.toDataURL();
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d")!;
    const state = {
      template,
      selfie: { image, adjust: { x: 0, y: 0, zoom: 1 } },
      products: [],
      logo: null,
      layout: "card",
    };
    renderPoster(ctx, state);
    const first = Array.from(ctx.getImageData(140, 703, 1, 1).data);
    state.template = {
      ...template,
      selfie: { x: 700, y: 800, w: 200, h: 300 },
    };
    renderPoster(ctx, state);
    const old = Array.from(ctx.getImageData(140, 703, 1, 1).data),
      moved = Array.from(ctx.getImageData(800, 633, 1, 1).data);
    state.template = {
      ...state.template,
      artwork: "frames/transparent-test.png",
    };
    await assets.framesSettled([state.template]);
    renderPoster(ctx, state);
    return {
      first,
      old,
      moved,
      transparent: Array.from(ctx.getImageData(800, 633, 1, 1).data),
    };
  });
  expect(pixels).toEqual({
    first: [255, 0, 0, 255],
    old: [120, 120, 120, 255],
    moved: [255, 0, 0, 255],
    transparent: [255, 0, 0, 255],
  });
});
