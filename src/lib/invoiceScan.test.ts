import { expect, it } from "vitest";
import { extractInvoice } from "./invoiceScan";

it("reads the customer fields and separates the issuing branch's contact", () => {
  expect(extractInvoice([
    "TAX INVOICE",
    "Phone: 86676 70649",
    "help@sky.example",
    "Invoice No: SI2627RPT12261",
    "Billed To, Shipped To,",
    "Asha Example Asha Example",
    "Mobile No: +91 98450 11111",
    "Email: asha@example.test",
    "Place of Supply: Tamil Nadu",
    "S No Particulars HSN",
    "1 SKY TV 85287217",
    "Net Total 1 24,999.00",
  ].join("\n"))).toMatchObject({
    name: "Asha Example",
    phone: "9845011111",
    email: "asha@example.test",
    product: "SKY TV",
    invoice: "SI2627RPT12261",
    bill: "24999",
    storePhone: "8667670649",
  });
});
