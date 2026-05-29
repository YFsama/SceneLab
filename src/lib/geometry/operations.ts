import type { Vec3, SolidBody, Face, Edge } from './types';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/** Fillet: round edges by replacing them with arc-like faces */
export function applyFillet(body: SolidBody, edgeIds: string[], radius: number): SolidBody {
  if (radius <= 0) return body;
  const edgeSet = new Set(edgeIds);

  const newFaces: Face[] = [];
  const newEdges: Edge[] = [];
  const filletFaces: Face[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    // Find faces sharing this edge
    const adjacentFaces = body.faces.filter((f) =>
      faceContainsEdge(f, edge),
    );

    if (adjacentFaces.length < 2) continue;

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) continue;

    // Compute fillet direction (bisector of face normals)
    const bisector = normalize({
      x: face1.normal.x + face2.normal.x,
      y: face1.normal.y + face2.normal.y,
      z: face1.normal.z + face2.normal.z,
    });

    // Offset the edge inward by radius
    const offsetStart: Vec3 = {
      x: edge.start.x - bisector.x * radius,
      y: edge.start.y - bisector.y * radius,
      z: edge.start.z - bisector.z * radius,
    };
    const offsetEnd: Vec3 = {
      x: edge.end.x - bisector.x * radius,
      y: edge.end.y - bisector.y * radius,
      z: edge.end.z - bisector.z * radius,
    };

    // Create fillet face (quad connecting original edge to offset edge)
    filletFaces.push({
      id: genId('face'),
      vertices: [edge.start, edge.end, offsetEnd, offsetStart],
      normal: bisector,
    });

    newEdges.push(
      { id: genId('edge'), start: offsetStart, end: offsetEnd },
      { id: genId('edge'), start: edge.start, end: offsetStart },
      { id: genId('edge'), start: edge.end, end: offsetEnd },
    );
  }

  // A fillet rounds an edge: the adjacent faces are retained (a real kernel
  // would trim them back), and a blend face is inserted along each edge. Keep
  // every original face and add the fillet faces on top.
  for (const face of body.faces) {
    newFaces.push(face);
  }

  newFaces.push(...filletFaces);

  const newVertices = dedupVertices(newFaces);

  return {
    id: body.id,
    name: body.name,
    vertices: newVertices,
    faces: newFaces,
    edges: newEdges,
  };
}

/** Chamfer: bevel edges by cutting them at an angle */
export function applyChamfer(body: SolidBody, edgeIds: string[], distance: number): SolidBody {
  if (distance <= 0) return body;
  const edgeSet = new Set(edgeIds);

  const newFaces: Face[] = [];
  const newEdges: Edge[] = [];
  const chamferFaces: Face[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) continue;

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) continue;

    const dir = normalize({
      x: face1.normal.x + face2.normal.x,
      y: face1.normal.y + face2.normal.y,
      z: face1.normal.z + face2.normal.z,
    });

    const offsetStart: Vec3 = {
      x: edge.start.x - dir.x * distance,
      y: edge.start.y - dir.y * distance,
      z: edge.start.z - dir.z * distance,
    };
    const offsetEnd: Vec3 = {
      x: edge.end.x - dir.x * distance,
      y: edge.end.y - dir.y * distance,
      z: edge.end.z - dir.z * distance,
    };

    chamferFaces.push({
      id: genId('face'),
      vertices: [edge.start, edge.end, offsetEnd, offsetStart],
      normal: dir,
    });

    newEdges.push(
      { id: genId('edge'), start: offsetStart, end: offsetEnd },
      { id: genId('edge'), start: edge.start, end: offsetStart },
      { id: genId('edge'), start: edge.end, end: offsetEnd },
    );
  }

  for (const face of body.faces) {
    const hasChamferedEdge = face.vertices.some((_, i) => {
      const next = (i + 1) % face.vertices.length;
      const v1 = face.vertices[i]!;
      const v2 = face.vertices[next]!;
      return body.edges.some(
        (e) => edgeSet.has(e.id) && edgeMatchesPoints(e, v1, v2),
      );
    });
    if (!hasChamferedEdge) {
      newFaces.push(face);
    }
  }

  newFaces.push(...chamferFaces);

  const newVertices = dedupVertices(newFaces);

  return {
    id: body.id,
    name: body.name,
    vertices: newVertices,
    faces: newFaces,
    edges: newEdges,
  };
}

/** Shell: hollow out a body by removing faces and offsetting inward */
export function applyShell(body: SolidBody, faceIds: string[], thickness: number): SolidBody {
  if (thickness <= 0) return body;
  const faceSet = new Set(faceIds);

  const newFaces: Face[] = [];
  const shellFaces: Face[] = [];

  for (const face of body.faces) {
    if (faceSet.has(face.id)) {
      // Create offset (inner) face
      const innerVerts = face.vertices.map((v) => ({
        x: v.x - face.normal.x * thickness,
        y: v.y - face.normal.y * thickness,
        z: v.z - face.normal.z * thickness,
      }));

      shellFaces.push({
        id: genId('face'),
        vertices: innerVerts,
        normal: { x: -face.normal.x, y: -face.normal.y, z: -face.normal.z },
      });
    } else {
      newFaces.push(face);
    }
  }

  // Create side faces connecting outer edges to inner edges
  for (const removedFace of body.faces.filter((f) => faceSet.has(f.id))) {
    for (let i = 0; i < removedFace.vertices.length; i++) {
      const next = (i + 1) % removedFace.vertices.length;
      const outer1 = removedFace.vertices[i]!;
      const outer2 = removedFace.vertices[next]!;
      const inner1: Vec3 = {
        x: outer1.x - removedFace.normal.x * thickness,
        y: outer1.y - removedFace.normal.y * thickness,
        z: outer1.z - removedFace.normal.z * thickness,
      };
      const inner2: Vec3 = {
        x: outer2.x - removedFace.normal.x * thickness,
        y: outer2.y - removedFace.normal.y * thickness,
        z: outer2.z - removedFace.normal.z * thickness,
      };

      const sideNormal = computeFaceNormal(outer1, outer2, inner2);
      shellFaces.push({
        id: genId('face'),
        vertices: [outer1, outer2, inner2, inner1],
        normal: sideNormal,
      });
    }
  }

  newFaces.push(...shellFaces);

  const newVertices = dedupVertices(newFaces);

  return {
    id: body.id,
    name: body.name,
    vertices: newVertices,
    faces: newFaces,
    edges: body.edges,
  };
}

/** Linear array: duplicate body along a direction */
export function applyLinearArray(
  body: SolidBody,
  direction: Vec3,
  count: number,
  spacing: number,
): SolidBody[] {
  if (count <= 0) throw new Error('Array count must be positive');
  if (spacing <= 0) throw new Error('Array spacing must be positive');
  const results: SolidBody[] = [];
  for (let i = 0; i < count; i++) {
    const offset = {
      x: direction.x * spacing * i,
      y: direction.y * spacing * i,
      z: direction.z * spacing * i,
    };
    results.push(translateBody(body, offset, `${body.name} [${i}]`));
  }
  return results;
}

/** Circular array: duplicate body around an axis */
export function applyCircularArray(
  body: SolidBody,
  axis: { origin: Vec3; direction: Vec3 },
  count: number,
): SolidBody[] {
  if (count <= 0) throw new Error('Array count must be positive');
  const results: SolidBody[] = [];
  const angleStep = (Math.PI * 2) / count;

  for (let i = 0; i < count; i++) {
    const angle = angleStep * i;
    results.push(rotateBody(body, axis, angle, `${body.name} [${i}]`));
  }
  return results;
}

/** Uniform scale of a body about an origin point (default world origin). */
export function scaleBody(body: SolidBody, factor: number, origin: Vec3 = { x: 0, y: 0, z: 0 }): SolidBody {
  if (factor <= 0) throw new Error('Scale factor must be positive');
  const s = (v: Vec3): Vec3 => ({
    x: origin.x + (v.x - origin.x) * factor,
    y: origin.y + (v.y - origin.y) * factor,
    z: origin.z + (v.z - origin.z) * factor,
  });
  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(s),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(s),
      // Uniform scaling preserves normal directions.
      normal: { ...f.normal },
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: s(e.start),
      end: s(e.end),
    })),
  };
}

/** Mirror: reflect body across a plane */
export function applyMirror(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3 },
): SolidBody {
  const n = normalize(plane.normal);
  const d = -(n.x * plane.origin.x + n.y * plane.origin.y + n.z * plane.origin.z);

  const mirrorVert = (v: Vec3): Vec3 => {
    const dist = 2 * (n.x * v.x + n.y * v.y + n.z * v.z + d);
    return {
      x: v.x - n.x * dist,
      y: v.y - n.y * dist,
      z: v.z - n.z * dist,
    };
  };

  const newVertices = body.vertices.map(mirrorVert);
  const newFaces = body.faces.map((f) => ({
    id: genId('face'),
    vertices: f.vertices.map(mirrorVert),
    normal: { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z },
  }));
  const newEdges = body.edges.map((e) => ({
    id: genId('edge'),
    start: mirrorVert(e.start),
    end: mirrorVert(e.end),
  }));

  return {
    id: genId('body'),
    name: `${body.name} (mirror)`,
    vertices: newVertices,
    faces: newFaces,
    edges: newEdges,
  };
}

// --- Helpers ---

function translateBody(body: SolidBody, offset: Vec3, name: string): SolidBody {
  const translate = (v: Vec3): Vec3 => ({
    x: v.x + offset.x,
    y: v.y + offset.y,
    z: v.z + offset.z,
  });

  return {
    id: genId('body'),
    name,
    vertices: body.vertices.map(translate),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(translate),
      normal: { ...f.normal },
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: translate(e.start),
      end: translate(e.end),
    })),
  };
}

function rotateBody(
  body: SolidBody,
  axis: { origin: Vec3; direction: Vec3 },
  angle: number,
  name: string,
): SolidBody {
  const dir = normalize(axis.direction);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const rotate = (v: Vec3): Vec3 => {
    const p = { x: v.x - axis.origin.x, y: v.y - axis.origin.y, z: v.z - axis.origin.z };
    const dot = dir.x * p.x + dir.y * p.y + dir.z * p.z;
    const cross = {
      x: dir.y * p.z - dir.z * p.y,
      y: dir.z * p.x - dir.x * p.z,
      z: dir.x * p.y - dir.y * p.x,
    };
    return {
      x: axis.origin.x + p.x * cos + cross.x * sin + dir.x * dot * (1 - cos),
      y: axis.origin.y + p.y * cos + cross.y * sin + dir.y * dot * (1 - cos),
      z: axis.origin.z + p.z * cos + cross.z * sin + dir.z * dot * (1 - cos),
    };
  };

  return {
    id: genId('body'),
    name,
    vertices: body.vertices.map(rotate),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(rotate),
      normal: rotate(f.normal),
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: rotate(e.start),
      end: rotate(e.end),
    })),
  };
}

/** Deduplicate vertices using spatial hashing (O(n) instead of O(n^2)) */
function dedupVertices(faces: Face[]): Vec3[] {
  const map = new Map<string, Vec3>();
  const precision = 6;
  for (const f of faces) {
    for (const v of f.vertices) {
      const key = `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
      if (!map.has(key)) map.set(key, v);
    }
  }
  return Array.from(map.values());
}

function faceContainsEdge(face: Face, edge: Edge): boolean {
  for (let i = 0; i < face.vertices.length; i++) {
    const next = (i + 1) % face.vertices.length;
    const v1 = face.vertices[i]!;
    const v2 = face.vertices[next]!;
    if (edgeMatchesPoints(edge, v1, v2)) return true;
  }
  return false;
}

function edgeMatchesPoints(edge: Edge, a: Vec3, b: Vec3): boolean {
  return (
    (vecEqual(edge.start, a) && vecEqual(edge.end, b)) ||
    (vecEqual(edge.start, b) && vecEqual(edge.end, a))
  );
}

function vecEqual(a: Vec3, b: Vec3): boolean {
  const eps = 1e-6;
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-10) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function computeFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return normalize({
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  });
}
