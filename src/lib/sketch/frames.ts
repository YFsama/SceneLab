/**
 * Canonical sketch-plane frames, as PURE math (plain {x,y,z} tuples, no
 * THREE import) so feature evaluators can map sketch coordinates to world
 * space exactly the way the viewport renders them.
 *
 * NOTE: ViewportCanvas.tsx keeps its own private THREE.Vector3 copy of this
 * table (SKETCH_PLANE_FRAMES) — the two must stay in sync; this module is the
 * canonical source for evaluators, and the viewport copy should eventually be
 * unified onto it.
 *
 * Frame semantics (mirroring the viewport's sketch-to-world transform):
 *   world = u * sketch.x + v * sketch.y
 * so sketch (0,0) sits at the world origin, sketch +x runs along `u`, sketch
 * +y along `v` (the "in-plane vertical"), and `normal` is the plane's outward
 * direction — the natural extrude direction of a profile drawn on the plane.
 * Note xz is left-handed (u × v = −normal): the ground plane keeps its normal
 * +Y while sketch +y still maps to world +Z, matching how sketches are drawn.
 */

/** Plain 3-vector — deliberately structurally identical to geometry Vec3. */
export interface FrameVec3 {
  x: number;
  y: number;
  z: number;
}

/** An origin-centred orthonormal frame: two in-plane axes and the normal. */
export interface SketchPlaneFrame {
  normal: FrameVec3;
  u: FrameVec3;
  v: FrameVec3;
}

/** The three datum planes a sketch can live on (store's SketchPlaneId). */
export type CanonicalSketchPlaneId = 'xy' | 'xz' | 'yz';

export const SKETCH_PLANE_FRAMES: Record<CanonicalSketchPlaneId, SketchPlaneFrame> = {
  // Front plane (world XY): horizontal X, vertical Y, normal +Z.
  xy: { normal: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  // Ground plane (world XZ): horizontal X, "vertical" Z, normal +Y.
  xz: { normal: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  // Side plane (world YZ): horizontal Y, vertical Z, normal +X.
  yz: { normal: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } },
};

/**
 * The frame for a sketch plane id. Unknown ids (offset/derived planes the
 * evaluators don't model yet) fall back to the ground plane — the same
 * fallback the viewport uses, and the mapping every evaluator used before
 * frames existed.
 */
export function sketchFrame(planeId: string): SketchPlaneFrame {
  return SKETCH_PLANE_FRAMES[planeId as CanonicalSketchPlaneId] ?? SKETCH_PLANE_FRAMES.xz;
}

/**
 * Map a sketch-space point to world space: world = u·x + v·y. This is exactly
 * where the viewport draws the point, so an extruded profile starts on the
 * plane the user drew it on.
 */
export function sketchToWorld(planeId: string, x: number, y: number): FrameVec3 {
  const f = sketchFrame(planeId);
  return {
    x: f.u.x * x + f.v.x * y,
    y: f.u.y * x + f.v.y * y,
    z: f.u.z * x + f.v.z * y,
  };
}

/** The plane's normal — the natural extrude direction of a sketch profile. */
export function planeNormal(planeId: string): FrameVec3 {
  return { ...sketchFrame(planeId).normal };
}
