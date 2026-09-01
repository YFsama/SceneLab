/**
 * Boolean / split / hollow entry points. Exact WASM (Manifold) results first;
 * the voxel approximation backs everything up. The async variants offload the
 * slow voxel path to a Web Worker (see lib/workers) so the main thread stays
 * responsive, falling back to synchronous execution where Workers are absent
 * (tests, non-browser hosts).
 */
import type { SolidBody, Vec3, PlaneDefinition } from './types';
import { applyMirror } from './operations';
import {
  booleanOpVoxel,
  mirrorMergeVoxel,
  splitByPlaneVoxel,
  hollowBodyVoxel,
} from './booleanVoxel';
import type { BooleanOp } from './booleanVoxel';
import { booleanOpManifold, splitByPlaneManifold, warmUpBooleanEngine, isManifoldEngineReady } from './booleanManifold';
import { runGeometryOp } from '../workers/geometryWorkerClient';

export type { BooleanOp } from './booleanVoxel';
export { warmUpBooleanEngine, isManifoldEngineReady };

/**
 * Boolean of two solids (union / difference A−B / intersect). Exact (Manifold)
 * when the engine is warm; otherwise a voxel approximation — occupancy sampled
 * on a grid via point-in-mesh tests, boundary faces emitted between solid and
 * empty cells. The voxel result is blocky, with fidelity growing with
 * `resolution`. Returns null if the result is empty.
 */
export function booleanOp(a: SolidBody, b: SolidBody, op: BooleanOp, resolution = 32): SolidBody | null {
  // Exact path first — null covers "not ready" and "fell back internally".
  const exact = booleanOpManifold(a, b, op);
  if (exact) return exact;
  return booleanOpVoxel(a, b, op, resolution);
}

/** Worker-offloaded boolean: exact on the main thread (it's milliseconds),
 *  voxel sampling in the background when the exact engine can't help. */
export function asyncBooleanOp(a: SolidBody, b: SolidBody, op: BooleanOp, resolution = 32): Promise<SolidBody | null> {
  const exact = booleanOpManifold(a, b, op);
  if (exact) return Promise.resolve(exact);
  return runGeometryOp('voxelBoolean', { a, b, op, resolution }, () => booleanOpVoxel(a, b, op, resolution));
}

/**
 * Mirror a body across a plane and fuse the original with its reflection into
 * a single symmetric solid (SolidWorks Mirror with "merge solids"). Voxel
 * union; blocky result, raise `resolution` for fidelity.
 */
export function mirrorMerge(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3 },
  resolution = 40,
): SolidBody | null {
  return mirrorMergeVoxel(body, plane, resolution);
}
export type { Vec3 } from './types';

/**
 * Split a solid with a datum plane (SolidWorks "Split" / planar cut). Uses the
 * exact WASM engine when warm (intersect with two half-space boxes — a clean
 * planar cut surface); otherwise voxel-partition by the side of the plane each
 * cell centre falls on. Each side is a watertight solid; a side with no volume
 * comes back null.
 */
export function splitByPlane(
  body: SolidBody,
  plane: PlaneDefinition,
  resolution = 40,
): { positive: SolidBody | null; negative: SolidBody | null } {
  // Exact path first; nulls mean "not ready / not convertible".
  const exact = splitByPlaneManifold(body, plane);
  if (exact.positive || exact.negative) return exact;
  return splitByPlaneVoxel(body, plane, resolution);
}

/** Worker-offloaded split: exact on the main thread, voxel in the background. */
export function asyncSplitByPlane(
  body: SolidBody,
  plane: PlaneDefinition,
  resolution = 40,
): Promise<{ positive: SolidBody | null; negative: SolidBody | null }> {
  const exact = splitByPlaneManifold(body, plane);
  if (exact.positive || exact.negative) return Promise.resolve(exact);
  return runGeometryOp('voxelSplit', { body, plane, resolution }, () => splitByPlaneVoxel(body, plane, resolution));
}

/**
 * Hollow a solid into a closed shell of approximately `wallThickness` — a true
 * lightweighting hollow (unlike the placeholder applyShell). Voxel-only (no
 * exact path yet), so the async variant is the one UI paths should prefer.
 */
export function hollowBody(body: SolidBody, wallThickness: number, resolution = 40): SolidBody | null {
  return hollowBodyVoxel(body, wallThickness, resolution);
}

export function asyncHollowBody(body: SolidBody, wallThickness: number, resolution = 40): Promise<SolidBody | null> {
  return runGeometryOp('voxelHollow', { body, wallThickness, resolution }, () => hollowBodyVoxel(body, wallThickness, resolution));
}

export { applyMirror };
