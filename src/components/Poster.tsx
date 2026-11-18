import { useEffect, useRef, useState } from "react";
import { renderPoster, WIDTH, HEIGHT, type Composition } from "../lib/renderer";
import { retryFrame, subscribeFrames } from "../lib/frameAssets";
export function Poster({
  state,
  live = false,
  className = "",
  onCanvas,
}: {
  state: Composition;
  live?: boolean;
  className?: string;
  onCanvas?: (c: HTMLCanvasElement) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => subscribeFrames(() => setAssetVersion((v) => v + 1)), []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    onCanvas?.(c);
    const ctx = c.getContext("2d");
    if (!ctx) {
      setError(
        "Not enough memory to display the poster. Close other tabs and try again.",
      );
      return;
    }
    setError("");
    let id = 0;
    let last = 0;
    const draw = (time: number) => {
      if (time - last > 65 || !live) {
        ctx.save();
        try {
          ctx.scale(c.width / WIDTH, c.width / WIDTH);
          renderPoster(ctx, state);
        } catch {
          setError(
            "This frame could not be drawn. Choose another frame or retry the preview.",
          );
          return;
        } finally {
          ctx.restore();
        }
        last = time;
      }
      if (live) id = requestAnimationFrame(draw);
    };
    draw(100);
    return () => cancelAnimationFrame(id);
  }, [state, live, onCanvas, assetVersion]);
  return (
    <>
      <canvas
        ref={ref}
        width={540}
        height={Math.round((540 * HEIGHT) / WIDTH)}
        className={className}
        role="img"
        aria-label={`${state.template.name} poster preview${state.selfie ? ", with your selfie" : ""}${state.products.length ? ` and ${state.products.length} purchased product photos` : ""}`}
      />
      {error && (
        <div className="poster-render-error" role="alert">
          <p>{error}</p>
          <button
            className="text-button"
            onClick={() => {
              retryFrame(state.template);
              setAssetVersion((v) => v + 1);
            }}
          >
            Retry preview
          </button>
        </div>
      )}
    </>
  );
}
