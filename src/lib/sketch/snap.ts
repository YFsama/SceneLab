export interface P2 { x: number; y: number }

/**
 * Snap a point to the nearest candidate (e.g. an existing sketch endpoint)
 * within `tol`, returning whether a snap happened. Endpoint snapping like this
 * lets new geometry connect precisely to existing geometry, as in SolidWorks.
 * Ties prefer the last-checked nearest; distances beyond `tol` leave the point
 * unchanged.
 */
export function snapToPoints(p: P2, candidates: P2[], tol: number): { point: P2; snapped: boolean } {
  let best: P2 | null = null;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best ? { point: { x: best.x, y: best.y }, snapped: true } : { point: p, snapped: false };
}
