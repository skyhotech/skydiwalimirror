import { useEffect, useState } from "react";
import { instagramCaption } from "../lib/sharing";
import { combineSignals } from "../lib/abort";
import { useStudio } from "../lib/store";
import { ShareButtons } from "./ShareButtons";
// Fetch with the customer's link authority; do not publish private image URLs.
export function SavedPoster({ url }: { url: string }) {
  const token = useStudio((s) => s.token);
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setImage(null);
    setError("");
    void fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: combineSignals([controller.signal, AbortSignal.timeout(15_000)]),
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Your poster could not be loaded. Please try again.");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ blob, url: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Your poster could not be loaded. Check your connection and try again.",
          );
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token, retry]);
  return (
    <div className="phone-card manager-card">
      <h1 className="phone-title">Your Karthigai Deepam poster</h1>
      {image && (
        <img
          className="saved-poster"
          src={image.url}
          alt="Your SKY Karthigai Deepam poster"
        />
      )}
      {image ? (
        <ShareButtons
          poster={image.blob}
          caption={instagramCaption(1)}
          filename="SKY-Karthigai-Deepam.jpg"
        />
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setRetry((n) => n + 1)}>Retry poster</button>
        </div>
      ) : (
        <p className="phone-help">Preparing sharing…</p>
      )}
    </div>
  );
}
