/**
 * STEP AP203 export: writes a mesh body as a faceted B-rep STEP file.
 * Produces a valid ISO 10303-21 file readable by FreeCAD, SolidWorks, etc.
 * Uses the FACETED_BREP / SHELL_BASED_SURFACE_MODEL approach for simplicity.
 */
import type { SolidBody, Vec3 } from '../geometry/types';

let nextId = 1;
const id = () => nextId++;

/** Format a STEP entity ID. */
const ref = (n: number) => `#${n}`;

/** Format a STEP string literal. */
const str = (s: string) => `'${s}'`;

/** Format a STEP list. */
const list = (items: string[]) => `(${items.join(',')})`;

/** Format a CARTESIAN_POINT. */
function cartesianPoint(x: number, y: number, z: number): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CARTESIAN_POINT('',(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}));` };
}

/** Format a DIRECTION. */
function direction(x: number, y: number, z: number): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=DIRECTION('',(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}));` };
}

/** Format a VECTOR. */
function vector(dirId: number, magnitude: number): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=VECTOR('',${ref(dirId)},${magnitude.toFixed(6)});` };
}

/** Format a VERTEX_POINT. */
function vertexPoint(ptId: number): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=VERTEX_POINT('',${ref(ptId)});` };
}

/** Format an EDGE_CURVE. */
function edgeCurve(v1Id: number, v2Id: number, curveId: number): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=EDGE_CURVE('','',${ref(v1Id)},${ref(v2Id)},${ref(curveId)},.T.);` };
}

/** Format an ORIENTED_EDGE. */
function orientedEdge(edgeId: number, _startId: number, _endId: number, orientation: boolean): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=ORIENTED_EDGE('',*,*,${ref(edgeId)},${orientation ? '.T.' : '.F.'});` };
}

/** Format an EDGE_LOOP. */
function edgeLoop(oeIds: number[]): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=EDGE_LOOP('',${list(oeIds.map(ref))});` };
}

/** Format a FACE_BOUND. */
function faceBound(loopId: number, orientation: boolean): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=FACE_BOUND('',${ref(loopId)},${orientation ? '.T.' : '.F.'});` };
}

/** Format an ADVANCED_FACE. */
function advancedFace(boundIds: number[], surfaceId: number, sameSense: boolean): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=ADVANCED_FACE('',${list(boundIds.map(ref))},${ref(surfaceId)},${sameSense ? '.T.' : '.F.'});` };
}

/** Format a CLOSED_SHELL. */
function closedShell(faceIds: number[]): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=CLOSED_SHELL('',${list(faceIds.map(ref))});` };
}

/** Format a MANIFOLD_SURFACE_SHAPE_REPRESENTATION. */
function manifoldSurfaceShapeRepresentation(itemIds: number[]): { id: number; text: string } {
  const eid = id();
  return { id: eid, text: `${ref(eid)}=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',${list(itemIds.map(ref))},${ref(1)});` };
}

/**
 * Export a SolidBody as a STEP AP203 file string.
 * Each face is written as a planar ADVANCED_FACE with an EDGE_LOOP boundary.
 */
export function exportSTEP(body: SolidBody): string {
  nextId = 1;
  const entities: string[] = [];
  const emit = (text: string) => entities.push(text);

  // Header preamble IDs are fixed.
  id(); // #1 = context

  // Application context
  const appCtxId = id();
  emit(`${ref(appCtxId)}=APPLICATION_CONTEXT('core data for automotive mechanical design processes');`);

  // Product context
  const prodCtxId = id();
  emit(`${ref(prodCtxId)}=PRODUCT_CONTEXT('part definition',${ref(appCtxId)},'design');`);

  // Product
  const prodId = id();
  emit(`${ref(prodId)}=PRODUCT(${str(body.name)},${str(body.name)},'',(${ref(prodCtxId)}));`);

  // Product definition context
  const pdcId = id();
  emit(`${ref(pdcId)}=PRODUCT_DEFINITION_CONTEXT('part definition',${ref(appCtxId)},'design');`);

  // Product definition
  const pdId = id();
  emit(`${ref(pdId)}=PRODUCT_DEFINITION('','',${ref(prodId)},${ref(pdcId)});`);

  // Shape definition
  const sdId = id();
  emit(`${ref(sdId)}=PRODUCT_DEFINITION_SHAPE('','',${ref(pdId)});`);

  // Build geometry: unique vertices, edges, faces.
  // Deduplicate vertices by position.
  const vertMap = new Map<string, number>(); // "x,y,z" → vertex entity id
  const ptMap = new Map<string, number>(); // "x,y,z" → cartesian_point entity id

  const getVertex = (v: Vec3): number => {
    const key = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
    if (vertMap.has(key)) return vertMap.get(key)!;
    const pt = cartesianPoint(v.x, v.y, v.z);
    emit(pt.text);
    const vtx = vertexPoint(pt.id);
    emit(vtx.text);
    vertMap.set(key, vtx.id);
    ptMap.set(key, pt.id);
    return vtx.id;
  };

  // Build edges: deduplicate by sorted vertex pair.
  const edgeMap = new Map<string, number>(); // "v1id,v2id" → edge_curve id

  const getEdge = (v1: Vec3, v2: Vec3): number => {
    const v1id = getVertex(v1);
    const v2id = getVertex(v2);
    const key = v1id < v2id ? `${v1id},${v2id}` : `${v2id},${v1id}`;
    if (edgeMap.has(key)) return edgeMap.get(key)!;
    // Create a LINE for the edge (uses p1 as the line origin).
    const p1 = ptMap.get(`${v1.x.toFixed(6)},${v1.y.toFixed(6)},${v1.z.toFixed(6)}`)!;
    const dir = direction(v2.x - v1.x, v2.y - v1.y, v2.z - v1.z);
    emit(dir.text);
    const mag = Math.hypot(v2.x - v1.x, v2.y - v1.y, v2.z - v1.z);
    const vec = vector(dir.id, mag);
    emit(vec.text);
    const lineId = id();
    emit(`${ref(lineId)}=LINE('',${ref(p1)},${ref(vec.id)});`);
    const ec = edgeCurve(v1id, v2id, lineId);
    emit(ec.text);
    edgeMap.set(key, ec.id);
    return ec.id;
  };

  // Build faces.
  const faceIds: number[] = [];
  for (const face of body.faces) {
    if (face.vertices.length < 3) continue;

    // Build edge loop for this face.
    const oeIds: number[] = [];
    for (let i = 0; i < face.vertices.length; i++) {
      const v1 = face.vertices[i]!;
      const v2 = face.vertices[(i + 1) % face.vertices.length]!;
      const edgeId = getEdge(v1, v2);
      const v1id = getVertex(v1);
      const v2id = getVertex(v2);
      const oe = orientedEdge(edgeId, v1id, v2id, true);
      emit(oe.text);
      oeIds.push(oe.id);
    }

    const loop = edgeLoop(oeIds);
    emit(loop.text);

    const bound = faceBound(loop.id, true);
    emit(bound.text);

    // Create a plane for this face.
    const n = face.normal;
    const p = face.vertices[0]!;
    const planeId = id();
    const axisId = id();
    const locId = cartesianPoint(p.x, p.y, p.z);
    emit(locId.text);
    const dirId = direction(n.x, n.y, n.z);
    emit(dirId.text);
    emit(`${ref(axisId)}=AXIS2_PLACEMENT_3D('',${ref(locId.id)},${ref(dirId.id)},$);`);
    emit(`${ref(planeId)}=PLANE('',${ref(axisId)});`);

    const af = advancedFace([bound.id], planeId, true);
    emit(af.text);
    faceIds.push(af.id);
  }

  // Shell and representation.
  const shell = closedShell(faceIds);
  emit(shell.text);

  const msr = manifoldSurfaceShapeRepresentation([shell.id]);
  emit(msr.text);

  // Shape representation relationship.
  const srrId = id();
  emit(`${ref(srrId)}=SHAPE_REPRESENTATION_RELATIONSHIP('','',${ref(msr.id)},$);`);

  // Build the STEP file.
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('STEP AP203'),'2;1');
FILE_NAME('${body.name}.stp','${timestamp}',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;`;

  const footer = `ENDSEC;
END-ISO-10303-21;`;

  return `${header}\n${entities.join('\n')}\n${footer}\n`;
}
