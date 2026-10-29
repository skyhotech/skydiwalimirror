import { test, expect, type Page } from "@playwright/test";
async function mockCamera(page: Page, rearUnavailable = false) {
  await page.route("**/ai/**", (r) => r.abort());
  await page.addInitScript(
    ({ rearUnavailable }) => {
      const calls: string[] = [],
        stops: string[] = [];
      Object.assign(window, { cameraCalls: calls, cameraStops: stops });
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: ShareData) => {
          Object.assign(window, {
            defaultSkyShare: { text: data.text, files: data.files?.length },
          });
        },
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async (constraints: MediaStreamConstraints) => {
          const video = constraints.video as MediaTrackConstraints;
          const exact =
            typeof video.facingMode === "object"
              ? (video.facingMode as ConstrainDOMStringParameters).exact
              : undefined;
          const facing = exact === "environment" ? "environment" : "user";
          calls.push(JSON.stringify(constraints));
          if (rearUnavailable && facing === "environment")
            throw new DOMException("No rear camera", "OverconstrainedError");
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = 480;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = facing === "user" ? "#788e85" : "#9d6354";
          ctx.fillRect(0, 0, 640, 480);
          const stream = c.captureStream(10),
            track = stream.getVideoTracks()[0],
            stop = track.stop.bind(track);
          track.stop = () => {
            stops.push(facing);
            stop();
          };
          track.getSettings = () => ({ facingMode: facing });
          return stream;
        },
      });
    },
    { rearUnavailable },
  );
}
async function takeSelfie(page: Page) {
  await page.goto("/");
  await expect(
    page
      .locator(".camera-stage")
      .getByRole("button", { name: "Post on Instagram", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Post on Instagram", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    }),
  ).toBeEnabled();
}
test("rear camera appears in the small product box, then captures and shares", async ({
  page,
}) => {
  await mockCamera(page);
  await takeSelfie(page);
  await expect(page.locator(".camera-stage canvas")).toHaveAttribute(
    "aria-label",
    /with your selfie/,
  );
  await expect(page.locator("video.product-video")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".camera-stage canvas")
        .evaluate((c) =>
          Array.from(
            (c as HTMLCanvasElement)
              .getContext("2d")!
              .getImageData(270, 670, 1, 1).data,
          ).slice(0, 3),
        ),
    )
    .toEqual([157, 99, 84]);
  const camera = await page.evaluate(() => ({
    calls: (window as unknown as { cameraCalls: string[] }).cameraCalls,
    stops: (window as unknown as { cameraStops: string[] }).cameraStops,
  }));
  expect(camera.calls.some((c) => c.includes('"exact":"environment"'))).toBe(
    true,
  );
  expect(camera.stops).toContain("user");
  await page
    .getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Your SKY Instagram caption" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { defaultSkyShare?: unknown }).defaultSkyShare,
      ),
    )
    .toMatchObject({
      files: 1,
      text: expect.stringContaining("@skymobileindia"),
    });
  await page.getByRole("button", { name: "Edit poster", exact: true }).click();
  await page
    .getByRole("button", { name: "Festive Celebration", exact: true })
    .click();
  await page.getByRole("button", { name: "Generate my poster" }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Poster" }).click();
  const file = await dl,
    fs = await import("node:fs/promises"),
    bytes = await fs.readFile((await file.path())!);
  expect(bytes.readUInt32BE(16)).toBe(1080);
  expect(bytes.readUInt32BE(20)).toBe(1920);
});
test("product camera automatically falls back to front camera", async ({
  page,
}) => {
  await mockCamera(page, true);
  await takeSelfie(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Using the front camera" }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { cameraCalls: string[] }).cameraCalls,
  );
  const rear = calls.findIndex((c) => c.includes('"exact":"environment"'));
  expect(rear).toBeGreaterThanOrEqual(0);
  expect(calls.slice(rear + 1).some((c) => c.includes('"ideal":"user"'))).toBe(
    true,
  );
  await page
    .getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Your SKY Instagram caption" }),
  ).toBeVisible();
});
test("filter controls, uploads and flip controls are absent", async ({
  page,
}) => {
  await mockCamera(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: "Post on Instagram",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: /Smile filter|Smile to capture|Upload photo|Flip camera/,
    }),
  ).toHaveCount(0);
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Expression intensity" }),
  ).toHaveCount(0);
});
test("permission denial offers retry without upload or flip suggestions", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText(/Camera permission was denied/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry camera" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Post on Instagram",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByText(/upload a photo|Flip camera/i)).toHaveCount(0);
});
test("canvas expression effects change the mouth pixels and preserve natural output", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/expression.ts";
    const { applyExpression } = await import(modulePath);
    const source = document.createElement("canvas");
    source.width = 180;
    source.height = 240;
    const ctx = source.getContext("2d")!;
    for (let y = 0; y < 240; y++) {
      ctx.fillStyle = `rgb(${y % 255},${(y * 3) % 255},${(y * 7) % 255})`;
      ctx.fillRect(0, y, 180, 1);
    }
    const out = document.createElement("canvas");
    out.width = 180;
    out.height = 240;
    const output = out.getContext("2d")!;
    const points = Array.from({ length: 292 }, () => ({ x: 0.5, y: 0.5 }));
    points[61] = { x: 0.35, y: 0.6 };
    points[291] = { x: 0.65, y: 0.6 };
    points[13] = { x: 0.5, y: 0.58 };
    points[14] = { x: 0.5, y: 0.62 };
    const baseline = ctx.getImageData(0, 0, 180, 240).data;
    applyExpression(output, source, points, "natural", 1);
    const natural = output.getImageData(0, 0, 180, 240).data;
    const unchanged = baseline.every((v, i) => v === natural[i]);
    applyExpression(output, source, points, "smile", 1);
    const effect = output.getImageData(0, 0, 180, 240).data;
    let changed = 0;
    for (let i = 0; i < baseline.length; i++)
      if (baseline[i] !== effect[i]) changed++;
    const outsideUnchanged = baseline
      .slice(0, 180 * 40 * 4)
      .every((v, i) => v === effect[i]);
    return { unchanged, changed, outsideUnchanged };
  });
  expect(result.unchanged).toBe(true);
  expect(result.changed).toBeGreaterThan(100);
  expect(result.outsideUnchanged).toBe(true);
});

test("both bundled original frames load without any upload prompt", async ({
  page,
}) => {
  await page.goto("/");
  for (const [name, path] of [
    ["Golden Mirror", "2.jpeg"],
    ["Festive Celebration", "1.jpeg"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("img", { name: new RegExp(name + " poster preview") }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async (file) => {
          const image = new Image();
          image.src = "/frames/" + file;
          await image.decode();
          return [image.naturalWidth, image.naturalHeight];
        }, path),
      )
      .toEqual([900, 1600]);
    await expect(
      page.getByRole("button", { name: "Add frame image" }),
    ).toHaveCount(0);
  }
});

test("portrait blurs and warms background while preserving a sharp person", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/lib/portrait.ts";
    const { createPortraitRenderer } = await import(path);
    const render = createPortraitRenderer();
    const source = document.createElement("canvas");
    source.width = 240;
    source.height = 320;
    const sx = source.getContext("2d")!;
    for (let x = 0; x < 240; x++) {
      sx.fillStyle = x % 2 ? "#f0f0f0" : "#202020";
      sx.fillRect(x, 0, 1, 320);
    }
    const mask = document.createElement("canvas");
    mask.width = 240;
    mask.height = 320;
    const mx = mask.getContext("2d")!;
    mx.fillStyle = "#fff";
    mx.fillRect(80, 0, 80, 320);
    const out = document.createElement("canvas");
    out.width = 240;
    out.height = 320;
    const ctx = out.getContext("2d")!;
    render(ctx, source, mask);
    const baseline = sx.getImageData(0, 0, 240, 320).data,
      effect = ctx.getImageData(0, 0, 240, 320).data;
    let personUnchanged = true,
      backgroundDifference = 0;
    for (let y = 50; y < 270; y++)
      for (let x = 0; x < 240; x++) {
        const i = (y * 240 + x) * 4;
        if (x > 95 && x < 145)
          for (let c = 0; c < 3; c++)
            if (effect[i + c] !== baseline[i + c]) personUnchanged = false;
        if (x > 20 && x < 60)
          backgroundDifference += Math.abs(effect[i] - baseline[i]);
      }
    const pixel = (x: number, y: number) =>
      Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    const warm = pixel(21, 40);
    render(ctx, source, null);
    const unmasked = ctx.getImageData(0, 0, 240, 320).data;
    return {
      personUnchanged,
      backgroundDifference,
      warm,
      withoutMaskUnchanged: baseline.every((v, i) => v === unmasked[i]),
    };
  });
  expect(result.personUnchanged).toBe(true);
  expect(result.backgroundDifference).toBeGreaterThan(10000);
  expect(result.warm[0]).toBeGreaterThan(result.warm[2]);
  expect(result.withoutMaskUnchanged).toBe(true);
});

test("Post on Instagram shares the completed poster with generated SKY caption", async ({
  page,
}) => {
  await mockCamera(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { copiedSkyCaption: text });
        },
      },
    });
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "share", {
      value: async (data: ShareData) => {
        const bytes = new Uint8Array(await data.files![0].arrayBuffer());
        Object.assign(window, {
          skyShare: {
            text: data.text,
            files: data.files!.length,
            type: data.files![0].type,
            width: new DataView(bytes.buffer).getUint32(16),
            height: new DataView(bytes.buffer).getUint32(20),
          },
        });
      },
    });
  });
  await takeSelfie(page);
  await page
    .getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { skyShare?: unknown }).skyShare,
      ),
    )
    .toMatchObject({
      files: 1,
      type: "image/png",
      width: 1080,
      height: 1920,
      text: expect.stringContaining("@skymobileindia"),
    });
  await expect(
    page.getByRole("textbox", { name: "Your SKY Instagram caption" }),
  ).toHaveValue(/#DiwaliWithSKY/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { copiedSkyCaption?: string }).copiedSkyCaption,
      ),
    )
    .toContain("SKY Mobile & Electronics");
});

test("Instagram fallback downloads poster and opens Instagram with caption ready", async ({
  page,
  context,
}) => {
  await context.route("https://www.instagram.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>Instagram</title>" }),
  );
  await mockCamera(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: () => false });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    });
  });
  await takeSelfie(page);
  const dl = page.waitForEvent("download"),
    popup = page.waitForEvent("popup");
  await page
    .getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    })
    .click();
  expect((await dl).suggestedFilename()).toContain("SKY-Diwali");
  const instagram = await popup;
  await expect(instagram).toHaveURL("https://www.instagram.com/");
  await instagram.close();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Poster downloaded and Instagram opened" }),
  ).toBeVisible();
});

test("selfie, product photos and generated poster persist locally and can be cleared", async ({
  page,
}) => {
  await mockCamera(page);
  await takeSelfie(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Photos saved on this device" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.locator(".camera-stage canvas")).toHaveAttribute(
    "aria-label",
    /with your selfie/,
  );
  await page
    .getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Photos saved on this device" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open("sky-private-photos", 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const draft = await new Promise<any>((resolve) => {
          const r = db
            .transaction("drafts")
            .objectStore("drafts")
            .get("latest-draft");
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return {
          selfie: draft?.selfie?.blob instanceof Blob,
          product: draft?.products?.[0]?.blob instanceof Blob,
          poster: draft?.poster instanceof Blob,
        };
      }),
    )
    .toEqual({ selfie: true, product: true, poster: true });
  await page.reload();
  await expect(page.locator(".editor-poster canvas")).toHaveAttribute(
    "aria-label",
    /with your selfie and 1 purchased product photos/,
  );
  await expect(
    page.getByRole("button", { name: "Post on Instagram", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Clear saved photos" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "No saved photos on this device" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".camera-stage")).toBeVisible();
  await expect(page.locator(".camera-stage canvas")).not.toHaveAttribute(
    "aria-label",
    /with your selfie/,
  );
  await expect(
    page.getByRole("button", { name: "Clear saved photos" }),
  ).toHaveCount(0);
});
