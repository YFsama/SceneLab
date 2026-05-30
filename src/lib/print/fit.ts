import type { SolidBody, Vec3 } from '../geometry/types';
import { computeBoundingBox, scaleBody } from '../geometry';

export interface FitScaleResult {
  /** Uniform factor that makes the part exactly fit the build volume. */
  factor: number;
  /** Whether the part already fits at scale 1 (factor >= 1). */
  fits: boolean;
  /** The part's current bounding-box size. */
  size: Vec3;
}

/**
 * Compute the uniform scale factor that fits a body inside a printer build
 * volume (optionally leaving a margin on each side). factor < 1 means the part
 * must shrink; factor >= 1 means it already fits with room to spare.
 */
export function computeFitScale(body: SolidBody, build: Vec3, margin = 0): FitScaleResult {
  const bb = computeBoundingBox(body);
  const size: Vec3 = {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z,
  };
  const avail: Vec3 = {
    x: Math.max(0, build.x - 2 * margin),
    y: Math.max(0, build.y - 2 * margin),
    z: Math.max(0, build.z - 2 * margin),
  };
  const ratios: number[] = [];
  if (size.x > 1e-9) ratios.push(avail.x / size.x);
  if (size.y > 1e-9) ratios.push(avail.y / size.y);
  if (size.z > 1e-9) ratios.push(avail.z / size.z);
  const factor = ratios.length ? Math.min(...ratios) : 1;
  return { factor, fits: factor >= 1, size };
}

/**
 * Scale a body to fit the build volume. Returns the original body unchanged if
 * it already fits (unless `force` shrinks/grows it to exactly fit).
 */
export function scaleToFit(body: SolidBody, build: Vec3, margin = 0, force = false): SolidBody {
  const { factor, fits } = computeFitScale(body, build, margin);
  if (fits && !force) return body;
  const bb = computeBoundingBox(body);
  const center: Vec3 = {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  };
  return scaleBody(body, factor, center);
}
