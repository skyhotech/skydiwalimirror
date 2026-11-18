import { expect, test } from "@playwright/test";

test("the manager form fills a PDF and validates the submitted values", async ({ page }) => {
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
  await page.route("**/api/manager/scan/", (route) => route.fulfill({
    json: { text: line.join("\n"), scan: "invoice-scan-token" },
  }));
  let checks = 0;
  await page.route("**/api/manager/check/", async (route) => {
    checks++;
    const body = route.request().postData() ?? "";
    expect(body).toContain("invoice-scan-token");
    expect(body).toContain("ranipet-2");
    if (checks === 1) {
      return route.fulfill({ status: 400, json: { bill_value: ["The bill value must match the invoice total."] } });
    }
    return route.fulfill({ json: { link: "https://studio.example/?spin=test" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Customer details" })).toBeVisible();
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
    name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4"),
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
  await expect(page.getByRole("alert")).toContainText("The bill value must match the invoice total.");
  await page.getByLabel("Bill value (₹)").fill("24999");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send link in WhatsApp" })).toBeVisible();
});
