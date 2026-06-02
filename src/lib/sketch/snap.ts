export interface P2 { x: number; y: number }
export interface P3 { x: number; y: number; z: number }

/**
 * Nearest vertex to a 3D point within `tol`, or null. Used by the measure tool
 * to snap a surface pick onto a corner so distances are exact (SolidWorks-style
 * vertex snapping).
 */
export function nearestVertexWithin(p: P3, verts: P3[], tol: number): P3 | null {
  let best: P3 | null = null;
  let bestD = tol;
  for (const v of verts) {
    const d = Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z);
    if (d <= bestD) { bestD = d; best = v; }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/**
 * Snap a point to the nearest candidate (e.g. an existing sketch endpoint)
 * within `tol`, returning whether a snap happened. Endpoint snapping like this
 * lets new geometry connect precisely to existing geometry, as in SolidWorks.
 * Ties prefer the last-checked nearest; distances beyond `tol` leave the point
 * unchanged.
 */
/**
 * Infer a horizontal/vertical constraint while drawing a line: if the segment
 * from `start` to `end` is within `tolDeg` of an axis, snap the end so the line
 * is exactly horizontal or vertical (SolidWorks-style auto-inference). Returns
 * the adjusted end and which constraint was applied (null if none).
 */
export function inferLineEnd(start: P2, end: P2, tolDeg = 5): { point: P2; constraint: 'horizontal' | 'vertical' | null } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return { point: end, constraint: null };
  const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI); // 0..180
  if (ang <= tolDeg || ang >= 180 - tolDeg) return { point: { x: end.x, y: start.y }, constraint: 'horizontal' };
  if (Math.abs(ang - 90) <= tolDeg) return { point: { x: start.x, y: end.y }, constraint: 'vertical' };
  return { point: end, constraint: null };
}

export function snapToPoints(p: P2, candidates: P2[], tol: number): { point: P2; snapped: boolean } {
  let best: P2 | null = null;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best ? { point: { x: best.x, y: best.y }, snapped: true } : { point: p, snapped: false };
}
