import type { SolidBody, Vec3 } from '../geometry/types';

export interface Bounds { min: Vec3; max: Vec3 }

/** Combined axis-aligned bounds over every vertex of the given bodies; null if empty. */
export function combinedBounds(bodies: SolidBody[]): Bounds | null {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let any = false;
  for (const b of bodies) {
    for (const v of b.vertices) {
      any = true;
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
  }
  return any ? { min, max } : null;
}

/**
 * Camera distance (from the target) that fits a box of the given size in view,
 * accounting for both vertical FOV and aspect-derived horizontal FOV so nothing
 * is clipped on the narrow axis. `margin` (>1) leaves padding around the part.
 */
export function fitCameraDistance(size: Vec3, fovDeg: number, aspect: number, margin = 1.2): number {
  const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
  if (radius < 1e-9) return 1; // degenerate (single point) — a sane default
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(aspect, 1e-6));
  const fov = Math.min(vfov, hfov);
  return (radius / Math.sin(fov / 2)) * margin;
}
