import type { SolidBody, Vec3 } from '../geometry/types';
import { computeConvexHull, rotateBody } from '../geometry';
import { seatOnBed } from './seat';

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Rotate a body to rest on its largest flat facet, then seat it on the bed.
 * The convex hull's faces are grouped by outward normal; the largest-area
 * planar facet is turned face-down (its normal → -Y), giving the most stable,
 * usually support-minimizing print orientation. Degenerate (flat/empty) bodies
 * are just seated.
 */
export function layFlat(body: SolidBody): SolidBody {
  const hull = computeConvexHull(body.vertices);
  if (!hull) return seatOnBed(body);

  // Sum facet area per outward normal direction (coplanar hull triangles merge).
  const groups = new Map<string, { normal: Vec3; area: number }>();
  for (const [ai, bi, ci] of hull.faces) {
    const a = hull.vertices[ai]!;
    const b = hull.vertices[bi]!;
    const c = hull.vertices[ci]!;
    const cr = cross(sub(b, a), sub(c, a));
    const area = Math.hypot(cr.x, cr.y, cr.z) / 2;
    if (area < 1e-9) continue;
    const n = normalize(cr);
    const key = `${Math.round(n.x * 1e3)},${Math.round(n.y * 1e3)},${Math.round(n.z * 1e3)}`;
    const g = groups.get(key);
    if (g) g.area += area;
    else groups.set(key, { normal: n, area });
  }

  let best: { normal: Vec3; area: number } | undefined;
  for (const g of groups.values()) {
    if (!best || g.area > best.area) best = g;
  }
  if (!best) return seatOnBed(body);

  // Rotate so the chosen facet normal points straight down (-Y).
  const down: Vec3 = { x: 0, y: -1, z: 0 };
  const n = best.normal;
  const d = dot(n, down);
  let oriented = body;
  if (d < 0.9999) {
    let axis: Vec3;
    let angle: number;
    if (d < -0.9999) {
      axis = { x: 1, y: 0, z: 0 }; // already pointing up → flip 180°
      angle = Math.PI;
    } else {
      axis = cross(n, down);
      angle = Math.acos(Math.max(-1, Math.min(1, d)));
    }
    oriented = rotateBody(body, { origin: { x: 0, y: 0, z: 0 }, direction: axis }, angle);
  }
  return seatOnBed(oriented);
}
