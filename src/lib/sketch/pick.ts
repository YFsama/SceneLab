import type { Sketch, SketchPoint } from './types';

interface P { x: number; y: number }

function dist(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from point p to segment a-b. */
function distToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

/**
 * Pick the nearest sketch entity to a point within `tol` (sketch units). Lines
 * use point-to-segment distance, circles/arcs the distance to the ring, points
 * direct distance, rectangles the nearest of their four edges. Returns the
 * entity id or null — used to select a sketch entity for editing/deletion.
 */
export function pickSketchEntity(sketch: Sketch, p: P, tol: number): string | null {
  const pt = (id: string): SketchPoint | null => {
    const e = sketch.entities.get(id);
    return e?.type === 'point' ? e : null;
  };
  let best: string | null = null;
  let bestD = tol;
  const consider = (id: string, d: number) => { if (d <= bestD) { bestD = d; best = id; } };

  for (const e of sketch.entities.values()) {
    switch (e.type) {
      case 'point':
        consider(e.id, dist(p, e));
        break;
      case 'line': {
        const a = pt(e.p1Id); const b = pt(e.p2Id);
        if (a && b) consider(e.id, distToSegment(p, a, b));
        break;
      }
      case 'circle':
      case 'arc': {
        const c = pt(e.centerId);
        if (c) consider(e.id, Math.abs(dist(p, c) - e.radius));
        break;
      }
      case 'rectangle': {
        const ids = [e.p1Id, e.p2Id, e.p3Id, e.p4Id];
        const pts = ids.map(pt).filter((x): x is SketchPoint => !!x);
        if (pts.length === 4) {
          let d = Infinity;
          for (let i = 0; i < 4; i++) d = Math.min(d, distToSegment(p, pts[i]!, pts[(i + 1) % 4]!));
          consider(e.id, d);
        }
        break;
      }
    }
  }
  return best;
}
