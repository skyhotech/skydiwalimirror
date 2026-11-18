import { test, expect, type Page } from "@playwright/test";

// All traffic remains local and all API writes are intercepted.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await page.route("**/ai/**", (r) => r.abort());
  await page.route("**/api/customers/link/**", (r) =>
    r.fulfill({
      json: {
        phone: "9845012345",
        reward: "power-bank",
        items: [],
        next: "camera",
        video_review: true,
        poster: null,
      },
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("sky-customer-phone", "9845012345");
    const state = {
      calls: 0,
      tracks: [] as MediaStreamTrack[],
      pending: [] as (() => void)[],
      delay: false,
      denied: false,
    };
    Object.assign(window, { cameraTest: state });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        state.calls++;
        if (state.denied) throw new DOMException("Denied", "NotAllowedError");
        if (state.delay)
          await new Promise<void>((resolve) => state.pending.push(resolve));
        const c = document.createElement("canvas");
        c.width = 640;
        c.height = 480;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#809080";
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 200, 200);
        const stream = c.captureStream(10);
        state.tracks.push(...stream.getTracks());
        return stream;
      },
    });
  });
});

async function ready(page: Page) {
  await expect(
    page.getByRole("button", { name: "Post on Instagram", exact: true }),
  ).toBeEnabled();
}
async function hidden(page: Page, value: boolean) {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: hidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}
const liveTracks = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).cameraTest.tracks.filter(
        (t: MediaStreamTrack) => t.readyState === "live",
      ).length,
  );

test("late camera permission result cannot restart a hidden camera", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).cameraTest.delay = true;
  });
  await page.goto("/?spin=reliability-token");
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraTest.pending.length))
    .toBeGreaterThan(0);
  await hidden(page, true);
  await page.evaluate(() => {
    for (const resolve of (window as any).cameraTest.pending) resolve();
  });
  await expect.poll(liveTracks.bind(null, page)).toBe(0);
  await expect(
    page.getByRole("button", { name: "Post on Instagram", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).cameraTest.delay = false;
  });
  await hidden(page, false);
  await ready(page);
  await expect.poll(liveTracks.bind(null, page)).toBe(1);
});

test("permission denial waits for an explicit retry", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    (window as any).cameraTest.denied = true;
  });
  await page.goto("/?spin=reliability-token");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  const calls = await page.evaluate(() => (window as any).cameraTest.calls);
  await page.clock.fastForward(12_000);
  expect(await page.evaluate(() => (window as any).cameraTest.calls)).toBe(
    calls,
  );
  await page.clock.resume();
  await page.evaluate(() => {
    (window as any).cameraTest.denied = false;
  });
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await ready(page);
});

test("device interruption disables capture and offers recovery", async ({
  page,
}) => {
  await page.goto("/?spin=reliability-token");
  await ready(page);
  await page.evaluate(() => {
    const track = (window as any).cameraTest.tracks.find(
      (t: MediaStreamTrack) => t.readyState === "live",
    );
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await expect(
    page.getByRole("button", { name: "Post on Instagram", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await ready(page);
});

test("twelve pause/resume cycles release every previous stream", async ({
  page,
}) => {
  await page.goto("/?spin=reliability-token");
  await ready(page);
  for (let i = 0; i < 12; i++) {
    await page.getByRole("button", { name: "Pause camera" }).click();
    await expect.poll(liveTracks.bind(null, page)).toBe(0);
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.srcObject === null),
    ).toBe(true);
    await page.getByRole("button", { name: "Resume camera" }).click();
    await ready(page);
    await expect.poll(liveTracks.bind(null, page)).toBe(1);
  }
});

test("rejected captures release their object URLs", async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    const urls = new Set<string>();
    Object.assign(window, { photoUrls: urls });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if (args[0] instanceof HTMLVideoElement) {
        this.fillStyle = "black";
        this.fillRect(0, 0, this.canvas.width, this.canvas.height);
        return;
      }
      return (draw as any).apply(this, args);
    };
  });
  await page.goto("/?spin=reliability-token");
  await ready(page);
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", { name: "Post on Instagram", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "looks blank" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).photoUrls.size))
      .toBe(0);
  }
});

test("manual capture works when optional face and gesture models fail", async ({
  page,
}) => {
  await page.route("**/*mediapipe_tasks-vision*", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
    export const FilesetResolver = { forVisionTasks: async () => ({}) };
    export const FaceLandmarker = { createFromOptions: async () => { throw new Error('missing model'); } };
    export const GestureRecognizer = { createFromOptions: async () => { throw new Error('missing model'); } };
  `,
    }),
  );
  await page.goto("/?spin=reliability-token");
  await ready(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Face detection unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Auto capture/ })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Post on Instagram", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Capture product and post on Instagram",
      exact: true,
    }),
  ).toBeEnabled();
});

test("storage denial is explained without blocking manual photography", async ({
  page,
}) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await page.goto("/?spin=reliability-token");
  await expect(
    page
      .getByRole("alert")
      .filter({
        hasText: /Browser storage unavailable|Photos could not be saved/,
      }),
  ).toBeVisible();
  await ready(page);
});

test("a nonresponsive storage open cannot indefinitely block the camera", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    indexedDB.open = () => ({}) as IDBOpenDBRequest;
  });
  await page.goto("/?spin=reliability-token", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("Opening your saved studio…")).toBeVisible();
  await page.clock.fastForward(10_001);
  await page.clock.resume();
  await expect(
    page
      .getByRole("alert")
      .filter({
        hasText: /Browser storage unavailable|Photos could not be saved/,
      }),
  ).toBeVisible();
  await ready(page);
});
