import { test, expect } from "@playwright/test";

test("staff can manage and toggle mirror visibility", async ({ page, request }) => {
  const backend = "http://127.0.0.1:8001";
  const publicMirrors = async () => {
    const response = await request.get(`${backend}/api/mirrors/`);
    expect(response.ok()).toBe(true);
    return (await response.json()).map((mirror: { name: string }) => mirror.name);
  };

  await page.goto(`${backend}/sky/mirror/admin/#mirrors`);
  await page.locator("#id_username").fill("audit-staff");
  await page.locator("#id_password").fill("local-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator('a[data-view="mirrors"]').click();
  await page.getByText("Karthigai Deepam", { exact: true }).click();

  await page.getByRole("button", { name: "Hide from studio" }).click();
  await expect(page.getByRole("button", { name: "Show in studio" })).toBeVisible();
  expect(await publicMirrors()).toEqual([]);

  await page.getByRole("button", { name: "Show in studio" }).click();
  await expect(page.getByRole("button", { name: "Hide from studio" })).toBeVisible();
  expect(await publicMirrors()).toEqual(["Karthigai Deepam"]);

  await page.getByRole("button", { name: /New mirror/ }).click();
  const editor = page.locator("#m-form");
  await editor.locator('[name="name"]').fill("Temporary mirror");
  await editor.locator('[name="artwork"]').setInputFiles("public/frames/karthigai-deepam.webp");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#m-list")).toContainText("Temporary mirror");
  await editor.locator('[name="name"]').fill("Edited mirror");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#m-list")).toContainText("Edited mirror");
  expect(await publicMirrors()).toEqual(["Karthigai Deepam", "Edited mirror"]);

  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#m-list")).not.toContainText("Edited mirror");
  expect(await publicMirrors()).toEqual(["Karthigai Deepam"]);
});
