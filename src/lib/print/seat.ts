import type { SolidBody, Vec3 } from '../geometry/types';
import { translateBody } from '../geometry';

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 1, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Seat a body on the build plate: translate it along the build axis (`up`,
 * default +Y) so its lowest point rests at the plate (height 0). Only moves
 * along the build axis, so the part's footprint position is preserved. Returns
 * the body unchanged if it is already seated or has no geometry.
 */
export function seatOnBed(body: SolidBody, up: Vec3 = { x: 0, y: 1, z: 0 }): SolidBody {
  if (body.vertices.length === 0) return body;
  const axis = normalize(up);
  let minH = Infinity;
  for (const v of body.vertices) minH = Math.min(minH, dot(v, axis));
  if (Math.abs(minH) < 1e-9) return body;
  return translateBody(body, { x: -axis.x * minH, y: -axis.y * minH, z: -axis.z * minH });
}
