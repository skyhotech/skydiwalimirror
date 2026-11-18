import { useEffect, useRef, useState } from "react";
import { download } from "../lib/images";
import {
  recordShareEvent, saveInstagramProfile, submitShareProof, type ShareProof,
} from "../lib/customerJourney";

const filename = "SKY-Karthigai-Deepam.jpg";
const caption = "Happy Karthigai Deepam! 🪔 Celebrating with SKY Mobile & Electronics @skymobileandelectronics";
const platforms = [
  { id: "whatsapp", share: "Share on WhatsApp", proof: "Upload WhatsApp Status screenshot", url: "https://wa.me/" },
  { id: "more", share: "Open share sheet", proof: "Upload a share screenshot (other app)", url: "" },
  { id: "instagram", share: "Share on Instagram", proof: "Upload Instagram post screenshot", url: "https://www.instagram.com/" },
] as const;
type ShareAttempt = {
  id: ShareProof;
  left: boolean;
  returned: boolean;
  complete: boolean;
};

export function ShareJourney({
  token, poster, handle, profileSaved = false,
}: { token: string; poster: Blob; handle: string; profileSaved?: boolean }) {
  const [instagram, setInstagram] = useState(handle);
  const [ready, setReady] = useState(profileSaved);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [proofs, setProofs] = useState<Partial<Record<ShareProof, true>>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const shareAttempt = useRef<ShareAttempt | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function enqueue<T>(action: () => Promise<T>) {
    const job = queue.current.then(action);
    queue.current = job.catch(() => {});
    return job;
  }

  useEffect(() => {
    const url = URL.createObjectURL(poster);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [poster]);

  useEffect(() => {
    function visibility() {
      const attempt = shareAttempt.current;
      if (!attempt) return;
      if (document.hidden) attempt.left = true;
      else if (attempt.left && !attempt.returned) {
        attempt.returned = true;
        if (attempt.complete && attempt.id !== "more")
          void enqueue(() => recordShareEvent(token, `returned_${attempt.id}`))
            .catch(() => setError("The return from sharing could not be recorded."));
      }
    }
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [token]);

  async function share(platform: typeof platforms[number]) {
    if (busy) return;
    setBusy(true);
    setError("");
    const attempt: ShareAttempt = { id: platform.id, left: false, returned: false, complete: false };
    shareAttempt.current = attempt;
    void enqueue(() => recordShareEvent(token, `share_opened_${platform.id}`)).catch((reason: Error) => setError(reason.message));
    const file = new File([poster], filename, { type: poster.type || "image/jpeg" });
    try {
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ title: "My SKY Karthigai Deepam poster", text: caption, files: [file] });
        if (platform.id !== "more")
          await enqueue(() => recordShareEvent(token, `shared_${platform.id}`));
        setNotice("After posting, upload a screenshot below.");
      } else {
        download(poster, filename);
        if (platform.url) window.open(platform.url, "_blank", "noopener,noreferrer");
        setNotice("Poster downloaded. Share it from your app, then upload a screenshot.");
      }
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
    } finally {
      attempt.complete = true;
      if (attempt.returned && attempt.id !== "more")
        void enqueue(() => recordShareEvent(token, `returned_${attempt.id}`)).catch((reason: Error) => setError(reason.message));
      setBusy(false);
    }
  }

  async function proof(platform: ShareProof, file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await enqueue(() => submitShareProof(token, platform, file));
      setProofs((previous) => ({ ...previous, [platform]: true }));
      setNotice("Screenshot received.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="phone-card review-card">
      <h1 className="phone-title">{ready ? "Share your poster" : "Your Instagram ID"}</h1>
      {preview && <img className="journey-poster" src={preview} alt="Your Karthigai Deepam poster" />}
      {!ready ? (
        <form onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await saveInstagramProfile(token, instagram.trim());
            setReady(true);
          } catch (reason) { setError((reason as Error).message); }
          finally { setBusy(false); }
        }}>
          <label htmlFor="journey-instagram">Instagram ID</label>
          <div className="phone-field">
            <span aria-hidden="true">@</span>
            <input id="journey-instagram" value={instagram} onChange={(event) => setInstagram(event.target.value)} maxLength={31} required />
          </div>
          <button className="spin-button phone-continue" disabled={busy}>Continue to sharing</button>
        </form>
      ) : platforms.map((platform) => (
        <div key={platform.id} className="journey-share-option">
          <button type="button" className="spin-button" disabled={busy} onClick={() => void share(platform)}>{platform.share}</button>
          <label htmlFor={`journey-proof-${platform.id}`}>{platform.proof}</label>
          <input id={`journey-proof-${platform.id}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => {
            void proof(platform.id, event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }} />
          {proofs[platform.id] && <span className="phone-help">Screenshot received</span>}
        </div>
      ))}
      {notice && <p role="status" className="phone-help">{notice}</p>}
      {error && <p role="alert" className="phone-help phone-help-error">{error}</p>}
    </section>
  );
}
