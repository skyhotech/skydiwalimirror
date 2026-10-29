export type Expression = "natural" | "smile";
export type Point = { x: number; y: number };
// A local geometric face effect, not a generated replacement face.
export function expressionDisplacement(
  u: number,
  v: number,
  expression: Expression,
  intensity: number,
) {
  const edge = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  if (expression === "smile")
    return {
      x: (u - 0.5) * 0.12 * edge * intensity,
      y: -Math.pow(Math.abs(u - 0.5) * 2, 1.2) * 0.22 * edge * intensity,
    };
  return { x: 0, y: 0 };
}
function triangle(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  a: Point,
  b: Point,
  c: Point,
  p: Point,
  q: Point,
  r: Point,
) {
  const det = a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y);
  if (Math.abs(det) < 0.0001) return;
  const ax = (p.x * (b.y - c.y) + q.x * (c.y - a.y) + r.x * (a.y - b.y)) / det;
  const bx = (p.x * (c.x - b.x) + q.x * (a.x - c.x) + r.x * (b.x - a.x)) / det;
  const cx =
    (p.x * (b.x * c.y - c.x * b.y) +
      q.x * (c.x * a.y - a.x * c.y) +
      r.x * (a.x * b.y - b.x * a.y)) /
    det;
  const ay = (p.y * (b.y - c.y) + q.y * (c.y - a.y) + r.y * (a.y - b.y)) / det;
  const by = (p.y * (c.x - b.x) + q.y * (a.x - c.x) + r.y * (b.x - a.x)) / det;
  const cy =
    (p.y * (b.x * c.y - c.x * b.y) +
      q.y * (c.x * a.y - a.x * c.y) +
      r.y * (a.x * b.y - b.x * a.y)) /
    det;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(q.x, q.y);
  ctx.lineTo(r.x, r.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(ax, ay, bx, by, cx, cy);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}
export function applyExpression(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  landmarks: Point[],
  expression: Expression,
  intensity: number,
) {
  ctx.drawImage(source, 0, 0);
  if (expression === "natural" || !landmarks.length) return;
  const left = landmarks[61],
    right = landmarks[291],
    top = landmarks[13],
    bottom = landmarks[14];
  if (!left || !right || !top || !bottom) return;
  const w = source.width,
    h = source.height,
    mouthW = Math.abs(right.x - left.x) * w;
  const rw = mouthW * 1.9,
    rh = Math.max(mouthW * 0.85, Math.abs(bottom.y - top.y) * h * 2.4);
  const x = ((left.x + right.x) * w) / 2 - rw / 2,
    y = ((top.y + bottom.y) * h) / 2 - rh / 2;
  const cols = 14,
    rows = 10;
  const point = (i: number, j: number) => ({
    x: x + (rw * i) / cols,
    y: y + (rh * j) / rows,
  });
  const dest = (i: number, j: number) => {
    const p = point(i, j),
      d = expressionDisplacement(i / cols, j / rows, expression, intensity);
    return { x: p.x + d.x * rw, y: p.y + d.y * rh };
  };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      triangle(
        ctx,
        source,
        point(i, j),
        point(i + 1, j),
        point(i, j + 1),
        dest(i, j),
        dest(i + 1, j),
        dest(i, j + 1),
      );
      triangle(
        ctx,
        source,
        point(i + 1, j),
        point(i + 1, j + 1),
        point(i, j + 1),
        dest(i + 1, j),
        dest(i + 1, j + 1),
        dest(i, j + 1),
      );
    }
}
