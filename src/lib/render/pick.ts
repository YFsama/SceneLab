import type { SolidBody, Vec3 } from '../geometry/types';

export interface PickResult {
  bodyId: string;
  /** Distance along the ray to the hit point. */
  distance: number;
  /** World-space hit point. */
  point: Vec3;
}

/** Möller–Trumbore ray/triangle intersection; positive hit distance or null. */
function rayTriangle(orig: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
  const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
  const px = dir.y * e2z - dir.z * e2y;
  const py = dir.z * e2x - dir.x * e2z;
  const pz = dir.x * e2y - dir.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = orig.x - a.x, ty = orig.y - a.y, tz = orig.z - a.z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : null;
}

/**
 * Pick the nearest body hit by a ray (origin + direction). Each face is
 * fan-triangulated and tested; the closest hit across all bodies wins. Returns
 * null if the ray misses everything. `direction` need not be normalized — the
 * returned distance is in units of `direction`'s length, but the hit point is
 * exact. The foundation for click-selection and the viewport context menu.
 */
export function pickBody(bodies: SolidBody[], origin: Vec3, direction: Vec3): PickResult | null {
  let best: PickResult | null = null;
  for (const body of bodies) {
    for (const face of body.faces) {
      const vs = face.vertices;
      for (let i = 1; i < vs.length - 1; i++) {
        const t = rayTriangle(origin, direction, vs[0]!, vs[i]!, vs[i + 1]!);
        if (t !== null && (best === null || t < best.distance)) {
          best = {
            bodyId: body.id,
            distance: t,
            point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t },
          };
        }
      }
    }
  }
  return best;
}

export interface EdgePickResult {
  bodyId: string;
  edgeId: string;
  /** Distance along the ray to the closest-approach point. */
  distance: number;
  point: Vec3;
}

/**
 * Closest approach between a ray and a line segment (Ericson 5.1.9 adapted):
 * returns null if they don't come within `threshold` world units, or if the
 * closest point lies behind the ray origin. Used for CAD edge picking, where a
 * click "hits" the nearest edge it passes close to.
 */
export function pickEdge(
  bodies: SolidBody[],
  origin: Vec3,
  direction: Vec3,
  threshold: number,
): EdgePickResult | null {
  // Segment B is far enough along the ray that the clamped solution is exact
  // for any practical click distance.
  const big = Math.max(1e3, threshold * 1e4);
  const b1 = { x: origin.x, y: origin.y, z: origin.z };
  const b2 = { x: origin.x + direction.x * big, y: origin.y + direction.y * big, z: origin.z + direction.z * big };

  let best: EdgePickResult | null = null;
  for (const body of bodies) {
    for (const edge of body.edges) {
      // Segment A: the edge itself.
      const d1 = { x: b2.x - b1.x, y: b2.y - b1.y, z: b2.z - b1.z };
      const d2 = { x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z };
      const r = { x: b1.x - edge.start.x, y: b1.y - edge.start.y, z: b1.z - edge.start.z };
      const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z;
      const e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z;
      const f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
      let s: number;
      let t: number;
      if (a <= 1e-12 || e <= 1e-12) continue;
      const c = d1.x * r.x + d1.y * r.y + d1.z * r.z;
      const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
      const denom = a * e - b * b;
      if (denom > 1e-12) {
        s = Math.min(1, Math.max(0, (b * f - c * e) / denom));
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      }
      const p1 = { x: b1.x + d1.x * s, y: b1.y + d1.y * s, z: b1.z + d1.z * s };
      const p2 = { x: edge.start.x + d2.x * t, y: edge.start.y + d2.y * t, z: edge.start.z + d2.z * t };
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
      if (dist > threshold) continue;
      if (!best || s < best.distance) {
        best = {
          bodyId: body.id,
          edgeId: edge.id,
          distance: s,
          point: p2,
        };
      }
    }
  }
  return best;
}
