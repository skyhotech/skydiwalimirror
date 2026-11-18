import { useEffect, useState, type ReactNode } from "react";
import { ERRORS } from "../lib/backend";

const SAMPLE_BYTES = 64 * 1024;
const SLOW_AFTER_MS = 2_000;
const TIMEOUT_MS = 5_000;
const SAMPLE_URL = "/frames/karthigai-deepam.webp";

type Result = "ready" | "slow" | "offline" | "unreachable";

async function testConnection(signal: AbortSignal): Promise<Result> {
  if (!navigator.onLine) return "offline";
  const started = performance.now();
  const response = await fetch(SAMPLE_URL, {
    cache: "no-store",
    headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` },
    signal,
  });
  if (!response.ok || !response.body || !response.headers.get("Content-Type")?.startsWith("image/"))
    return "unreachable";

  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (bytes < SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  if (bytes < SAMPLE_BYTES) return "unreachable";
  return performance.now() - started > SLOW_AFTER_MS ? "slow" : "ready";
}

const messages = {
  offline: ERRORS.offline,
  unreachable: ERRORS.unreachable,
  slow: "Your internet connection is slow. Try a stronger Wi-Fi or mobile data connection, then try again.",
};

export function ConnectionGate({
  children,
  onReady,
}: {
  children: ReactNode;
  onReady: () => void;
}) {
  const [result, setResult] = useState<Result | "checking">("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    void testConnection(controller.signal)
      .then((status) => {
        if (!active) return;
        if (status === "ready") onReady();
        setResult(status);
      })
      .catch(() => {
        if (!active) return;
        setResult(!navigator.onLine ? "offline" : controller.signal.aborted ? "slow" : "unreachable");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, onReady]);

  if (result === "ready") return children;
  return (
    <main id="main" className="mobile-studio">
      <div className="phone-gate">
        <div className="phone-shake">
          <section className="phone-card">
            {result === "checking" ? (
              <p role="status">Checking your internet connection…</p>
            ) : (
              <>
                <div role="alert">
                  <h1 className="phone-title">
                    {result === "slow" ? "Slow internet connection" : "Internet connection issue"}
                  </h1>
                  <p>{messages[result]}</p>
                </div>
                <button
                  type="button"
                  className="spin-button phone-continue"
                  onClick={() => {
                    setResult("checking");
                    setAttempt((previous) => previous + 1);
                  }}
                >
                  Try again
                </button>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
