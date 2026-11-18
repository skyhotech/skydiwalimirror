import { useCallback, useEffect, useRef, useState } from "react";
const messages: Record<string, string> = {
  NotAllowedError:
    "Camera permission was denied. Allow camera access in your browser settings, then retry.",
  NotFoundError: "No camera was found. Connect or enable a camera, then retry.",
  NotReadableError: "The camera is busy. Close other camera apps and retry.",
  SecurityError: "Camera access requires HTTPS or localhost.",
};
// This is a failure deadline, never a substitute for observing playable frames.
const START_DEADLINE_MS = 30_000;
export function useCamera(facing: "user" | "environment", active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null),
    streamRef = useRef<MediaStream | null>(null),
    generation = useRef(0),
    releaseListeners = useRef<() => void>(() => {});
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [readyFacing, setReadyFacing] = useState(""),
    [facingMode, setFacingMode] = useState<"user" | "environment">(facing),
    [fallbackNotice, setFallbackNotice] = useState(""),
    [retry, setRetry] = useState(0),
    [denied, setDenied] = useState(false),
    [failure, setFailure] = useState(""),
    [torch, setTorch] = useState(false),
    [torchSupported, setTorchSupported] = useState(false);
  const stop = useCallback(() => {
    // Invalidate even requests whose getUserMedia/play promise is still pending.
    generation.current++;
    releaseListeners.current();
    releaseListeners.current = () => {};
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    setReady(false);
    setReadyFacing("");
    setTorch(false);
    setTorchSupported(false);
  }, []);
  useEffect(() => {
    let cancelled = false;
    stop();
    setError("");
    setFailure("");
    setFallbackNotice("");
    const attempt = generation.current;
    const current = () =>
      !cancelled &&
      generation.current === attempt &&
      active &&
      !document.hidden;
    const fail = (message: string, name = "CameraError") => {
      if (!current()) return;
      stop();
      setFailure(name);
      setError(message);
    };
    const deadline = window.setTimeout(() => {
      fail(
        "Camera did not provide a picture. Check camera permissions and other camera apps, then retry.",
      );
    }, START_DEADLINE_MS);
    releaseListeners.current = () => window.clearTimeout(deadline);
    async function start() {
      if (!current()) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        fail("Camera access requires HTTPS or localhost.", "SecurityError");
        return;
      }
      try {
        let stream: MediaStream,
          selected: "user" | "environment" = facing,
          usedFallback = false;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode:
                facing === "environment"
                  ? { exact: "environment" }
                  : { ideal: "user" },
              width: { ideal: 1920 },
              height: { ideal: 1920 },
            },
            audio: false,
          });
        } catch (e) {
          if (!current()) return;
          const name = (e as DOMException).name;
          if (
            facing === "environment" &&
            [
              "OverconstrainedError",
              "NotFoundError",
              "NotReadableError",
              "AbortError",
            ].includes(name)
          ) {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: "user" },
                width: { ideal: 1920 },
                height: { ideal: 1920 },
              },
              audio: false,
            });
            selected = "user";
            usedFallback = true;
          } else if (facing === "user" && name === "OverconstrainedError") {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } else throw e;
        }
        if (!current()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current,
          track = stream.getVideoTracks()[0];
        if (!video || !track || track.readyState === "ended") {
          fail(
            "The camera disconnected. Connect or enable it, then retry.",
            "TrackStartError",
          );
          return;
        }
        const playable = () => {
          if (
            !current() ||
            track.readyState !== "live" ||
            track.muted ||
            video.readyState < 2 ||
            !video.videoWidth ||
            !video.videoHeight
          )
            return;
          window.clearTimeout(deadline);
          setReadyFacing(facing);
          setReady(true);
          setDenied(false);
          setError("");
        };
        const ended = () =>
          fail(
            "The camera disconnected or permission changed. Check the camera and retry.",
          );
        const muted = () => {
          if (!current()) return;
          setReady(false);
          setError(
            "The camera picture was interrupted. Close other camera apps or retry.",
          );
        };
        video.addEventListener("loadeddata", playable);
        video.addEventListener("playing", playable);
        video.addEventListener("error", ended);
        track.addEventListener("ended", ended);
        track.addEventListener("mute", muted);
        track.addEventListener("unmute", playable);
        releaseListeners.current = () => {
          window.clearTimeout(deadline);
          video.removeEventListener("loadeddata", playable);
          video.removeEventListener("playing", playable);
          video.removeEventListener("error", ended);
          track.removeEventListener("ended", ended);
          track.removeEventListener("mute", muted);
          track.removeEventListener("unmute", playable);
        };
        const actual = track.getSettings?.().facingMode;
        setFacingMode(
          actual === "environment"
            ? "environment"
            : actual === "user"
              ? "user"
              : selected,
        );
        setFallbackNotice(
          usedFallback
            ? "Rear camera unavailable. Using the front camera for your product."
            : "",
        );
        const capabilities = track.getCapabilities?.() as
          (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorchSupported(Boolean(capabilities?.torch));
        video.srcObject = stream;
        await video.play();
        playable();
      } catch (e) {
        if (!current()) return;
        const name = (e as DOMException).name;
        setDenied(name === "NotAllowedError");
        fail(
          messages[name] ??
            "Could not start a camera. Check permissions and retry.",
          name,
        );
      }
    }
    void start();
    const visibility = () => {
      if (document.hidden) stop();
      else setRetry((v) => v + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", visibility);
      stop();
    };
  }, [active, facing, retry, stop]);
  // A permission change can recover the camera. Denial itself never starts a
  // polling loop or repeated permission prompts.
  useEffect(() => {
    if (!active || !denied) return;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const granted = () => {
      if (!cancelled && status?.state === "granted" && !document.hidden)
        setRetry((v) => v + 1);
    };
    navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((p) => {
        if (cancelled) return;
        status = p;
        p.addEventListener("change", granted);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      status?.removeEventListener("change", granted);
    };
  }, [active, denied]);
  async function toggleTorch() {
    const stream = streamRef.current;
    const track = stream?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    try {
      const next = !torch;
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      if (streamRef.current === stream) setTorch(next);
    } catch {
      if (streamRef.current === stream)
        setError("Flash is unavailable on this camera. Try brighter lighting.");
    }
  }
  return {
    failure,
    videoRef,
    error,
    ready: ready && readyFacing === facing,
    facingMode,
    fallbackNotice,
    stop,
    retry: () => setRetry((v) => v + 1),
    denied,
    torch,
    torchSupported,
    toggleTorch,
  };
}
