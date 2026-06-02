import type { SolidBody } from './geometry/types';
import { computeVolume } from './geometry/brep';
import { minDistanceBetweenBodies } from './geometry/measure';

export interface SelectionSummary {
  count: number;
  /** Combined bounding-box extents (mm). */
  size: { x: number; y: number; z: number };
  /** Sum of the bodies' (absolute) volumes (mm³). */
  totalVolume: number;
  /** Minimum surface gap between the two bodies (mm); only when exactly two. */
  gap?: number;
}

/**
 * Aggregate stats for a multi-body selection: count, the combined bounding-box
 * size, and total volume — shown in the properties panel so selecting several
 * bodies is informative rather than blank. Returns null for an empty selection.
 */
export function selectionSummary(bodies: SolidBody[]): SelectionSummary | null {
  if (bodies.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let totalVolume = 0;
  for (const b of bodies) {
    totalVolume += Math.abs(computeVolume(b));
    for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
  }
  const gap = bodies.length === 2 ? minDistanceBetweenBodies(bodies[0]!, bodies[1]!) : undefined;
  return { count: bodies.length, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }, totalVolume, gap };
}
