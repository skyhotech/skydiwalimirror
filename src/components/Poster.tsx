import { useEffect, useRef, useState } from "react";
import { renderPoster, WIDTH, HEIGHT, type Composition } from "../lib/renderer";
import { subscribeFrames } from "../lib/frameAssets";
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
  useEffect(() => subscribeFrames(() => setAssetVersion((v) => v + 1)), []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    onCanvas?.(c);
    const ctx = c.getContext("2d")!;
    let id = 0;
    let last = 0;
    const draw = (time: number) => {
      if (time - last > 65 || !live) {
        ctx.save();
        ctx.scale(c.width / WIDTH, c.height / HEIGHT);
        renderPoster(ctx, state);
        ctx.restore();
        last = time;
      }
      if (live) id = requestAnimationFrame(draw);
    };
    draw(100);
    return () => cancelAnimationFrame(id);
  }, [state, live, onCanvas, assetVersion]);
  return (
    <canvas
      ref={ref}
      width={540}
      height={960}
      className={className}
      role="img"
      aria-label={`${state.template.name} poster preview${state.selfie ? ", with your selfie" : ""}${state.products.length ? ` and ${state.products.length} purchased product photos` : ""}`}
    />
  );
}
