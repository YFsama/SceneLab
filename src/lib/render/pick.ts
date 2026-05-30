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
