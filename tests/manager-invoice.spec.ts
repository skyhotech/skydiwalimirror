import { expect, test } from "@playwright/test";

test("the manager form fills a PDF and sends the corrected values", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = (url) => {
      document.body.dataset.whatsappDraft = String(url);
      return null;
    };
  });
  await page.route("**/api/manager/sent/", (route) => route.fulfill({ json: { ok: true } }));
  const line = [
    "TAX INVOICE",
    "Ph: 8667670649",
    "Invoice No: SI2627RPT12261",
    "Billed To,",
    "Asha Example",
    "Mobile: +91 9845011111",
    "Email: asha@example.test",
    "S No Particulars HSN",
    "1 SKY TV 85287217",
    "Grand Total 24,999.00",
  ];
  await page.route("**/api/manager/branches/", (route) => route.fulfill({
    json: [{ slug: "ranipet-2", name: "RANIPET-2", phone: "8667670649" }],
  }));
  await page.route("**/api/manager/scan/", (route) => {
    expect(route.request().postData()).toContain('filename="counter-21003.pdf"');
    return route.fulfill({
      json: { text: line.join("\n"), scan: "invoice-scan-token" },
    });
  });
  await page.route("**/api/manager/check/", async (route) => {
    const body = route.request().postData() ?? "";
    expect(body).toContain("invoice-scan-token");
    expect(body).toContain("ranipet-2");
    expect(body).toMatch(/name="bill_value"\r\n\r\n50000\r\n/);
    return route.fulfill({ json: { link: "https://studio.example/?spin=test" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Customer details" })).toBeVisible();
  await expect(page.locator(".vilakku-flame")).toHaveCount(5);
  const lamp = page.locator(".vilakku-wrap img");
  await expect.poll(() => lamp.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const fieldStyles = await page.locator(".manager-card > .phone-field").evaluateAll((fields) =>
    fields.map((field) => {
      const style = getComputedStyle(field);
      return [style.height, style.borderColor, style.borderRadius, style.backgroundColor];
    }),
  );
  expect(fieldStyles).toHaveLength(7);
  expect(fieldStyles.every((style) => JSON.stringify(style) === JSON.stringify(fieldStyles[0]))).toBe(true);
  const upload = page.getByLabel("Invoice PDF");
  await upload.focus();
  await expect(upload).toBeFocused();
  await upload.setInputFiles({
    name: "counter-21003.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(page.getByLabel("Customer name")).toHaveValue("Asha Example");
  await expect(page.getByLabel("Customer contact number")).toHaveValue("9845011111");
  await expect(page.getByLabel("Mail ID (optional)")).toHaveValue("asha@example.test");
  await expect(page.getByLabel("Product details")).toHaveValue("SKY TV");
  await expect(page.getByLabel("Invoice number")).toHaveValue("SI2627RPT12261");
  await expect(page.getByLabel("Bill value (₹)")).toHaveValue("24999");
  await expect(page.getByRole("combobox", { name: "Branch" })).toHaveCount(0);

  await page.getByLabel("Bill value (₹)").fill("50000");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const tracked = page.waitForRequest("**/api/manager/sent/");
  await page.getByRole("button", { name: "Send link in WhatsApp" }).click();
  expect((await tracked).postDataJSON()).toEqual({ phone: "9845011111" });
  const draft = new URL((await page.locator("body").getAttribute("data-whatsapp-draft"))!);
  expect(draft.hostname + draft.pathname).toBe("wa.me/919845011111");
  expect(draft.searchParams.get("text")).toContain("happy Karthigai Deepam");
  expect(draft.searchParams.get("text")).toContain("இனிய கார்த்திகை தீபத் திருநாள் நல்வாழ்த்துகள்!");
  expect(draft.searchParams.get("text")).toContain("https://studio.example/?spin=test");
});
