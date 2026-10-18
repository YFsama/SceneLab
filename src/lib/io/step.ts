/**
 * STEP AP214 (AUTOMOTIVE_DESIGN) export: writes a mesh body as a faceted
 * planar B-rep that OpenCASCADE-grade readers (FreeCAD, SolidWorks, KiCad,
 * occt-import-js) accept. The entity graph follows the canonical
 * ST-Developer-style chain those readers resolve:
 *
 *   SHAPE_DEFINITION_REPRESENTATION
 *     → PRODUCT_DEFINITION_SHAPE → PRODUCT_DEFINITION →
 *       PRODUCT_DEFINITION_FORMATION → PRODUCT
 *     → ADVANCED_BREP_SHAPE_REPRESENTATION (context: mm/radian
 *       GEOMETRIC_REPRESENTATION_CONTEXT)
 *       → MANIFOLD_SOLID_BREP → CLOSED_SHELL → ADVANCED_FACE →
 *         FACE_OUTER_BOUND → EDGE_LOOP → ORIENTED_EDGE → EDGE_CURVE (LINE) →
 *         VERTEX_POINT → CARTESIAN_POINT
 *
 * Two OCCT reader rules the file honours (the old writer violated both, and
 * OCCT rejected its output with "Incorrect Syntax"/"Unresolved Reference"):
 * every DIRECTION is unit length, and a face's single loop is wired through
 * FACE_OUTER_BOUND — not a bare FACE_BOUND. Our own faceted importer in
 * stepImport.ts reads both dialects.
 *
 * Analytic cylinders: faces tagged with Face.source {kind:'cylinder'} (set
 * by the exact boolean output classifier in booleanManifold.ts — it tags
 * every facet of a full cylindrical wall group) are written against a TRUE
 * CYLINDRICAL_SURFACE, one shared surface entity per cylinder. Cones
 * ({kind:'cone'}, same classifier) get the same treatment on a
 * CONICAL_SURFACE; sphere/torus tags map to SPHERICAL_SURFACE /
 * TOROIDAL_SURFACE with their polyline boundary.
 *
 *  - Isolated bands (rim vertices referenced by no other face) collapse to
 *    the canonical OCCT tube: one ADVANCED_FACE whose loop is a closed CIRCLE
 *    EDGE_CURVE per rim plus a LINE seam reused in both directions — a ⌀6
 *    hole wall becomes one face with two circles instead of 55 facets. Cone
 *    rims use the section radius r(t) = t·tan(halfAngle) at their height;
 *    the seam runs along a generator (a straight line on the cone).
 *  - Bands whose rims are shared with faceted neighbours (the usual drilled
 *    solid: the caps reference the rim vertices) keep the shared polyline
 *    chord edges as their boundary on the analytic surface. Emitting CIRCLE
 *    rims there would leave the caps' chord edges singly-used, and OCCT's
 *    reader splits the shell into pieces with meaningless volumes (measured:
 *    a drilled box came back as 3 solids, +11.8% volume). A faceted boundary
 *    on a true cylinder is legal STEP and round-trips exactly.
 *  - Faces whose tag does not fit two full rims (partial arcs, angled cuts,
 *    pointed cones) keep their own polyline loop on the shared analytic
 *    surface.
 */
import type { SolidBody, Vec3, Face, FaceSource } from '../geometry/types';

// ---- analytic surface contract (Face.source, geometry/types.ts) ------------

/** The cylinder variant of FaceSource (see geometry/types.ts). */
type CylinderSource = Extract<FaceSource, { kind: 'cylinder' }>;
/** The cone variant — a band source like a cylinder, with a linear radius law. */
type ConeSource = Extract<FaceSource, { kind: 'cone' }>;
/** The sphere variant of FaceSource (fit by the classifier or hand-set). */
type SphereSource = Extract<FaceSource, { kind: 'sphere' }>;
/** The torus variant — hand-set only (no classifier producer yet). */
type TorusSource = Extract<FaceSource, { kind: 'torus' }>;

/** The variants that can form an isolated two-rim band: cylinder or cone. */
type RevolutionSource = CylinderSource | ConeSource;

/** The source tag of a face when (and only when) it is a usable cylinder. */
function cylinderSourceOf(face: Face): CylinderSource | null {
  const src = face.source;
  if (!src || src.kind !== 'cylinder') return null;
  if (!(src.radius > 0)) return null; // NaN/zero/negative — unusable
  if (Math.hypot(src.axis.x, src.axis.y, src.axis.z) < 1e-12) return null;
  return src;
}

/** Same gate for cones: a finite half angle strictly inside (0, π/2). The
 *  lower bound also protects the writer: num() formats 6 decimals, so a
 *  half angle below 1e-6 rad would emit a "0.000000" semi_angle — a
 *  degenerate cone OCCT cannot rebuild; such faces fall back to the
 *  faceted path instead. */
function coneSourceOf(face: Face): ConeSource | null {
  const src = face.source;
  if (!src || src.kind !== 'cone') return null;
  if (!(src.halfAngle >= 1e-6) || !(src.halfAngle < Math.PI / 2)) return null;
  if (Math.hypot(src.axis.x, src.axis.y, src.axis.z) < 1e-12) return null;
  return src;
}

/** The face's tag when it can be emitted as a two-rim band, else null. */
function revolutionSourceOf(face: Face): RevolutionSource | null {
  return cylinderSourceOf(face) ?? coneSourceOf(face);
}

/** Same gate for spheres. */
function sphereSourceOf(face: Face): SphereSource | null {
  const src = face.source;
  if (!src || src.kind !== 'sphere') return null;
  if (!(src.radius > 0)) return null;
  return src;
}

/** Same gate for tori: a positive minor radius that fits inside the major. */
function torusSourceOf(face: Face): TorusSource | null {
  const src = face.source;
  if (!src || src.kind !== 'torus') return null;
  if (!(src.majorRadius > 0) || !(src.minorRadius > 0) || src.minorRadius > src.majorRadius) return null;
  if (Math.hypot(src.axis.x, src.axis.y, src.axis.z) < 1e-12) return null;
  return src;
}

/**
 * The radius law of a revolution tag at axial height `t` (measured from the
 * tag's on-axis reference: the cylinder origin / the cone apex): cylinders
 * are constant, cones grow as t·tan(halfAngle).
 */
function revolutionRadiusAt(src: RevolutionSource, t: number): number {
  return src.kind === 'cylinder' ? src.radius : t * Math.tan(src.halfAngle);
}

/** The on-axis reference point of a revolution tag (origin / apex). */
function revolutionOriginOf(src: RevolutionSource): Vec3 {
  return src.kind === 'cylinder' ? src.origin : src.apex;
}

// ---- small vector helpers ---------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scaled = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

// ---- revolution rim detection ----------------------------------------------

/** One detected rim ring of a full revolution band face (cylinder or cone). */
interface SurfaceRim {
  /** Mean height of the ring along the unit surface axis (from the tag's
   *  on-axis reference: the cylinder origin / the cone apex). */
  t: number;
  /** Section radius at `t` — the cylinder radius / t·tan(halfAngle). */
  radius: number;
  /** The ring's vertices (used for the shared-rim guard). */
  verts: Vec3[];
}

/**
 * Fit tolerance for a face's tessellation against its analytic surface (mm):
 * tessellation vertices lie ON the surface (only the chords between them
 * deviate, and only inward), so this merely absorbs floating-point noise and
 * kernel re-tessellation — 0.1 % of the radius with a 0.1 µm floor.
 */
const cylFitTol = (radius: number) => Math.max(1e-4, radius * 1e-3);

/**
 * Detect the two boundary rims of a FULL revolution band face (cylinder or
 * cone), in the frame of the tag's axis line (`lineOrigin` + unit `axis`)
 * with its radius law `radiusAt(t)` and the fit-tolerance scale `refRadius`.
 * Requirements, all against the fit tolerance above:
 *  - every vertex sits on the analytic surface (radial distance = radiusAt(t));
 *  - the vertices split into exactly two groups at the largest gap between
 *    their sorted axial heights (gap > tol, so the band has real extent);
 *  - each group is planar perpendicular to the axis (axial spread ≤ tol);
 *  - each group's centroid sits on the axis;
 *  - each group wraps the full circle: the largest angular gap between
 *    neighbouring vertices is ≤ π/2 (an adaptive full ring is ≥ 8 segments,
 *    i.e. gaps ≤ π/4; a half-cylinder's missing span is ≈ π).
 *
 * Anything else — a partial arc, an angled (elliptical) cut, a tag that does
 * not fit the vertices — returns null and the writer falls back to emitting
 * the face's existing polyline EDGE_LOOP on the analytic surface.
 */
function detectRevolutionRims(
  verts: Vec3[],
  lineOrigin: Vec3,
  axis: Vec3,
  radiusAt: (t: number) => number,
  refRadius: number,
): SurfaceRim[] | null {
  const a = unit3(axis);
  const tol = cylFitTol(refRadius);

  const keyed = verts.map((v) => {
    const d = sub(v, lineOrigin);
    const t = dot(d, a);
    const radial = sub(d, scaled(a, t));
    return { v, t, radialDist: Math.hypot(radial.x, radial.y, radial.z) };
  });
  if (!keyed.every((p) => Math.abs(p.radialDist - radiusAt(p.t)) <= tol)) return null;

  keyed.sort((p, q) => p.t - q.t);
  let cut = 0;
  let gap = 0;
  for (let i = 0; i + 1 < keyed.length; i++) {
    const g = keyed[i + 1]!.t - keyed[i]!.t;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  if (gap <= tol) return null; // all one plane — not a band
  const groups = [keyed.slice(0, cut + 1), keyed.slice(cut + 1)];

  const refDir = perpendicularUnit(a);
  const side = cross(a, refDir);
  const rims: SurfaceRim[] = [];
  for (const g of groups) {
    if (g.length < 3) return null; // a rim needs ≥ 3 points to bound a circle
    if (g[g.length - 1]!.t - g[0]!.t > tol) return null; // ring not ⟂ axis
    const n = g.length;
    const centroid: Vec3 = {
      x: g.reduce((s, p) => s + p.v.x, 0) / n,
      y: g.reduce((s, p) => s + p.v.y, 0) / n,
      z: g.reduce((s, p) => s + p.v.z, 0) / n,
    };
    const cd = sub(centroid, lineOrigin);
    const cradial = sub(cd, scaled(a, dot(cd, a)));
    if (Math.hypot(cradial.x, cradial.y, cradial.z) > tol) return null; // centroid off the axis

    const angles = g
      .map((p) => {
        const d = sub(p.v, centroid);
        return Math.atan2(dot(d, side), dot(d, refDir));
      })
      .sort((x, y) => x - y);
    let maxArc = angles[0]! + Math.PI * 2 - angles[angles.length - 1]!;
    for (let i = 0; i + 1 < angles.length; i++) {
      maxArc = Math.max(maxArc, angles[i + 1]! - angles[i]!);
    }
    if (maxArc > Math.PI / 2) return null; // partial arc — keep the polyline
    const t = (g[0]!.t + g[n - 1]!.t) / 2;
    rims.push({ t, radius: radiusAt(t), verts: g.map((p) => p.v) });
  }
  return rims;
}

let nextId = 1;
const id = () => nextId++;

/** Format a STEP entity ID. */
const ref = (n: number) => `#${n}`;

/** Format a number with fixed precision (mm-scale models). */
const num = (n: number) => n.toFixed(6);

/** Escape a string for embedding in a STEP literal (without the quotes). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we scrub
const escaped = (s: string) => s.replace(/[\x00-\x1f\x7f-\uffff]/g, '_').replace(/'/g, "''");

/**
 * Format a STEP string literal: quotes double per ISO 10303-21, and
 * characters outside printable ASCII are scrubbed (Part 21 text is ASCII;
 * extended characters would need \X2\ escapes).
 */
function str(s: string): string {
  return `'${escaped(s)}'`;
}

/** Format a STEP list. */
const list = (items: string[]) => `(${items.join(',')})`;

interface Ent {
  id: number;
  text: string;
}

/** Format a CARTESIAN_POINT. */
function cartesianPoint(x: number, y: number, z: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CARTESIAN_POINT('',(${num(x)},${num(y)},${num(z)}));` };
}

/** Format a DIRECTION (callers must pass an already-normalised vector). */
function direction(x: number, y: number, z: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=DIRECTION('',(${num(x)},${num(y)},${num(z)}));` };
}

/** Format a VECTOR (direction ref + magnitude). */
function vector(dirId: number, magnitude: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=VECTOR('',${ref(dirId)},${num(magnitude)});` };
}

/** Format a VERTEX_POINT. */
function vertexPoint(ptId: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=VERTEX_POINT('',${ref(ptId)});` };
}

/**
 * Format an EDGE_CURVE — exactly five arguments: name, start vertex, end
 * vertex, edge geometry, same sense. (The pre-repair writer emitted a second
 * name argument, which shifted every reference one slot and is why OCCT
 * transferred zero usable geometry from our files.)
 */
function edgeCurve(v1Id: number, v2Id: number, curveId: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=EDGE_CURVE('',${ref(v1Id)},${ref(v2Id)},${ref(curveId)},.T.);` };
}

/** Format an ORIENTED_EDGE (vertices come from the EDGE_CURVE via `*`). */
function orientedEdge(edgeId: number, orientation: boolean): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=ORIENTED_EDGE('',*,*,${ref(edgeId)},${orientation ? '.T.' : '.F.'});` };
}

/** Format an EDGE_LOOP. */
function edgeLoop(oeIds: number[]): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=EDGE_LOOP('',${list(oeIds.map(ref))});` };
}

/**
 * Format the outer boundary of a face. A face with one loop must declare it
 * as FACE_OUTER_BOUND — OCCT treats a bare FACE_BOUND as improperly bound.
 */
function faceOuterBound(loopId: number, orientation: boolean): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=FACE_OUTER_BOUND('',${ref(loopId)},${orientation ? '.T.' : '.F.'});` };
}

/** Format an ADVANCED_FACE. */
function advancedFace(boundIds: number[], surfaceId: number, sameSense: boolean): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=ADVANCED_FACE('',${list(boundIds.map(ref))},${ref(surfaceId)},${sameSense ? '.T.' : '.F.'});` };
}

/** Format an AXIS2_PLACEMENT_3D from already-emitted point/direction entities. */
function axis2Placement(locId: number, axisId: number, refId: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=AXIS2_PLACEMENT_3D('',${ref(locId)},${ref(axisId)},${ref(refId)});` };
}

/** Format a CYLINDRICAL_SURFACE over an AXIS2_PLACEMENT_3D. */
function cylindricalSurface(placementId: number, radius: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CYLINDRICAL_SURFACE('',${ref(placementId)},${num(radius)});` };
}

/**
 * Format a CONICAL_SURFACE over an AXIS2_PLACEMENT_3D: placement axis along
 * the cone axis, `radius` the section radius AT the placement location, and
 * the half angle in radians (the file's angle unit). OCCT reconstructs the
 * apex at location − axis·(radius / tan(halfAngle)) — the caller keeps the
 * tag's apex/axis consistent with that reconstruction.
 */
function conicalSurface(placementId: number, radius: number, halfAngle: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CONICAL_SURFACE('',${ref(placementId)},${num(radius)},${num(halfAngle)});` };
}

/** Format a SPHERICAL_SURFACE over an AXIS2_PLACEMENT_3D (the placement
 *  location is the center; the axis only fixes the parametrization poles). */
function sphericalSurface(placementId: number, radius: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=SPHERICAL_SURFACE('',${ref(placementId)},${num(radius)});` };
}

/** Format a TOROIDAL_SURFACE over an AXIS2_PLACEMENT_3D (major + minor). */
function toroidalSurface(placementId: number, majorRadius: number, minorRadius: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=TOROIDAL_SURFACE('',${ref(placementId)},${num(majorRadius)},${num(minorRadius)});` };
}

/** Format a CIRCLE (centre = placement location, radius in the placement plane). */
function circleCurve(placementId: number, radius: number): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CIRCLE('',${ref(placementId)},${num(radius)});` };
}

/** Format a CLOSED_SHELL. */
function closedShell(faceIds: number[]): Ent {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CLOSED_SHELL('',${list(faceIds.map(ref))});` };
}

/** A unit vector perpendicular to `n` (for AXIS2_PLACEMENT_3D ref_direction). */
function perpendicularUnit(n: Vec3): Vec3 {
  // Cross with the least-dominant coordinate axis for numerical safety.
  const helper =
    Math.abs(n.x) <= Math.abs(n.y) && Math.abs(n.x) <= Math.abs(n.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(n.y) <= Math.abs(n.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const cx = n.y * helper.z - n.z * helper.y;
  const cy = n.z * helper.x - n.x * helper.z;
  const cz = n.x * helper.y - n.y * helper.x;
  const len = Math.hypot(cx, cy, cz) || 1;
  return { x: cx / len, y: cy / len, z: cz / len };
}

/**
 * Round to the 1e-7 identity grid numerically. A plain toFixed(7) would keep
 * float-noise twins apart when they straddle zero (−7e−16 prints as
 * '-0.0000000' vs '0.0000000'), splitting one ring seam vertex into two
 * entities and skewing rim fits; Math.round plus the `+ 0` folds −0 back
 * into 0 so both twins land on the same key.
 */
const grid7 = (n: number): number => Math.round(n * 1e7) / 1e7 + 0;

/**
 * Position key used to deduplicate vertices. Seven decimals (1e-7 mm = 0.1 µm)
 * on purpose: the loop dedup below drops consecutive repeats at the SAME
 * 1e-7 threshold, so a vertex the loop keeps and one the entity table merges
 * are always the same vertex. (The pass-30 audit's P3 asymmetry — dedup at
 * 1e-9 vs identity rounding at 1e-6 — let near-coincident loop vertices
 * survive dedup yet collapse onto one VERTEX_POINT, emitting zero-length
 * LINE entities between distinct loop positions.)
 */
const posKey = (v: Vec3) => `${grid7(v.x)},${grid7(v.y)},${grid7(v.z)}`;

/** Identity key for a cylinder source tag (faces sharing a key share one surface). */
const sourceKey = (c: CylinderSource): string =>
  [
    c.origin.x.toFixed(6),
    c.origin.y.toFixed(6),
    c.origin.z.toFixed(6),
    c.axis.x.toFixed(6),
    c.axis.y.toFixed(6),
    c.axis.z.toFixed(6),
    c.radius.toFixed(6),
  ].join(',');

/** Identity key for a cone tag — includes the kind so a cylinder and a cone
 *  with coincident axis lines never share a surface entity. */
const coneKey = (c: ConeSource): string =>
  [
    'cone',
    c.apex.x.toFixed(6),
    c.apex.y.toFixed(6),
    c.apex.z.toFixed(6),
    c.axis.x.toFixed(6),
    c.axis.y.toFixed(6),
    c.axis.z.toFixed(6),
    c.halfAngle.toFixed(9), // radians — the small numbers need the digits
  ].join(',');

/** Identity key for a sphere tag. */
const sphereKey = (c: SphereSource): string =>
  ['sphere', c.center.x.toFixed(6), c.center.y.toFixed(6), c.center.z.toFixed(6), c.radius.toFixed(6)].join(',');

/** Identity key for a torus tag. */
const torusKey = (c: TorusSource): string =>
  [
    'torus',
    c.center.x.toFixed(6),
    c.center.y.toFixed(6),
    c.center.z.toFixed(6),
    c.axis.x.toFixed(6),
    c.axis.y.toFixed(6),
    c.axis.z.toFixed(6),
    c.majorRadius.toFixed(6),
    c.minorRadius.toFixed(6),
  ].join(',');

/**
 * The canonical CONICAL_SURFACE placement reference: a fixed axial distance
 * from the tag's apex. STEP's cone radius is the section radius AT the
 * placement location — the surface itself is the same infinite cone for any
 * positive reference, but the value must be derived from the TAG ALONE so
 * every face of one cone deduplicates onto one surface entity.
 */
const CONE_SURFACE_REF_T = 1;

/**
 * Export a SolidBody as a STEP AP214 file string. Each face is written as a
 * planar ADVANCED_FACE with a FACE_OUTER_BOUND EDGE_LOOP boundary; shared
 * edges between faces are emitted once and re-used with the appropriate
 * ORIENTED_EDGE orientation flag.
 */
export function exportSTEP(body: SolidBody): string {
  nextId = 1;
  const entities: string[] = [];
  const emit = (text: string) => entities.push(text);

  // ---- Product structure (the chain every CAD reader resolves) -----------
  const appCtxId = id();
  emit(`${ref(appCtxId)}=APPLICATION_CONTEXT('core data for automotive mechanical design processes');`);
  const apdId = id();
  emit(`${ref(apdId)}=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2009,${ref(appCtxId)});`);
  const prodCtxId = id();
  emit(`${ref(prodCtxId)}=PRODUCT_CONTEXT('part definition',${ref(appCtxId)},'design');`);
  const prodId = id();
  emit(`${ref(prodId)}=PRODUCT(${str(body.name)},${str(body.name)},'',(${ref(prodCtxId)}));`);
  const prpcId = id();
  emit(`${ref(prpcId)}=PRODUCT_RELATED_PRODUCT_CATEGORY('detail','',(${ref(prodId)}));`);
  const pdfId = id();
  emit(`${ref(pdfId)}=PRODUCT_DEFINITION_FORMATION('','',${ref(prodId)});`);
  const pdcId = id();
  emit(`${ref(pdcId)}=PRODUCT_DEFINITION_CONTEXT('part definition',${ref(appCtxId)},'design');`);
  const pdId = id();
  emit(`${ref(pdId)}=PRODUCT_DEFINITION('','',${ref(pdfId)},${ref(pdcId)});`);
  const pdsId = id();
  emit(`${ref(pdsId)}=PRODUCT_DEFINITION_SHAPE('','',${ref(pdId)});`);

  // ---- Units and the geometric representation context ---------------------
  // Millimetre/radian/steradian SI units; every *_SHAPE_REPRESENTATION must
  // reference a context like this (the old writer pointed its representation
  // at the APPLICATION_CONTEXT, which is what OCCT flagged unresolved).
  const lenUnitId = id();
  emit(`${ref(lenUnitId)}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`);
  const angUnitId = id();
  emit(`${ref(angUnitId)}=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`);
  const solidUnitId = id();
  emit(`${ref(solidUnitId)}=(NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.));`);
  const uncId = id();
  emit(
    `${ref(uncId)}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),${ref(lenUnitId)},'DISTANCE_ACCURACY_VALUE',` +
      `'Maximum model space distance between geometric entities at asserted connectivities');`,
  );
  const ctxId = id();
  emit(
    `${ref(ctxId)}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)` +
      `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${ref(uncId)}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${ref(lenUnitId)},${ref(angUnitId)},${ref(solidUnitId)}))` +
      `REPRESENTATION_CONTEXT('','3D'));`,
  );

  // ---- Geometry: unique vertices, edges, faces ----------------------------
  const vertMap = new Map<string, number>(); // position key → VERTEX_POINT id
  const ptMap = new Map<string, number>(); // position key → CARTESIAN_POINT id

  const getVertex = (v: Vec3): number => {
    const key = posKey(v);
    if (vertMap.has(key)) return vertMap.get(key)!;
    const pt = cartesianPoint(v.x, v.y, v.z);
    emit(pt.text);
    const vtx = vertexPoint(pt.id);
    emit(vtx.text);
    vertMap.set(key, vtx.id);
    ptMap.set(key, pt.id);
    return vtx.id;
  };

  // Edges are deduplicated by vertex pair. The stored direction may be the
  // reverse of a given face's traversal — the ORIENTED_EDGE flag below
  // carries that flip so consumers walk every loop in order.
  const edgeMap = new Map<string, { id: number; fromId: number }>();

  const getEdge = (v1: Vec3, v2: Vec3): { id: number; fromId: number } => {
    const v1id = getVertex(v1);
    const v2id = getVertex(v2);
    const key = v1id < v2id ? `${v1id},${v2id}` : `${v2id},${v1id}`;
    const cached = edgeMap.get(key);
    if (cached) return cached;
    // LINE for the edge: origin at v1, UNIT direction, magnitude in VECTOR.
    // (Zero-length edges are already filtered out by the loop dedup below.)
    const p1 = ptMap.get(posKey(v1))!;
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const dz = v2.z - v1.z;
    const mag = Math.hypot(dx, dy, dz);
    const dir = direction(dx / mag, dy / mag, dz / mag);
    emit(dir.text);
    const vec = vector(dir.id, mag);
    emit(vec.text);
    const lineId = id();
    emit(`${ref(lineId)}=LINE('',${ref(p1)},${ref(vec.id)});`);
    const ec = edgeCurve(v1id, v2id, lineId);
    emit(ec.text);
    const entry = { id: ec.id, fromId: v1id };
    edgeMap.set(key, entry);
    return entry;
  };

  /**
   * Cached analytic surface entities per source key (shared by all facets of
   * one surface — the classifier tags every facet of a wall group). One cache
   * for every kind; the keys are kind-prefixed where collisions are possible.
   */
  const analyticSurfaces = new Map<string, number>();

  /** Shared placement emitter: CARTESIAN_POINT + axis/ref DIRECTIONs. */
  const emitPlacement = (loc: Vec3, aHat: Vec3, refDir: Vec3): number => {
    const locEnt = cartesianPoint(loc.x, loc.y, loc.z);
    emit(locEnt.text);
    const axisDir = direction(aHat.x, aHat.y, aHat.z);
    emit(axisDir.text);
    const refDEnt = direction(refDir.x, refDir.y, refDir.z);
    emit(refDEnt.text);
    const placement = axis2Placement(locEnt.id, axisDir.id, refDEnt.id);
    emit(placement.text);
    return placement.id;
  };

  const getCylSurface = (cyl: CylinderSource): number => {
    const key = sourceKey(cyl);
    const cached = analyticSurfaces.get(key);
    if (cached !== undefined) return cached;
    const aHat = unit3(cyl.axis);
    const refDir = perpendicularUnit(aHat);
    const placementId = emitPlacement(cyl.origin, aHat, refDir);
    const surf = cylindricalSurface(placementId, cyl.radius);
    emit(surf.text);
    analyticSurfaces.set(key, surf.id);
    return surf.id;
  };

  /**
   * CONICAL_SURFACE for a cone tag: placement on the axis, a fixed reference
   * distance CONE_SURFACE_REF_T from the apex, so the emitted radius
   * (t·tan θ) is a pure function of the tag — every facet of one cone shares
   * the entity. The surface is the same infinite cone regardless of the
   * reference; the face boundaries carry the true extent.
   */
  const getConeSurface = (cone: ConeSource): number => {
    const key = coneKey(cone);
    const cached = analyticSurfaces.get(key);
    if (cached !== undefined) return cached;
    const aHat = unit3(cone.axis);
    const refDir = perpendicularUnit(aHat);
    const loc = add(cone.apex, scaled(aHat, CONE_SURFACE_REF_T));
    const placementId = emitPlacement(loc, aHat, refDir);
    const surf = conicalSurface(placementId, CONE_SURFACE_REF_T * Math.tan(cone.halfAngle), cone.halfAngle);
    emit(surf.text);
    analyticSurfaces.set(key, surf.id);
    return surf.id;
  };

  /** SPHERICAL_SURFACE for a sphere tag (placement at the center; the axis is
   *  parametrization-only, so a fixed +Z keeps it tag-deterministic). */
  const getSphereSurface = (sph: SphereSource): number => {
    const key = sphereKey(sph);
    const cached = analyticSurfaces.get(key);
    if (cached !== undefined) return cached;
    const placementId = emitPlacement(sph.center, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
    const surf = sphericalSurface(placementId, sph.radius);
    emit(surf.text);
    analyticSurfaces.set(key, surf.id);
    return surf.id;
  };

  /** TOROIDAL_SURFACE for a torus tag (placement at the center, axis = tag axis). */
  const getTorusSurface = (tor: TorusSource): number => {
    const key = torusKey(tor);
    const cached = analyticSurfaces.get(key);
    if (cached !== undefined) return cached;
    const aHat = unit3(tor.axis);
    const refDir = perpendicularUnit(aHat);
    const placementId = emitPlacement(tor.center, aHat, refDir);
    const surf = toroidalSurface(placementId, tor.majorRadius, tor.minorRadius);
    emit(surf.text);
    analyticSurfaces.set(key, surf.id);
    return surf.id;
  };

  /**
   * Emit an isolated full revolution band (cylinder or cone) as the canonical
   * OCCT tube:
   *
   *   {CYLINDRICAL,CONICAL}_SURFACE + EDGE_LOOP(bottom circle +u, seam up,
   *   top circle −u, seam down)
   *
   * The seam is a LINE at parametric u = 0 (the placement ref_direction ray)
   * reused in both directions — on a cone this is a generator, an exact
   * straight line on the surface; each rim is ONE closed CIRCLE EDGE_CURVE
   * whose start and end are the same VERTEX_POINT — the seam point of its
   * ring, because the circle's param-0 point lies on the ref_direction ray.
   * Rim radii follow the tag's radius law at the rim's height. The four
   * oriented edges chain vertex-to-vertex and the cycle is counter-clockwise
   * in the surface's UV rectangle, i.e. right-hand-rule along the outward
   * radial (natural) surface normal. When the face's own normal opposes that
   * (a hole wall points inward), same_sense and the bound orientation flip
   * together.
   */
  const emitBandedRevolution = (src: RevolutionSource, rims: SurfaceRim[], sense: boolean): number => {
    const aHat = unit3(src.axis);
    const refDir = perpendicularUnit(aHat);
    const lineOrigin = revolutionOriginOf(src);

    const centerAt = (t: number): Vec3 => add(lineOrigin, scaled(aHat, t));
    const seamLow = add(centerAt(rims[0]!.t), scaled(refDir, rims[0]!.radius));
    const seamHigh = add(centerAt(rims[1]!.t), scaled(refDir, rims[1]!.radius));

    const seam = getEdge(seamLow, seamHigh); // LINE along a generator at u = 0
    const lowV = getVertex(seamLow);
    const highV = getVertex(seamHigh);

    const rimCircle = (t: number, radius: number, seamVertex: number): number => {
      const c = centerAt(t);
      const placementId = emitPlacement(c, aHat, refDir);
      const circ = circleCurve(placementId, radius);
      emit(circ.text);
      const ec = edgeCurve(seamVertex, seamVertex, circ.id); // closed edge
      emit(ec.text);
      return ec.id;
    };
    const lowCircle = rimCircle(rims[0]!.t, rims[0]!.radius, lowV);
    const highCircle = rimCircle(rims[1]!.t, rims[1]!.radius, highV);

    const oes = [
      orientedEdge(lowCircle, true), // bottom rim, +u
      orientedEdge(seam.id, seam.fromId === lowV), // seam up
      orientedEdge(highCircle, false), // top rim, −u
      orientedEdge(seam.id, seam.fromId === highV), // seam down (reversed)
    ];
    for (const oe of oes) emit(oe.text);
    const loop = edgeLoop(oes.map((oe) => oe.id));
    emit(loop.text);
    const bound = faceOuterBound(loop.id, sense);
    emit(bound.text);

    const surfaceId = src.kind === 'cylinder' ? getCylSurface(src) : getConeSurface(src);
    const af = advancedFace([bound.id], surfaceId, sense);
    emit(af.text);
    return af.id;
  };

  /**
   * Band planning: group tagged faces by identical source, try to fit two
   * full rims on the group's union, and keep the CIRCLE form only when no
   * other face of the body references a rim vertex. Shared rims mean
   * faceted neighbours (caps) whose chord edges would be left singly-used
   * by a circular wall boundary — OCCT splits such shells (measured: a
   * drilled box returned as 3 solids, +11.8% volume) — so those bands keep
   * the shared chord boundary per facet. Faces consumed by a band plan are
   * skipped in the main loop and emitted as one face afterwards.
   */
  interface BandPlan {
    src: RevolutionSource;
    rims: SurfaceRim[];
    faces: Set<Face>;
    sense: boolean;
  }
  const bandPlans: BandPlan[] = [];
  const facesInBands = new Set<Face>();
  {
    const groups = new Map<string, { src: RevolutionSource; faces: Face[] }>();
    for (const face of body.faces) {
      const src = revolutionSourceOf(face);
      if (!src) continue;
      const key = src.kind === 'cylinder' ? sourceKey(src) : coneKey(src);
      const group = groups.get(key) ?? { src, faces: [] };
      group.faces.push(face);
      groups.set(key, group);
    }
    const otherVertexKeys = new Set<string>();
    for (const face of body.faces) {
      if (revolutionSourceOf(face)) continue;
      for (const v of face.vertices) otherVertexKeys.add(posKey(v));
    }
    for (const { src, faces } of groups.values()) {
      const seen = new Set<string>();
      const verts: Vec3[] = [];
      for (const f of faces) {
        for (const v of f.vertices) {
          const key = posKey(v);
          if (!seen.has(key)) {
            seen.add(key);
            verts.push(v);
          }
        }
      }
      // Rim fit in the tag's own frame (cylinder: origin + constant radius;
      // cone: apex + t·tan θ, tolerance scaled by the band's widest radius).
      const aHat = unit3(src.axis);
      const lineOrigin = revolutionOriginOf(src);
      let maxR = 0;
      for (const v of verts) {
        const d = sub(v, lineOrigin);
        const radial = sub(d, scaled(aHat, dot(d, aHat)));
        maxR = Math.max(maxR, Math.hypot(radial.x, radial.y, radial.z));
      }
      const rims = detectRevolutionRims(
        verts,
        lineOrigin,
        aHat,
        (t) => revolutionRadiusAt(src, t),
        maxR,
      );
      if (!rims) continue;
      if (rims.some((rim) => rim.verts.some((v) => otherVertexKeys.has(posKey(v))))) continue;
      // Sense from one member facet's own normal/vertex pairing (all
      // members of a wall group agree: every facet normal is radial — a
      // cone's normal is radial·cos θ ∓ axis·sin θ, still radial-positive).
      const member = faces[0]!;
      const d0 = sub(member.vertices[0]!, lineOrigin);
      const radial0 = unit3(sub(d0, scaled(aHat, dot(d0, aHat))));
      const sense = dot(unit3(member.normal), radial0) >= 0;
      bandPlans.push({ src, rims, faces: new Set(faces), sense });
      for (const f of faces) facesInBands.add(f);
    }
  }

  const faceIds: number[] = [];
  for (const face of body.faces) {
    if (facesInBands.has(face)) continue; // emitted as part of its band
    if (face.vertices.length < 3) continue;
    const nLen = Math.hypot(face.normal.x, face.normal.y, face.normal.z);
    if (nLen < 1e-12) continue; // degenerate face — no valid surface normal

    // Drop consecutive duplicates (and a closing repeat of the first vertex):
    // zero-length edges would need a direction of (0,0,0), which is illegal.
    // The 1e-7 threshold matches posKey's 7-decimal identity (see posKey).
    const loopVs: Vec3[] = [];
    for (const v of face.vertices) {
      const last = loopVs[loopVs.length - 1];
      if (last && Math.hypot(v.x - last.x, v.y - last.y, v.z - last.z) <= 1e-7) continue;
      loopVs.push(v);
    }
    while (loopVs.length > 1) {
      const first = loopVs[0]!;
      const last = loopVs[loopVs.length - 1]!;
      if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) <= 1e-7) loopVs.pop();
      else break;
    }
    if (loopVs.length < 3) continue;

    const rev = revolutionSourceOf(face);
    const sph = rev ? null : sphereSourceOf(face);
    const tor = rev || sph ? null : torusSourceOf(face);

    // One ORIENTED_EDGE per loop segment; forward only when the traversal
    // matches the stored edge direction.
    const oeIds: number[] = [];
    for (let i = 0; i < loopVs.length; i++) {
      const v1 = loopVs[i]!;
      const v2 = loopVs[(i + 1) % loopVs.length]!;
      const edge = getEdge(v1, v2);
      const oe = orientedEdge(edge.id, edge.fromId === getVertex(v1));
      emit(oe.text);
      oeIds.push(oe.id);
    }

    const loop = edgeLoop(oeIds);
    emit(loop.text);

    const bound = faceOuterBound(loop.id, true);
    emit(bound.text);

    if (rev) {
      // Tagged cylinder/cone face outside any isolated band: shared rims with
      // faceted neighbours, a partial arc, an angled cut, a pointed cone, or
      // noise. True analytic surface (shared per tag), faceted polyline
      // boundary — a planar-approximated boundary on a genuine cylinder is
      // legal STEP and keeps every edge shared, so OCCT reads one exact solid.
      const aHat = unit3(rev.axis);
      const lineOrigin = revolutionOriginOf(rev);
      const d = sub(loopVs[0]!, lineOrigin);
      const radial = unit3(sub(d, scaled(aHat, dot(d, aHat))));
      const sense = dot(unit3(face.normal), radial) >= 0;
      const surfaceId = rev.kind === 'cylinder' ? getCylSurface(rev) : getConeSurface(rev);
      const af = advancedFace([bound.id], surfaceId, sense);
      emit(af.text);
      faceIds.push(af.id);
      continue;
    }
    if (sph) {
      // Sphere-tagged facet: same_sense from the face normal vs the radial at
      // its first loop vertex (a cavity wall points inward — .F.).
      const radial = unit3(sub(loopVs[0]!, sph.center));
      const sense = dot(unit3(face.normal), radial) >= 0;
      const af = advancedFace([bound.id], getSphereSurface(sph), sense);
      emit(af.text);
      faceIds.push(af.id);
      continue;
    }
    if (tor) {
      // Torus-tagged facet: same_sense from the face normal vs the tube
      // normal (away from the minor-circle center) at its first loop vertex.
      const aHat = unit3(tor.axis);
      const d = sub(loopVs[0]!, tor.center);
      const radial = sub(d, scaled(aHat, dot(d, aHat)));
      const minorCenter = add(tor.center, scaled(unit3(radial), tor.majorRadius));
      const tubeNormal = unit3(sub(loopVs[0]!, minorCenter));
      const sense = dot(unit3(face.normal), tubeNormal) >= 0;
      const af = advancedFace([bound.id], getTorusSurface(tor), sense);
      emit(af.text);
      faceIds.push(af.id);
      continue;
    }

    // Plane through the first loop vertex with the face's outward normal.
    const n = face.normal;
    const p = loopVs[0]!;
    const loc = cartesianPoint(p.x, p.y, p.z);
    emit(loc.text);
    const axisDir = direction(n.x / nLen, n.y / nLen, n.z / nLen);
    emit(axisDir.text);
    const refDir = perpendicularUnit({ x: n.x / nLen, y: n.y / nLen, z: n.z / nLen });
    const refDEnt = direction(refDir.x, refDir.y, refDir.z);
    emit(refDEnt.text);
    const placement = axis2Placement(loc.id, axisDir.id, refDEnt.id);
    emit(placement.text);
    const planeId = id();
    emit(`${ref(planeId)}=PLANE('',${ref(placement.id)});`);

    const af = advancedFace([bound.id], planeId, true);
    emit(af.text);
    faceIds.push(af.id);
  }

  for (const band of bandPlans) {
    faceIds.push(emitBandedRevolution(band.src, band.rims, band.sense));
  }

  // ---- Solid + shape representation chain ---------------------------------
  const shell = closedShell(faceIds);
  emit(shell.text);

  const msbId = id();
  emit(`${ref(msbId)}=MANIFOLD_SOLID_BREP(${str(body.name)},${ref(shell.id)});`);

  const absrId = id();
  emit(`${ref(absrId)}=ADVANCED_BREP_SHAPE_REPRESENTATION('',(${ref(msbId)}),${ref(ctxId)});`);

  const sdrId = id();
  emit(`${ref(sdrId)}=SHAPE_DEFINITION_REPRESENTATION(${ref(pdsId)},${ref(absrId)});`);

  // Build the STEP file.
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('SceneLab B-rep export (faceted + analytic surfaces)'),'2;1');
FILE_NAME('${escaped(`${body.name}.stp`)}','${timestamp}',(''),(''),'SceneLab','SceneLab','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;`;

  const footer = `ENDSEC;
END-ISO-10303-21;`;

  return `${header}\n${entities.join('\n')}\n${footer}\n`;
}
