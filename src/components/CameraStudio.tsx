import { useRef, useState } from "react";
import {
  Camera,
  Instagram,
  RefreshCw,
  CameraOff,
  Copy,
  ExternalLink,
  Download,
} from "lucide-react";
import { motion } from "motion/react";
import { useCamera } from "../hooks/useCamera";
import { useExpression } from "../hooks/useExpression";
import { useStudio, MAX_PRODUCTS } from "../lib/store";
import { capture, canvasBlob, fromBlob, download } from "../lib/images";
import { instagramCaption, copyCaption } from "../lib/sharing";
import { renderPoster } from "../lib/renderer";
import { frameAsset } from "../lib/frameAssets";
import { getTemplate, templates } from "../templates";
import { Poster } from "./Poster";
import { Templates } from "./Templates";
export default function CameraStudio() {
  const s = useStudio(),
    product = s.step === "product";
  const [closed, setClosed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [flash, setFlash] = useState(false),
    [completed, setCompleted] = useState(false),
    [poster, setPoster] = useState<Blob | null>(null),
    [captionMessage, setCaptionMessage] = useState("");
  const busyRef = useRef(false);
  const camera = useCamera(
    product ? "environment" : "user",
    !closed && !completed,
  );
  const effect = useExpression(
    camera.videoRef,
    camera.ready && !product && !closed,
    "smile",
    1,
  );
  const template = getTemplate(s.template),
    caption = instagramCaption(
      s.products.length,
      s.products.map((p) => p.label),
    ),
    filename = `SKY-Diwali-${s.template}.png`;
  async function post(blob: Blob, text: string) {
    const file = new File([blob], filename, { type: blob.type });
    void copyCaption(text).then((ok) =>
      setCaptionMessage(
        ok
          ? "Caption copied. Paste it in Instagram if needed."
          : "Copy the caption below if Instagram does not include it.",
      ),
    );
    try {
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        setMessage(
          "Choose Instagram → Post/Feed. Your poster and SKY caption are ready.",
        );
        await navigator.share({
          files: [file],
          title: "My SKY Diwali moment",
          text,
        });
      } else {
        download(blob, filename);
        window.open(
          "https://www.instagram.com/",
          "_blank",
          "noopener,noreferrer",
        );
        setMessage(
          "Poster downloaded and Instagram opened. Tap + → Post, choose the poster, and paste the caption.",
        );
      }
    } catch (e) {
      setMessage(
        (e as Error).name === "AbortError"
          ? "Sharing cancelled. Tap Post on Instagram to try again."
          : "Tap Post on Instagram again to open sharing. Your poster and caption are ready.",
      );
    }
  }
  async function shoot() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (completed && poster) {
        await post(poster, caption);
        return;
      }
      let photo;
      if (!product && effect.ready) {
        const source = effect.output.current,
          c = document.createElement("canvas");
        c.width = source.width;
        c.height = source.height;
        const ctx = c.getContext("2d")!;
        if (camera.facingMode === "user") {
          ctx.translate(c.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(source, 0, 0);
        photo = await fromBlob(await canvasBlob(c, "image/jpeg"));
      } else
        photo = await capture(
          camera.videoRef.current!,
          !product && camera.facingMode === "user",
        );
      setFlash(true);
      setTimeout(() => setFlash(false), 180);
      if (!product) {
        s.setSelfie(photo);
        camera.stop();
        s.setStep("product");
        return;
      }
      s.addProduct(photo);
      camera.stop();
      setCompleted(true);
      setMessage("Preparing your Instagram poster…");
      const current = useStudio.getState();
      if (!current.selfie) throw new Error("Take a selfie first.");
      if (frameAsset(getTemplate(current.template)).status !== "ready")
        throw new Error("The frame is still loading. Please try again.");
      const c = document.createElement("canvas");
      c.width = 1080;
      c.height = 1920;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("Could not prepare your poster. Try again.");
      renderPoster(ctx, {
        template: getTemplate(current.template),
        selfie: current.selfie,
        products: current.products,
        logo: current.logo,
        layout: current.layout,
      });
      const blob = await canvasBlob(c);
      c.width = c.height = 1;
      setPoster(blob);
      s.setSavedPoster(blob);
      await post(
        blob,
        instagramCaption(
          current.products.length,
          current.products.map((p) => p.label),
        ),
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function changeTemplate(direction: number) {
    if (completed) return;
    const i = templates.findIndex((t) => t.id === s.template);
    s.setTemplate(
      templates[(i + direction + templates.length) % templates.length].id,
    );
  }
  function retake() {
    s.products.forEach((p) => s.removeProduct(p.id));
    setCompleted(false);
    setPoster(null);
    setMessage("");
    setClosed(false);
  }
  return (
    <div
      className={`workspace camera-workspace inline-product-workspace ${product ? "product-workspace" : ""}`}
    >
      <div className="studio-panel">
        <motion.div
          className="camera-stage"
          drag={completed ? false : "x"}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.12}
          onDragEnd={(_, info) => {
            if (Math.abs(info.offset.x) > 45 || Math.abs(info.velocity.x) > 450)
              changeTemplate(info.offset.x < 0 ? 1 : -1);
          }}
          tabIndex={0}
          onKeyDown={(e) => {
            if (["ArrowRight", "ArrowLeft"].includes(e.key)) {
              e.preventDefault();
              changeTemplate(e.key === "ArrowRight" ? 1 : -1);
            }
          }}
          aria-label={
            product
              ? "Poster with product camera in the small product box"
              : "Selfie poster camera"
          }
        >
          <video
            ref={camera.videoRef}
            autoPlay
            playsInline
            muted
            className="hidden-video"
          />
          <Poster
            live={camera.ready && !completed}
            state={{
              template,
              selfie: s.selfie,
              products: s.products,
              logo: s.logo,
              layout: s.layout,
              video:
                !product && camera.ready
                  ? effect.ready
                    ? effect.output.current
                    : (camera.videoRef.current ?? undefined)
                  : undefined,
              mirror: camera.facingMode === "user",
              productVideo:
                product && camera.ready && !completed
                  ? (camera.videoRef.current ?? undefined)
                  : undefined,
            }}
          />
          {product && !completed && (
            <div
              className="inline-product-hint"
              style={{
                left: `${template.product.x / 10.8}%`,
                top: `${template.product.y / 19.2}%`,
                width: `${template.product.w / 10.8}%`,
              }}
            >
              <Camera size={12} />
              {camera.ready
                ? "Point at your purchase"
                : "Opening product camera…"}
            </div>
          )}
          <button
            className="instagram-shutter poster-post-action"
            aria-label={
              product && !completed
                ? "Capture product and post on Instagram"
                : "Post on Instagram"
            }
            disabled={
              busy || (!completed && !camera.ready) || (completed && !poster)
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void shoot()}
          >
            <Instagram size={21} aria-hidden="true" />
            <span>
              {busy
                ? "Preparing…"
                : product && !completed
                  ? "Capture product & post"
                  : "Post on Instagram"}
            </span>
          </button>
          {!completed && (
            <button
              className="stage-close icon-button"
              aria-label={closed ? "Resume camera" : "Pause camera"}
              onClick={() => setClosed((v) => !v)}
            >
              {closed ? <Camera size={18} /> : <CameraOff size={18} />}
            </button>
          )}
          {flash && <div className="shutter-flash" />}
        </motion.div>
        <div className="camera-status" role="status">
          {message ||
            camera.error ||
            (product && camera.fallbackNotice) ||
            (!product && camera.ready && effect.status) ||
            (completed
              ? "Poster ready to share."
              : camera.ready
                ? product
                  ? "Selfie saved. Capture your purchase in the small box."
                  : "Tap Post on Instagram to take your selfie."
                : closed
                  ? "Camera paused. Tap the camera icon to resume."
                  : "Starting camera…")}
        </div>
        {camera.error && (
          <button
            className="text-button retry-inline-camera"
            onClick={camera.retry}
          >
            <RefreshCw size={14} /> Retry camera
          </button>
        )}
      </div>
      <aside className="studio-sidebar">
        {!completed ? (
          <Templates />
        ) : (
          <div className="inline-post-actions">
            <button className="text-button" onClick={retake}>
              <RefreshCw size={13} /> Retake product
            </button>
            <button className="text-button" onClick={() => s.setStep("edit")}>
              Edit poster
            </button>
            {poster && (
              <button
                className="text-button"
                onClick={() => download(poster, filename)}
              >
                <Download size={13} /> Download
              </button>
            )}
          </div>
        )}
      </aside>
      {completed && (
        <section className="inline-caption-panel">
          <label htmlFor="inline-sky-caption">Your SKY Instagram caption</label>
          <textarea
            id="inline-sky-caption"
            readOnly
            rows={5}
            value={caption}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div>
            <button
              className="text-button"
              onClick={() =>
                void copyCaption(caption).then((ok) =>
                  setCaptionMessage(
                    ok
                      ? "Caption copied."
                      : "Select and copy the caption above.",
                  ),
                )
              }
            >
              <Copy size={14} /> Copy caption
            </button>
            <a
              href="https://www.instagram.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-button"
            >
              <ExternalLink size={14} /> Open Instagram
            </a>
          </div>
          <p role="status">{captionMessage}</p>
          {s.products.length < MAX_PRODUCTS && (
            <button
              className="text-button"
              onClick={() => {
                setCompleted(false);
                setPoster(null);
                setMessage("");
              }}
            >
              Add another product
            </button>
          )}
        </section>
      )}
    </div>
  );
}
