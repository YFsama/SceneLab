export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Face {
  id: string;
  vertices: Vec3[];
  normal: Vec3;
  /**
   * Provenance of the surface this face lies on, when the geometry kernel can
   * attribute it. Set by the exact (Manifold) boolean output conversion in
   * `booleanManifold.ts`: a face group whose vertices all lie on one circle
   * swept along a common axis (a full — ≥300° — cylindrical wall, not a
   * fragment) carries the analytic cylinder it came from, so downstream
   * consumers (hole recognition, CAM feature detection, drawing-circle
   * extraction) can recover radius/axis exactly instead of re-fitting.
   * Primitives built by `brep.ts`, the voxel kernels and imported meshes do
   * NOT set this (facet soup and hand-built meshes are not classified).
   */
  source?: FaceSource;
}

/** Analytic surface a face was classified against (see `Face.source`). */
export type FaceSource =
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number };

export interface Edge {
  id: string;
  start: Vec3;
  end: Vec3;
}

export interface SolidBody {
  id: string;
  name: string;
  vertices: Vec3[];
  faces: Face[];
  edges: Edge[];
  /** Optional display colour (0xRRGGBB). Undefined renders with the default. */
  color?: number;
  /** Optional display opacity 0–1 (undefined/1 = opaque). */
  opacity?: number;
  /** Optional material key (drives mass/density); undefined = default 'steel'. */
  material?: string;
}

export interface ExtrudeParams {
  profile: Vec3[]; // 2D profile points (in sketch plane)
  direction: Vec3; // extrude direction
  distance: number;
  symmetric?: boolean;
}

export interface RevolveParams {
  profile: Vec3[];
  axis: { origin: Vec3; direction: Vec3 };
  angle: number; // radians
}

export interface PlaneDefinition {
  id: string;
  name: string;
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}
