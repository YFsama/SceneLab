import type { SolidBody, Vec3 } from '../geometry/types';
import { rotateBody } from '../geometry';
import { recommendOrientation } from './orientation';
import type { OrientationOptions, OrientationCandidate } from './orientation';

export interface OrientForPrintResult {
  body: SolidBody;
  /** The orientation that was applied. */
  orientation: OrientationCandidate['label'];
  /** True if the body was actually rotated. */
  rotated: boolean;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Rotate a body into its recommended print orientation, so the chosen "up"
 * axis aligns with the build axis (+Y). The result is ready to export for
 * printing with minimal support.
 */
export function orientForPrint(body: SolidBody, options: OrientationOptions = {}): OrientForPrintResult {
  const best = recommendOrientation(body, options).best;
  const up = best.up;
  const target: Vec3 = { x: 0, y: 1, z: 0 };
  const d = dot(up, target);

  if (d > 0.9999) {
    return { body, orientation: best.label, rotated: false };
  }

  let axis: Vec3;
  let angle: number;
  if (d < -0.9999) {
    // Opposite direction: flip 180° about any perpendicular axis.
    axis = { x: 1, y: 0, z: 0 };
    angle = Math.PI;
  } else {
    axis = cross(up, target);
    angle = Math.acos(Math.max(-1, Math.min(1, d)));
  }

  // Rotate about the origin (no translation) — absolute position is irrelevant
  // for orientation, and translating would perturb the imperfectly-wound mesh.
  const rotated = rotateBody(body, { origin: { x: 0, y: 0, z: 0 }, direction: axis }, angle);
  return { body: rotated, orientation: best.label, rotated: true };
}
