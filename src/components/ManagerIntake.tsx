import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, MessageCircle, ScanLine, Upload, X } from "lucide-react";
import skyLogo from "../assets/brand/sky.webp";
import errorSound from "../assets/rewards/error.mp3";
import { motion, useAnimationControls } from "motion/react";
import {
  ApiError,
  PHONE_PATTERN,
  checkPurchase,
  scanInvoice,
  fetchManagerBranches,
  imeiValid,
  trackSent,
  type BranchOption,
} from "../lib/backend";
import {
  extractInvoice,
  luhnImeis,
  checkSharpness,
} from "../lib/invoiceScan";
import { initialBranches, saveBranches } from "../lib/branches";
import { Festive } from "./Festive";
const ImeiScanner = lazy(() => import("./ImeiScanner"));
// Loaded up front so the sound plays the moment a check fails.
const errorAudio = typeof Audio === "undefined" ? null : new Audio(errorSound);
// Text inside a PDF can't be blurry; recorded as a clearly sharp score.
// Only purchases of at least this much get a spin link. Kept in sync with
// MIN_BILL in backend/mirrors/serializers.py.
const MIN_BILL = 10_000;
const MISMATCH = "Data mismatch";
const EMPTY = {
  name: "",
  phone: "",
  email: "",
  product: "",
  imei: "",
  invoice: "",
  bill: "",
};
// First screen in the store: the manager records a purchase, and once it
// checks out sends the customer their spin link on WhatsApp.
export function ManagerIntake() {
  const [branches, setBranches] = useState<BranchOption[]>(initialBranches);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [storePhones, setStorePhones] = useState<string[]>([]);
  const issuingStores = branches.filter((store) =>
    store.phone && storePhones.includes(store.phone.replace(/\D/g, "").slice(-10)),
  );
  const branch = issuingStores.length === 1 ? issuingStores[0] : null;
  const [image, setImage] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("Checking…");
  const [filling, setFilling] = useState(false);
  // The invoice is a phone's: it carries a 15-digit IMEI to fill and check.
  const [hasImei, setHasImei] = useState(false);
  const [belowMinimum, setBelowMinimum] = useState(false);
  const [link, setLink] = useState("");
  const [sent, setSent] = useState(false);
  const shake = useAnimationControls();
  const fail = useCallback(
    (message: string) => {
      setError(message);
      if (errorAudio) {
        errorAudio.currentTime = 0;
        void errorAudio.play().catch(() => {});
      }
      void shake.start({
        x: [0, -10, 10, -7, 7, -3, 0],
        transition: { duration: 0.45 },
      });
    },
    [shake],
  );
  useEffect(() => {
    let live = true;
    fetchManagerBranches()
      .then((list) => {
        if (!live) return;
        setBranches(list);
        saveBranches(list);
      })
      .catch((e: ApiError) => {
        if (!live) return;
        // The built-in list still works; the server is checked again on submit.
        console.warn(e.message);
      });
    return () => {
      live = false;
    };
  }, [fail]);
  // Any edit means the sent link no longer matches what was checked.
  function change(field: keyof typeof EMPTY, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setLink("");
    setSent(false);
    setError("");
  }
  const onScan = useCallback((imei: string) => {
    setForm((f) => ({ ...f, imei }));
    setScanning(false);
    setLink("");
    setError("");
    navigator.vibrate?.(120);
  }, []);
  // One reading per file: Check reuses what the upload already read.
  const scan = useRef<{
    file: File;
    result: Promise<{ text: string; sharpness: number; scan: string }>;
  } | null>(null);
  function readFile(file: File) {
    if (scan.current?.file !== file) {
      // Blurry photos are refused here; Django reads the rest.
      const result = (async () => {
        const sharpness = await checkSharpness(file);
        const { scan, text } = await scanInvoice(file);
        return { text, sharpness, scan };
      })();
      scan.current = { file, result };
    }
    return scan.current.result;
  }
  const selection = useRef(0);
  async function pick(file: File | null) {
    const current = ++selection.current;
    setImage(file);
    setForm(EMPTY);
    setHasImei(false);
    setStorePhones([]);
    setLink("");
    setError("");
    if (!file) return;
    setFilling(true);
    try {
      const { text } = await readFile(file);
      if (current !== selection.current) return;
      const found = extractInvoice(text);
      const phoneImeis = luhnImeis(text);
      setHasImei(phoneImeis.length > 0);
      setForm({
        name: found.name ?? "",
        phone: found.phone ?? "",
        email: found.email ?? "",
        product: found.product ?? "",
        imei: phoneImeis[0] ?? "",
        invoice: found.invoice ?? "",
        bill: found.bill ?? "",
      });
      setStorePhones(found.storePhones);
    } catch (e) {
      if (current !== selection.current) return;
      scan.current = null;
      fail((e as Error).message);
    } finally {
      if (current === selection.current) setFilling(false);
    }
  }
  function problem() {
    if (!form.name.trim()) return "Enter the customer name.";
    if (!PHONE_PATTERN.test(form.phone))
      return "Enter a valid 10-digit mobile number.";
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return "Enter a valid mail ID or leave it blank.";
    if (!form.product.trim()) return "Enter the product details.";
    if (hasImei && !imeiValid(form.imei)) return "This IMEI number is not valid.";
    if (!form.invoice.trim()) return "Enter the invoice number.";
    if (!(Number(form.bill) >= 1)) return "Enter the bill value.";
    if (!image) return "Upload the invoice PDF or image.";
    if (!branch) return "We couldn’t identify the SKY store on this invoice. Upload the full PDF with the store contact number visible.";
    if (!image.type.startsWith("image/") && image.type !== "application/pdf" && !/\.pdf$/i.test(image.name))
      return "The invoice must be an image or PDF.";
    return "";
  }
  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (busy || filling) return;
    const wrong = problem();
    if (wrong) return fail(`${MISMATCH}: ${wrong}`);
    if (Number(form.bill) < MIN_BILL) {
      fail("");
      return setBelowMinimum(true);
    }
    setBusy(true);
    setError("");
    try {
      // Reuse the original extraction so checks match the attached invoice.
      setStage("Scanning invoice…");
      const { scan: scanId, sharpness } = await readFile(image!).catch((e: Error) => {
        scan.current = null;
        throw e;
      });
      // Django compares the scan with the typed details and explains a mismatch.
      setStage("Checking…");
      const body = new FormData();
      body.append("name", form.name.trim());
      body.append("phone", form.phone);
      body.append("email", form.email.trim());
      body.append("product_details", form.product.trim());
      body.append("imei", form.imei);
      body.append("invoice_number", form.invoice.trim());
      body.append("bill_value", form.bill);
      body.append("branch", branch!.slug);
      body.append("scan", scanId);
      body.append("blur_score", String(Math.round(sharpness)));
      const res = await checkPurchase(body);
      setLink(res.link);
    } catch (err) {
      const e = err as ApiError;
      fail(
        e.status === 400
          ? `${MISMATCH}: ${e.message}`
          : e.message,
      );
    } finally {
      setBusy(false);
      setStage("Checking…");
    }
  }
  function sendWhatsapp() {
    const text = `Hi ${form.name.trim()}, thank you for shopping at SKY Mobile & Electronics! 🪔 Spin the wheel for your Karthigai Deepam gift: ${link}`;
    window.open(
      `https://wa.me/91${form.phone}?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer",
    );
    trackSent(form.phone);
    setSent(true);
  }
  function next() {
    setForm(EMPTY);
    setStorePhones([]);
    setImage(null);
    setLink("");
    setSent(false);
  }
  const input = (
    id: keyof typeof EMPTY,
    { prefix, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { prefix?: string } = {},
  ) => (
    <div className="phone-field">
      {prefix && <span aria-hidden="true">{prefix}</span>}
      <input
        id={`m-${id}`}
        value={form[id]}
        onChange={(e) => change(id, e.target.value)}
        {...props}
      />
    </div>
  );
  const field = (
    id: keyof typeof EMPTY,
    label: string,
    props?: Parameters<typeof input>[1],
  ) => (
    <>
      <label htmlFor={`m-${id}`}>{label}</label>
      {input(id, props)}
    </>
  );
  return (
    <Festive>
      {belowMinimum && (
        <div className="notice-shade" role="presentation">
          <motion.div
            className="notice-window"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="below-min-title"
            aria-describedby="below-min-text"
            initial={{ opacity: 0, scale: 0.85, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
          >
            <span className="notice-icon" aria-hidden="true">₹</span>
            <h2 id="below-min-title">Not eligible for the spin wheel</h2>
            <p id="below-min-text">
              This bill is below ₹10,000. Only purchases of ₹10,000 or more
              qualify for the spin wheel, so a gift link cannot be sent to
              this customer.
            </p>
            <p className="notice-amount">
              Bill value: ₹{Number(form.bill).toLocaleString("en-IN")}
            </p>
            <button
              type="button"
              className="spin-button phone-continue"
              onClick={() => setBelowMinimum(false)}
              autoFocus
            >
              OK
            </button>
          </motion.div>
        </div>
      )}
      <motion.div animate={shake} className="phone-shake">
        <motion.form
          className="phone-card manager-card"
          onSubmit={(e) => void check(e)}
          initial={{ opacity: 0, scale: 0.92, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          noValidate
        >
          <div className="phone-logo">
            <img src={skyLogo} alt="SKY Mobile & Electronics" />
          </div>
          <h1 className="phone-title">Customer details</h1>
          {field("name", "Customer name", { maxLength: 80, autoComplete: "off" })}
          {field("phone", "Customer contact number", {
            prefix: "+91",
            type: "tel",
            inputMode: "numeric",
            maxLength: 10,
            onChange: (e) => change("phone", e.target.value.replace(/\D/g, "").slice(0, 10)),
          })}
          {field("email", "Mail ID (optional)", {
            type: "email",
            inputMode: "email",
            autoComplete: "off",
          })}
          {field("product", "Product details", { maxLength: 160 })}
          {/* Phones only: shown when the invoice carries a 15-digit IMEI. */}
          {hasImei && (
            <>
            <label htmlFor="m-imei">IMEI number</label>
            <div className="manager-row">
              {input("imei", {
                maxLength: 15,
                inputMode: "numeric",
                placeholder: "Type or scan",
                onChange: (e) => change("imei", e.target.value.replace(/\D/g, "")),
              })}
              <button
                type="button"
                className="manager-scan"
                aria-expanded={scanning}
                onClick={() => setScanning((v) => !v)}
              >
                {scanning ? <X size={18} /> : <ScanLine size={18} />}
                {scanning ? "Close" : "Scan"}
              </button>
            </div>
            {scanning && (
              <Suspense fallback={<p className="phone-help">Opening camera…</p>}>
                <ImeiScanner onScan={onScan} />
              </Suspense>
            )}
            </>
          )}
          {field("invoice", "Invoice number", { maxLength: 40 })}
          {field("bill", "Bill value (₹)", {
            prefix: "₹",
            type: "number",
            inputMode: "decimal",
            min: 1,
            step: "0.01",
          })}
          <label htmlFor="m-image">Invoice PDF</label>
          <div className="phone-field manager-file">
            <span aria-hidden="true"><Upload size={18} /></span>
            <span>Upload image / PDF</span>
            <input
              id="m-image"
              type="file"
              accept="application/pdf,.pdf,image/*"
              disabled={busy}
              aria-describedby={image ? "m-image-status" : undefined}
              onChange={(e) => {
                if (e.target.files?.[0]) void pick(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </div>
          {image && (
            <p id="m-image-status" className="phone-help" role="status">
              {filling
                ? "Reading invoice and filling the details…"
                : `Selected: ${image.name}. Check the details above.`}
            </p>
          )}
          <p className="phone-help phone-help-error" role="alert">
            {error}
          </p>
          {link ? (
            <>
              <button
                type="button"
                className="spin-button phone-continue manager-whatsapp"
                onClick={sendWhatsapp}
              >
                {sent ? <Check size={18} /> : <MessageCircle size={18} />}
                {sent ? "Send again in WhatsApp" : "Send link in WhatsApp"}
              </button>
              {sent && (
                <button type="button" className="text-button" onClick={next}>
                  Next customer
                </button>
              )}
            </>
          ) : (
            <button
              className="spin-button phone-continue"
              disabled={busy || filling}
            >
              {busy ? stage : "Check"}
            </button>
          )}
        </motion.form>
      </motion.div>
    </Festive>
  );
}
