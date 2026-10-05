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
 */
import type { SolidBody, Vec3 } from '../geometry/types';

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

/** Position key used to deduplicate vertices. */
const posKey = (v: Vec3) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;

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

  const faceIds: number[] = [];
  for (const face of body.faces) {
    if (face.vertices.length < 3) continue;

    // Drop consecutive duplicates (and a closing repeat of the first vertex):
    // zero-length edges would need a direction of (0,0,0), which is illegal.
    const loopVs: Vec3[] = [];
    for (const v of face.vertices) {
      const last = loopVs[loopVs.length - 1];
      if (last && Math.hypot(v.x - last.x, v.y - last.y, v.z - last.z) <= 1e-9) continue;
      loopVs.push(v);
    }
    while (loopVs.length > 1) {
      const first = loopVs[0]!;
      const last = loopVs[loopVs.length - 1]!;
      if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) <= 1e-9) loopVs.pop();
      else break;
    }
    if (loopVs.length < 3) continue;

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

    // Plane through the first loop vertex with the face's outward normal.
    const n = face.normal;
    const nLen = Math.hypot(n.x, n.y, n.z);
    if (nLen < 1e-12) continue; // degenerate face — no valid surface normal
    const p = loopVs[0]!;
    const loc = cartesianPoint(p.x, p.y, p.z);
    emit(loc.text);
    const axisDir = direction(n.x / nLen, n.y / nLen, n.z / nLen);
    emit(axisDir.text);
    const refDir = perpendicularUnit({ x: n.x / nLen, y: n.y / nLen, z: n.z / nLen });
    const refDEnt = direction(refDir.x, refDir.y, refDir.z);
    emit(refDEnt.text);
    const axisId = id();
    emit(`${ref(axisId)}=AXIS2_PLACEMENT_3D('',${ref(loc.id)},${ref(axisDir.id)},${ref(refDEnt.id)});`);
    const planeId = id();
    emit(`${ref(planeId)}=PLANE('',${ref(axisId)});`);

    const af = advancedFace([bound.id], planeId, true);
    emit(af.text);
    faceIds.push(af.id);
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
FILE_DESCRIPTION(('SceneLab faceted B-rep export'),'2;1');
FILE_NAME('${escaped(`${body.name}.stp`)}','${timestamp}',(''),(''),'SceneLab','SceneLab','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;`;

  const footer = `ENDSEC;
END-ISO-10303-21;`;

  return `${header}\n${entities.join('\n')}\n${footer}\n`;
}
