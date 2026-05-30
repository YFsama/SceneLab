import type { SolidBody, Vec3 } from './types';
import { computeBoundingBox, computeBoundingBoxCenter } from './brep';
import { mirrorMerge, splitByPlane } from './boolean';
import { makePlane } from './referenceGeometry';

export type Axis = 'x' | 'y' | 'z';

const AXIS_NORMAL: Record<Axis, Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

/**
 * Mirror a body about the plane on its lower (min) bounding-box face along an
 * axis and fuse the two into one symmetric solid — the common "make this part
 * symmetric" move, doubling its size along the axis. Returns null if the merge
 * is empty.
 */
export function mirrorAcrossAxis(body: SolidBody, axis: Axis, resolution = 40): SolidBody | null {
  const bb = computeBoundingBox(body);
  const center = computeBoundingBoxCenter(body);
  const origin: Vec3 = { ...center, [axis]: bb.min[axis] };
  return mirrorMerge(body, { origin, normal: AXIS_NORMAL[axis] }, resolution);
}

/**
 * Split a body in half with the axis-aligned plane through its bounding-box
 * centre (SolidWorks Split). Returns the resulting halves (0–2 solids).
 */
export function splitAcrossAxis(body: SolidBody, axis: Axis, resolution = 40): SolidBody[] {
  const center = computeBoundingBoxCenter(body);
  const plane = makePlane(center, AXIS_NORMAL[axis]);
  const { positive, negative } = splitByPlane(body, plane, resolution);
  return [positive, negative].filter((b): b is SolidBody => b !== null);
}
