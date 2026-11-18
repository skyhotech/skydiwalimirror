import { expect, test } from "@playwright/test";

for (const [entry, selector] of [
  ["/", "#m-name"],
  ["/?spin=sample", "#customer-phone"],
]) {
  test(`connection check alerts on a slow download before ${entry}`, async ({ page }) => {
    let slow = true;
    await page.route("**/frames/karthigai-deepam.webp", async (route) => {
      if (!route.request().headers().range) return route.continue();
      if (slow) await new Promise((resolve) => setTimeout(resolve, 2_150));
      await route.fulfill({
        status: 206,
        contentType: "image/webp",
        body: Buffer.alloc(64 * 1024),
      });
    });
    await page.goto(entry);
    await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Slow internet connection");
    slow = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(selector)).toBeVisible();
  });
}
