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
 * CYLINDRICAL_SURFACE, one shared surface entity per cylinder.
 *
 *  - Isolated bands (rim vertices referenced by no other face) collapse to
 *    the canonical OCCT tube: one ADVANCED_FACE whose loop is a closed CIRCLE
 *    EDGE_CURVE per rim plus a LINE seam reused in both directions — a ⌀6
 *    hole wall becomes one face with two circles instead of 55 facets.
 *  - Bands whose rims are shared with faceted neighbours (the usual drilled
 *    solid: the caps reference the rim vertices) keep the shared polyline
 *    chord edges as their boundary on the analytic surface. Emitting CIRCLE
 *    rims there would leave the caps' chord edges singly-used, and OCCT's
 *    reader splits the shell into pieces with meaningless volumes (measured:
 *    a drilled box came back as 3 solids, +11.8% volume). A faceted boundary
 *    on a true cylinder is legal STEP and round-trips exactly.
 *  - Faces whose tag does not fit two full rims (partial arcs, angled cuts)
 *    keep their own polyline loop on the shared analytic surface.
 */
import type { SolidBody, Vec3, Face, FaceSource } from '../geometry/types';

// ---- analytic surface contract (Face.source, geometry/types.ts) ------------

/** The cylinder variant of FaceSource (see geometry/types.ts). */
type CylinderSource = Extract<FaceSource, { kind: 'cylinder' }>;

/** The source tag of a face when (and only when) it is a usable cylinder. */
function cylinderSourceOf(face: Face): CylinderSource | null {
  const src = face.source;
  if (!src || src.kind !== 'cylinder') return null;
  if (!(src.radius > 0)) return null; // NaN/zero/negative — unusable
  if (Math.hypot(src.axis.x, src.axis.y, src.axis.z) < 1e-12) return null;
  return src;
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

// ---- cylinder rim detection -------------------------------------------------

/** One detected rim ring of a full cylindrical band face. */
interface CylinderRim {
  /** Mean height of the ring along the unit cylinder axis (from the origin). */
  t: number;
  /** The ring's vertices (used for the shared-rim guard). */
  verts: Vec3[];
}

/**
 * Fit tolerance for a face's tessellation against its analytic cylinder (mm):
 * tessellation vertices lie ON the surface (only the chords between them
 * deviate, and only inward), so this merely absorbs floating-point noise and
 * kernel re-tessellation — 0.1 % of the radius with a 0.1 µm floor.
 */
const cylFitTol = (radius: number) => Math.max(1e-4, radius * 1e-3);

/**
 * Detect the two boundary rims of a FULL cylindrical band face. Requirements,
 * all against the fit tolerance above:
 *  - every vertex sits on the cylinder surface (radial distance = radius);
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
function detectCylinderRims(verts: Vec3[], cyl: CylinderSource): CylinderRim[] | null {
  const a = unit3(cyl.axis);
  const tol = cylFitTol(cyl.radius);

  const keyed = verts.map((v) => {
    const d = sub(v, cyl.origin);
    const t = dot(d, a);
    const radial = sub(d, scaled(a, t));
    return { v, t, radialDist: Math.hypot(radial.x, radial.y, radial.z) };
  });
  if (!keyed.every((p) => Math.abs(p.radialDist - cyl.radius) <= tol)) return null;

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
  const rims: CylinderRim[] = [];
  for (const g of groups) {
    if (g.length < 3) return null; // a rim needs ≥ 3 points to bound a circle
    if (g[g.length - 1]!.t - g[0]!.t > tol) return null; // ring not ⟂ axis
    const n = g.length;
    const centroid: Vec3 = {
      x: g.reduce((s, p) => s + p.v.x, 0) / n,
      y: g.reduce((s, p) => s + p.v.y, 0) / n,
      z: g.reduce((s, p) => s + p.v.z, 0) / n,
    };
    const cd = sub(centroid, cyl.origin);
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
    rims.push({ t: (g[0]!.t + g[n - 1]!.t) / 2, verts: g.map((p) => p.v) });
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

  /** Cached CYLINDRICAL_SURFACE entity per source key (shared by all facets
   *  of one cylinder — the classifier tags every facet of a wall group). */
  const cylSurfaces = new Map<string, number>();
  const getCylSurface = (cyl: CylinderSource): number => {
    const key = sourceKey(cyl);
    const cached = cylSurfaces.get(key);
    if (cached !== undefined) return cached;
    const aHat = unit3(cyl.axis);
    const refDir = perpendicularUnit(aHat);
    const loc = cartesianPoint(cyl.origin.x, cyl.origin.y, cyl.origin.z);
    emit(loc.text);
    const axisDir = direction(aHat.x, aHat.y, aHat.z);
    emit(axisDir.text);
    const refDEnt = direction(refDir.x, refDir.y, refDir.z);
    emit(refDEnt.text);
    const placement = axis2Placement(loc.id, axisDir.id, refDEnt.id);
    emit(placement.text);
    const surf = cylindricalSurface(placement.id, cyl.radius);
    emit(surf.text);
    cylSurfaces.set(key, surf.id);
    return surf.id;
  };

  /**
   * Emit an isolated full cylindrical band as the canonical OCCT tube:
   *
   *   CYLINDRICAL_SURFACE + EDGE_LOOP(bottom circle +u, seam up,
   *   top circle −u, seam down)
   *
   * The seam is a LINE at parametric u = 0 (the placement ref_direction
   * ray) reused in both directions; each rim is ONE closed CIRCLE
   * EDGE_CURVE whose start and end are the same VERTEX_POINT — the seam
   * point of its ring, because the circle's param-0 point lies on the
   * ref_direction ray. The four oriented edges chain vertex-to-vertex and
   * the cycle is counter-clockwise in the surface's UV rectangle, i.e.
   * right-hand-rule along the outward radial (natural) surface normal.
   * When the face's own normal opposes that (a hole wall points inward),
   * same_sense and the bound orientation flip together.
   */
  const emitBandedCylinder = (cyl: CylinderSource, rims: CylinderRim[], sense: boolean): number => {
    const aHat = unit3(cyl.axis);
    const refDir = perpendicularUnit(aHat);

    const centerAt = (t: number): Vec3 => add(cyl.origin, scaled(aHat, t));
    const seamLow = add(centerAt(rims[0]!.t), scaled(refDir, cyl.radius));
    const seamHigh = add(centerAt(rims[1]!.t), scaled(refDir, cyl.radius));

    const seam = getEdge(seamLow, seamHigh); // LINE along the axis at u = 0
    const lowV = getVertex(seamLow);
    const highV = getVertex(seamHigh);

    const rimCircle = (t: number, seamVertex: number): number => {
      const c = centerAt(t);
      const cpt = cartesianPoint(c.x, c.y, c.z);
      emit(cpt.text);
      const ad = direction(aHat.x, aHat.y, aHat.z);
      emit(ad.text);
      const rd = direction(refDir.x, refDir.y, refDir.z);
      emit(rd.text);
      const placement = axis2Placement(cpt.id, ad.id, rd.id);
      emit(placement.text);
      const circ = circleCurve(placement.id, cyl.radius);
      emit(circ.text);
      const ec = edgeCurve(seamVertex, seamVertex, circ.id); // closed edge
      emit(ec.text);
      return ec.id;
    };
    const lowCircle = rimCircle(rims[0]!.t, lowV);
    const highCircle = rimCircle(rims[1]!.t, highV);

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

    const af = advancedFace([bound.id], getCylSurface(cyl), sense);
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
    cyl: CylinderSource;
    rims: CylinderRim[];
    faces: Set<Face>;
    sense: boolean;
  }
  const bandPlans: BandPlan[] = [];
  const facesInBands = new Set<Face>();
  {
    const groups = new Map<string, { cyl: CylinderSource; faces: Face[] }>();
    for (const face of body.faces) {
      const cyl = cylinderSourceOf(face);
      if (!cyl) continue;
      const key = sourceKey(cyl);
      const group = groups.get(key) ?? { cyl, faces: [] };
      group.faces.push(face);
      groups.set(key, group);
    }
    const otherVertexKeys = new Set<string>();
    for (const face of body.faces) {
      if (cylinderSourceOf(face)) continue;
      for (const v of face.vertices) otherVertexKeys.add(posKey(v));
    }
    for (const { cyl, faces } of groups.values()) {
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
      const rims = detectCylinderRims(verts, cyl);
      if (!rims) continue;
      if (rims.some((rim) => rim.verts.some((v) => otherVertexKeys.has(posKey(v))))) continue;
      // Sense from one member facet's own normal/vertex pairing (all
      // members of a wall group agree: every facet normal is radial).
      const member = faces[0]!;
      const aHat = unit3(cyl.axis);
      const d0 = sub(member.vertices[0]!, cyl.origin);
      const radial0 = unit3(sub(d0, scaled(aHat, dot(d0, aHat))));
      const sense = dot(unit3(member.normal), radial0) >= 0;
      bandPlans.push({ cyl, rims, faces: new Set(faces), sense });
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

    const cyl = cylinderSourceOf(face);

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

    if (cyl) {
      // Tagged cylinder face outside any isolated band: shared rims with
      // faceted neighbours, a partial arc, an angled cut, or noise. True
      // analytic surface (shared per cylinder), faceted polyline boundary —
      // a planar-approximated boundary on a genuine cylinder is legal STEP
      // and keeps every edge shared, so OCCT reads one exact solid.
      const aHat = unit3(cyl.axis);
      const d = sub(loopVs[0]!, cyl.origin);
      const radial = unit3(sub(d, scaled(aHat, dot(d, aHat))));
      const sense = dot(unit3(face.normal), radial) >= 0;
      const af = advancedFace([bound.id], getCylSurface(cyl), sense);
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
    faceIds.push(emitBandedCylinder(band.cyl, band.rims, band.sense));
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
FILE_DESCRIPTION(('SceneLab B-rep export (faceted + analytic cylinders)'),'2;1');
FILE_NAME('${escaped(`${body.name}.stp`)}','${timestamp}',(''),(''),'SceneLab','SceneLab','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;`;

  const footer = `ENDSEC;
END-ISO-10303-21;`;

  return `${header}\n${entities.join('\n')}\n${footer}\n`;
}
