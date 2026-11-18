import { expect, test } from "@playwright/test";

test("gift links record the customer journey in the order customers complete it", async ({ page }) => {
  const events: string[] = [];
  await page.route("**/ai/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/customers/link/test-link/")) {
      events.push("link_opened");
      return route.fulfill({ json: {
        name: "Asha", phone: "9845011111", reward: null, items: [
          { id: "mobile-stand", label: "Mobile Stand", image: "" },
        ], next: "terms", instagram_id: "", poster: null,
      } });
    }
    const eventByPath: Record<string, string> = {
      "/api/customers/terms/": "terms_accepted",
      "/api/customers/spin/": "spun",
      "/api/customers/review/": "reviewed",
      "/api/customers/": "poster_saved",
      "/api/customers/profile/": "profile_instagram",
      "/api/customers/whatsapp-proof/": "posted_whatsapp",
      "/api/customers/more-proof/": "more_proof_sent",
      "/api/customers/instagram-proof/": "instagram_proof_sent",
    };
    if (path.endsWith("/customers/event/")) events.push(route.request().postDataJSON().kind);
    else if (eventByPath[path]) events.push(eventByPath[path]);
    else return route.fulfill({ status: 404, json: {} });
    if (path === "/api/customers/") {
      const body = route.request().postData() ?? "";
      expect(body).toContain("test-link");
      expect(body).toContain('name="selfie"');
    }
    return route.fulfill({ json: { reward: "mobile-stand", handle: "asha.test", ok: true } });
  });

  await page.addInitScript(() => {
    Object.assign(window, { skyFakeCue: { smile: 0, gesture: "" } });
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#e5ae80";
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = "#543326";
      ctx.fillRect(0, 0, 250, 220);
      return canvas.captureStream(10);
    };
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "share", { value: async () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    } });
  });

  await page.goto("/?spin=test-link");
  await page.getByLabel("I accept the terms and conditions").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Tap to spin" }).click();
  await page.getByRole("radio", { name: "5 stars", exact: true }).click({ timeout: 15_000 });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("button", { name: "Take selfie", exact: true }).click();
  await page.getByRole("button", { name: "Capture product", exact: true }).click();
  await page.getByLabel("Instagram ID", { exact: true }).fill("asha.test");
  await page.getByRole("button", { name: "Continue to sharing" }).click();

  const proof = { name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from("mock screenshot") };
  await page.getByRole("button", { name: "Share on WhatsApp" }).click();
  await expect.poll(() => events.at(-1)).toBe("returned_whatsapp");
  await page.getByLabel("Upload WhatsApp Status screenshot").setInputFiles(proof);
  await expect.poll(() => events.at(-1)).toBe("posted_whatsapp");
  await page.getByRole("button", { name: "Share on WhatsApp" }).click();
  await expect.poll(() => events.at(-1)).toBe("returned_whatsapp");
  await page.getByRole("button", { name: "Open share sheet" }).click();
  await page.getByLabel("Upload a share screenshot (other app)").setInputFiles(proof);
  await expect.poll(() => events.at(-1)).toBe("more_proof_sent");
  await page.getByRole("button", { name: "Open share sheet" }).click();
  await page.getByRole("button", { name: "Share on Instagram" }).click();
  await expect.poll(() => events.at(-1)).toBe("returned_instagram");
  await page.getByLabel("Upload Instagram post screenshot").setInputFiles(proof);
  await expect.poll(() => events.at(-1)).toBe("instagram_proof_sent");

  expect(events).toEqual([
    "link_opened", "terms_accepted", "spun", "reviewed", "poster_saved", "profile_instagram",
    "share_opened_whatsapp", "shared_whatsapp", "returned_whatsapp", "posted_whatsapp",
    "share_opened_whatsapp", "shared_whatsapp", "returned_whatsapp",
    "share_opened_more", "more_proof_sent", "share_opened_more",
    "share_opened_instagram", "shared_instagram", "returned_instagram", "instagram_proof_sent",
  ]);
});
