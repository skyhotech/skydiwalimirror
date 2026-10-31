import { useEffect, useRef, useState } from "react";
import { renderPoster, WIDTH, type Composition } from "../lib/renderer";
import { subscribeFrames } from "../lib/frameAssets";
import {
  instagramReady,
  renderInstagramPost,
  POST_HEIGHT,
} from "../lib/instagram";
export function Poster({
  state,
  live = false,
  className = "",
  onCanvas,
  chrome = false,
}: {
  state: Composition;
  live?: boolean;
  className?: string;
  onCanvas?: (c: HTMLCanvasElement) => void;
  /** Wrap the preview in the same Instagram header and footer as the export. */
  chrome?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  useEffect(() => subscribeFrames(() => setAssetVersion((v) => v + 1)), []);
  useEffect(() => {
    void instagramReady().then(() => setAssetVersion((v) => v + 1));
  }, []);
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
        ctx.scale(c.width / WIDTH, c.width / WIDTH);
        if (chrome) renderInstagramPost(ctx, state);
        else renderPoster(ctx, state);
        ctx.restore();
        last = time;
      }
      if (live) id = requestAnimationFrame(draw);
    };
    draw(100);
    return () => cancelAnimationFrame(id);
  }, [state, live, onCanvas, assetVersion, chrome]);
  return (
    <canvas
      ref={ref}
      width={540}
      height={chrome ? Math.round((540 * POST_HEIGHT) / WIDTH) : 960}
      className={className}
      role="img"
      aria-label={`${state.template.name} poster preview${state.selfie ? ", with your selfie" : ""}${state.products.length ? ` and ${state.products.length} purchased product photos` : ""}`}
    />
  );
}
