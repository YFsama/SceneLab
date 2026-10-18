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
   * Provenance of the analytic surface this face lies on, when a geometry
   * kernel can attribute it. Producers and consumers by `kind`:
   *
   * - 'cylinder' — SET by the exact (Manifold) boolean output conversion in
   *   `booleanManifold.ts` (a face group whose vertices all lie on one circle
   *   swept along a common axis — a full ≥300° wall, not a fragment) and by
   *   `brep.ts` createRevolve for profile edges parallel to the axis.
   *   CONSUMED by STEP export (CYLINDRICAL_SURFACE + CIRCLE rims); hole
   *   recognition (query.ts) and drawing circles re-fit from geometry and
   *   deliberately ignore the tag.
   * - 'cone' — same producers (linearly-varying section radius, half angle
   *   > 2°) and same STEP consumer (CONICAL_SURFACE).
   * - 'sphere' — set by the boolean classifier (algebraic sphere fit); STEP
   *   export writes SPHERICAL_SURFACE from it.
   * - 'plane', 'torus' — NO PRODUCER yet (reserved: hand-tagged tests,
   *   serialization round-trips them; a future SMLib/kernel pass may set
   *   them). STEP export honors a hand-set tag (PLANE is emitted from the
   *   face normal regardless; TOROIDAL_SURFACE from the tag).
   *
   * Primitives built by `brep.ts` (except revolve bands), the voxel kernels
   * and imported meshes do NOT set this (facet soup and hand-built meshes
   * are not classified).
   */
  source?: FaceSource;
}

/**
 * Analytic surface a face was classified against (see `Face.source`). The
 * 'cylinder' member is frozen — it has serialization assets in saved
 * .studio3d files and a STEP writer contract; new kinds must remain
 * load-side tolerant (studio3d.ts drops unknown/malformed kinds and keeps
 * the geometry).
 */
export type FaceSource =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number }
  /** Apex plus the unit axis pointing from the apex INTO the surface band:
   *  a band vertex at axial distance t > 0 from the apex sits at radial
   *  distance t·tan(halfAngle) from the axis. */
  | { kind: 'cone'; apex: Vec3; axis: Vec3; halfAngle: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'torus'; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number };

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
