import type { Vec3, SolidBody, Face, Edge } from './types';
import { computeConvexHull } from './convexHull';
import { localToWorld, type CoordinateSystemDefinition } from './referenceGeometry';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/** Fillet: round edges by replacing them with arc-like faces */
export function applyFillet(body: SolidBody, edgeIds: string[], radius: number): SolidBody {
  if (radius <= 0) return body;
  const edgeSet = new Set(edgeIds);
  const ARC_SEGMENTS = 8; // number of quads approximating the fillet arc

  const newFaces: Face[] = [...body.faces]; // keep original faces
  const newEdges: Edge[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    // Find faces sharing this edge.
    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) { newEdges.push(edge); continue; }

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) { newEdges.push(edge); continue; }

    // The fillet arc swings from face1's surface to face2's surface, centered
    // on the edge. The arc lies in the plane defined by the edge direction and
    // the bisector of the two face normals.
    const edgeDir = normalize({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    const n1 = normalize(face1.normal);
    const n2 = normalize(face2.normal);

    // Build an orthonormal frame: edgeDir (along edge), n1 (face1 normal), and
    // a tangent perpendicular to both.
    const tangent = cross(n1, edgeDir);
    const tangentLen = vecLen(tangent);
    if (tangentLen < 1e-9) { newEdges.push(edge); continue; }
    const t = { x: tangent.x / tangentLen, y: tangent.y / tangentLen, z: tangent.z / tangentLen };

    // The fillet center is offset from the edge along the bisector by the
    // radius divided by sin(half-angle).
    const dotNN = Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y + n1.z * n2.z));
    const halfAngle = Math.acos(dotNN) / 2;
    const sinHalf = Math.sin(halfAngle);
    const centerOffset = sinHalf > 1e-6 ? radius / sinHalf : radius;
    const bisector = normalize({ x: n1.x + n2.x, y: n1.y + n2.y, z: n1.z + n2.z });

    // Generate arc segments along the edge.
    for (let seg = 0; seg < ARC_SEGMENTS; seg++) {
      const a0 = (seg / ARC_SEGMENTS) * Math.PI;
      const a1 = ((seg + 1) / ARC_SEGMENTS) * Math.PI;

      // Arc points at the start and end of this segment, at both edge endpoints.
      const arcPoint = (angle: number, edgeT: number): Vec3 => {
        const along = { x: edge.start.x + edgeDir.x * edgeT, y: edge.start.y + edgeDir.y * edgeT, z: edge.start.z + edgeDir.z * edgeT };
        const r0 = centerOffset * Math.cos(angle);
        const r1 = radius * Math.sin(angle);
        return {
          x: along.x + bisector.x * r0 + t.x * r1,
          y: along.y + bisector.y * r0 + t.y * r1,
          z: along.z + bisector.z * r0 + t.z * r1,
        };
      };

      const v00 = arcPoint(a0, 0);
      const v10 = arcPoint(a1, 0);
      const v01 = arcPoint(a0, 1);
      const v11 = arcPoint(a1, 1);

      // Quad face (two triangles).
      const faceNormal = normalize(cross(
        { x: v10.x - v00.x, y: v10.y - v00.y, z: v10.z - v00.z },
        { x: v01.x - v00.x, y: v01.y - v00.y, z: v01.z - v00.z },
      ));
      newFaces.push({
        id: genId('face'),
        vertices: [v00, v10, v11, v01],
        normal: faceNormal,
      });

      newEdges.push(
        { id: genId('edge'), start: v00, end: v10 },
        { id: genId('edge'), start: v01, end: v11 },
      );
    }

    // Edges connecting the arc endpoints to the original edge.
    const arcStart0 = {
      x: edge.start.x + bisector.x * centerOffset,
      y: edge.start.y + bisector.y * centerOffset,
      z: edge.start.z + bisector.z * centerOffset,
    };
    const arcEnd0 = {
      x: edge.end.x + bisector.x * centerOffset,
      y: edge.end.y + bisector.y * centerOffset,
      z: edge.end.z + bisector.z * centerOffset,
    };
    newEdges.push(
      { id: genId('edge'), start: edge.start, end: arcStart0 },
      { id: genId('edge'), start: edge.end, end: arcEnd0 },
    );
  }

  const newVertices = dedupVertices(newFaces);
  return { id: body.id, name: body.name, vertices: newVertices, faces: newFaces, edges: newEdges };
}

/** Chamfer: bevel edges by cutting them at an angle */
export function applyChamfer(body: SolidBody, edgeIds: string[], distance: number): SolidBody {
  if (distance <= 0) return body;
  const edgeSet = new Set(edgeIds);

  const newFaces: Face[] = [...body.faces]; // keep original faces
  const newEdges: Edge[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    // Find the two adjacent faces.
    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) { newEdges.push(edge); continue; }

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) { newEdges.push(edge); continue; }

    const n1 = normalize(face1.normal);
    const n2 = normalize(face2.normal);

    // Chamfer: offset each edge endpoint inward along both face normals by
    // `distance`. This creates 4 new points per edge (2 per face), forming a
    // diamond-shaped chamfer face.
    const sOff1: Vec3 = { x: edge.start.x - n1.x * distance, y: edge.start.y - n1.y * distance, z: edge.start.z - n1.z * distance };
    const sOff2: Vec3 = { x: edge.start.x - n2.x * distance, y: edge.start.y - n2.y * distance, z: edge.start.z - n2.z * distance };
    const eOff1: Vec3 = { x: edge.end.x - n1.x * distance, y: edge.end.y - n1.y * distance, z: edge.end.z - n1.z * distance };
    const eOff2: Vec3 = { x: edge.end.x - n2.x * distance, y: edge.end.y - n2.y * distance, z: edge.end.z - n2.z * distance };

    // Chamfer face: a quad connecting the two offset lines.
    const chamferNormal = normalize(cross(
      { x: sOff2.x - sOff1.x, y: sOff2.y - sOff1.y, z: sOff2.z - sOff1.z },
      { x: eOff1.x - sOff1.x, y: eOff1.y - sOff1.y, z: eOff1.z - sOff1.z },
    ));
    newFaces.push({
      id: genId('face'),
      vertices: [sOff1, eOff1, eOff2, sOff2],
      normal: chamferNormal,
    });

    // New edges for the chamfer outline.
    newEdges.push(
      { id: genId('edge'), start: sOff1, end: eOff1 },
      { id: genId('edge'), start: sOff2, end: eOff2 },
      { id: genId('edge'), start: sOff1, end: sOff2 },
      { id: genId('edge'), start: eOff1, end: eOff2 },
    );
  }

  const newVertices = dedupVertices(newFaces);
  return { id: body.id, name: body.name, vertices: newVertices, faces: newFaces, edges: newEdges };
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
  // Normalize the direction so `spacing` is honored as a true mm gap regardless
  // of the direction vector's magnitude.
  const dirLen = Math.hypot(direction.x, direction.y, direction.z);
  if (dirLen < 1e-12) throw new Error('Array direction cannot be zero');
  const dir = { x: direction.x / dirLen, y: direction.y / dirLen, z: direction.z / dirLen };
  const results: SolidBody[] = [];
  for (let i = 0; i < count; i++) {
    const offset = {
      x: dir.x * spacing * i,
      y: dir.y * spacing * i,
      z: dir.z * spacing * i,
    };
    results.push(translateBody(body, offset, `${body.name} [${i}]`));
  }
  return results;
}

/**
 * Grid (2-direction linear) pattern, like SolidWorks' linear pattern with a
 * second direction. Produces count1 × count2 copies offset along the two
 * (normalized) directions; spacings are true mm gaps. The (0,0) copy is the
 * original position.
 */
export function applyGridArray(
  body: SolidBody,
  dir1: Vec3,
  count1: number,
  spacing1: number,
  dir2: Vec3,
  count2: number,
  spacing2: number,
): SolidBody[] {
  if (count1 <= 0 || count2 <= 0) throw new Error('Array counts must be positive');
  if (spacing1 <= 0 || spacing2 <= 0) throw new Error('Array spacings must be positive');
  const n = (d: Vec3): Vec3 => {
    const l = Math.hypot(d.x, d.y, d.z);
    if (l < 1e-12) throw new Error('Array direction cannot be zero');
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const u = n(dir1);
  const v = n(dir2);
  const results: SolidBody[] = [];
  for (let i = 0; i < count1; i++) {
    for (let j = 0; j < count2; j++) {
      const offset = {
        x: u.x * spacing1 * i + v.x * spacing2 * j,
        y: u.y * spacing1 * i + v.y * spacing2 * j,
        z: u.z * spacing1 * i + v.z * spacing2 * j,
      };
      results.push(translateBody(body, offset, `${body.name} [${i},${j}]`));
    }
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

/**
 * Combine several bodies into one mesh by concatenation (fresh face/edge ids).
 * For disjoint bodies this is a valid union; overlapping bodies are simply
 * merged as-is (no boolean). Useful to export an array/pattern as a single mesh.
 */
export function mergeBodies(bodies: SolidBody[], name = 'Merged'): SolidBody {
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  for (const b of bodies) {
    vertices.push(...b.vertices);
    for (const f of b.faces) {
      faces.push({ id: genId('face'), vertices: f.vertices, normal: f.normal });
    }
    for (const e of b.edges) {
      edges.push({ id: genId('edge'), start: e.start, end: e.end });
    }
  }
  return { id: genId('body'), name, vertices, faces, edges };
}

/**
 * Uniformly scale a body so its extent along `axis` equals `target` mm,
 * scaled about its bounding-box center (preserves aspect ratio).
 */
export function scaleBodyToTarget(body: SolidBody, axis: 'x' | 'y' | 'z', target: number): SolidBody {
  if (!Number.isFinite(target) || target <= 0) throw new Error('Target size must be positive');
  let min = Infinity;
  let max = -Infinity;
  for (const v of body.vertices) {
    min = Math.min(min, v[axis]);
    max = Math.max(max, v[axis]);
  }
  const extent = max - min;
  if (!(extent > 1e-9)) throw new Error('Body has zero extent along the axis');
  const bb = computeBoundingBoxLocal(body);
  return scaleBody(body, target / extent, {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  });
}

function computeBoundingBoxLocal(body: SolidBody): { min: Vec3; max: Vec3 } {
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/**
 * Resize a body to exact per-axis dimensions (mm), scaling each axis
 * independently about the bounding-box center. Unlike uniform scaleBody this
 * changes the aspect ratio, so normals are transformed by the inverse-transpose
 * of the (diagonal) scale — n → (nx/sx, ny/sy, nz/sz) normalized — to stay
 * perpendicular to the deformed faces.
 */
export function resizeBody(body: SolidBody, target: Vec3): SolidBody {
  if (![target.x, target.y, target.z].every((d) => Number.isFinite(d) && d > 0)) {
    throw new Error('Target dimensions must be positive');
  }
  const bb = computeBoundingBoxLocal(body);
  const ext = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  // A zero-extent axis (flat part) can't be resized along that axis; keep it.
  const sx = ext.x > 1e-9 ? target.x / ext.x : 1;
  const sy = ext.y > 1e-9 ? target.y / ext.y : 1;
  const sz = ext.z > 1e-9 ? target.z / ext.z : 1;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;

  const p = (v: Vec3): Vec3 => ({
    x: cx + (v.x - cx) * sx,
    y: cy + (v.y - cy) * sy,
    z: cz + (v.z - cz) * sz,
  });
  const transformNormal = (n: Vec3): Vec3 => normalize({ x: n.x / sx, y: n.y / sy, z: n.z / sz });

  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(p),
    faces: body.faces.map((f) => ({ id: genId('face'), vertices: f.vertices.map(p), normal: transformNormal(f.normal) })),
    edges: body.edges.map((e) => ({ id: genId('edge'), start: p(e.start), end: p(e.end) })),
  };
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

/** Non-uniform scale: per-axis factors about an origin. Normals are re-normalized. */
export function scaleBodyXYZ(body: SolidBody, fx: number, fy: number, fz: number, origin: Vec3 = { x: 0, y: 0, z: 0 }): SolidBody {
  if (fx <= 0 || fy <= 0 || fz <= 0) throw new Error('Scale factors must be positive');
  const s = (v: Vec3): Vec3 => ({
    x: origin.x + (v.x - origin.x) * fx,
    y: origin.y + (v.y - origin.y) * fy,
    z: origin.z + (v.z - origin.z) * fz,
  });
  // Normal transform: inverse-transpose of the diagonal scale matrix = diag(1/fx, 1/fy, 1/fz), normalized.
  const n = (v: Vec3): Vec3 => {
    const nx = v.x / fx, ny = v.y / fy, nz = v.z / fz;
    const len = Math.hypot(nx, ny, nz);
    return len > 1e-12 ? { x: nx / len, y: ny / len, z: nz / len } : { ...v };
  };
  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(s),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(s),
      normal: n(f.normal),
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

  // A reflection is orientation-reversing: it flips each face's winding. To
  // keep the mirrored solid right-side-out, reverse each face's vertex order
  // (restoring CCW-outward winding) and reflect the normal *across the plane*
  // (linear part of the reflection) — not merely negate it, which is only
  // correct when the plane normal happens to align with the face normal.
  const reflectDir = (v: Vec3): Vec3 => {
    const k = 2 * (n.x * v.x + n.y * v.y + n.z * v.z);
    return { x: v.x - n.x * k, y: v.y - n.y * k, z: v.z - n.z * k };
  };

  const newVertices = body.vertices.map(mirrorVert);
  const newFaces = body.faces.map((f) => ({
    id: genId('face'),
    vertices: f.vertices.map(mirrorVert).reverse(),
    normal: reflectDir(f.normal),
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

/**
 * Flip every face's orientation (reverse winding + negate normal) in place,
 * turning a body inside-out — the fix for an imported mesh that renders
 * inverted. Keeps id/name/vertices/edges so it's an in-place edit.
 */
export function flipBodyNormals(body: SolidBody): SolidBody {
  return {
    ...body,
    faces: body.faces.map((f) => ({
      ...f,
      vertices: [...f.vertices].reverse(),
      normal: { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z },
    })),
  };
}

/**
 * Place a body into a coordinate system's frame: the body's current coordinates
 * are taken as local (CSYS-frame) coordinates and mapped to world space — the
 * rigid transform SolidWorks applies when inserting a part at a coordinate
 * system. The frame is orthonormal, so this is a pure rotation + translation:
 * lengths, volume and winding are preserved. Normals rotate with the frame (no
 * translation).
 */
export function placeBodyInFrame(body: SolidBody, cs: CoordinateSystemDefinition): SolidBody {
  const mapV = (v: Vec3): Vec3 => localToWorld(cs, v);
  // Rotate a direction by the frame basis only (no origin offset).
  const rotD = (d: Vec3): Vec3 => ({
    x: cs.xAxis.x * d.x + cs.yAxis.x * d.y + cs.zAxis.x * d.z,
    y: cs.xAxis.y * d.x + cs.yAxis.y * d.y + cs.zAxis.y * d.z,
    z: cs.xAxis.z * d.x + cs.yAxis.z * d.y + cs.zAxis.z * d.z,
  });
  return {
    id: genId('body'),
    name: `${body.name} (placed)`,
    vertices: body.vertices.map(mapV),
    faces: body.faces.map((f) => ({ id: genId('face'), vertices: f.vertices.map(mapV), normal: rotD(f.normal) })),
    edges: body.edges.map((e) => ({ id: genId('edge'), start: mapV(e.start), end: mapV(e.end) })),
  };
}

// --- Helpers ---

/**
 * Replace a body with its 3D convex hull — the tightest convex solid that
 * encloses all its vertices. Useful for collision proxies, clamp/grip shapes
 * and simplifying messy or concave imported meshes. Returns the original body
 * unchanged if the points are degenerate (coplanar / too few for a hull).
 */
export function convexHullBody(body: SolidBody, name: string = `${body.name} (hull)`): SolidBody {
  const hull = computeConvexHull(body.vertices);
  if (!hull) return body;
  const vertices = hull.vertices.map((v) => ({ ...v }));
  const faces: Face[] = hull.faces.map(([a, b, c]) => {
    const va = vertices[a]!;
    const vb = vertices[b]!;
    const vc = vertices[c]!;
    const n = normalize({
      x: (vb.y - va.y) * (vc.z - va.z) - (vb.z - va.z) * (vc.y - va.y),
      y: (vb.z - va.z) * (vc.x - va.x) - (vb.x - va.x) * (vc.z - va.z),
      z: (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x),
    });
    return { id: genId('face'), vertices: [va, vb, vc], normal: n };
  });
  const edges: Edge[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      edges.push({ id: genId('edge'), start: f.vertices[i]!, end: f.vertices[(i + 1) % f.vertices.length]! });
    }
  }
  return { id: genId('body'), name, vertices, faces, edges };
}

/**
 * Center a body so its bounding-box center sits at the origin. Useful for
 * normalizing imported meshes (STL/OBJ often arrive far from the origin), which
 * makes orbiting and center-based transforms behave intuitively.
 */
export function centerBody(body: SolidBody): SolidBody {
  if (body.vertices.length === 0) return body;
  const bb = computeBoundingBoxLocal(body);
  const offset: Vec3 = {
    x: -(bb.min.x + bb.max.x) / 2,
    y: -(bb.min.y + bb.max.y) / 2,
    z: -(bb.min.z + bb.max.z) / 2,
  };
  if (Math.abs(offset.x) < 1e-9 && Math.abs(offset.y) < 1e-9 && Math.abs(offset.z) < 1e-9) return body;
  return translateBody(body, offset);
}

/** Translate a body by an offset vector. */
export function translateBody(body: SolidBody, offset: Vec3, name: string = body.name): SolidBody {
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

/** Rotate a body by `angle` radians about an arbitrary axis (Rodrigues). */
export function rotateBody(
  body: SolidBody,
  axis: { origin: Vec3; direction: Vec3 },
  angle: number,
  name: string = body.name,
): SolidBody {
  const dir = normalize(axis.direction);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rotate a direction vector about the axis direction (no translation).
  const rotateDir = (p: Vec3): Vec3 => {
    const dot = dir.x * p.x + dir.y * p.y + dir.z * p.z;
    const cross = {
      x: dir.y * p.z - dir.z * p.y,
      y: dir.z * p.x - dir.x * p.z,
      z: dir.x * p.y - dir.y * p.x,
    };
    return {
      x: p.x * cos + cross.x * sin + dir.x * dot * (1 - cos),
      y: p.y * cos + cross.y * sin + dir.y * dot * (1 - cos),
      z: p.z * cos + cross.z * sin + dir.z * dot * (1 - cos),
    };
  };

  // Rotate a point: shift to the axis origin, rotate the offset, shift back.
  const rotate = (v: Vec3): Vec3 => {
    const r = rotateDir({ x: v.x - axis.origin.x, y: v.y - axis.origin.y, z: v.z - axis.origin.z });
    return { x: axis.origin.x + r.x, y: axis.origin.y + r.y, z: axis.origin.z + r.z };
  };

  return {
    id: genId('body'),
    name,
    vertices: body.vertices.map(rotate),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(rotate),
      normal: rotateDir(f.normal),
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: rotate(e.start),
      end: rotate(e.end),
    })),
  };
}

/**
 * Weld near-coincident vertices: snap to a tolerance grid and replace every
 * reference (in faces and edges) with a single representative. Collapses the
 * degenerate faces/edges that result, so an imported STL (per-triangle, float-
 * jittered vertices) becomes a shared-vertex, watertight-friendly mesh.
 */
export function weldVertices(body: SolidBody, tolerance = 1e-4): SolidBody {
  const inv = 1 / Math.max(tolerance, 1e-12);
  const key = (v: Vec3) => `${Math.round(v.x * inv)},${Math.round(v.y * inv)},${Math.round(v.z * inv)}`;
  const rep = new Map<string, Vec3>();
  const weld = (v: Vec3): Vec3 => {
    const k = key(v);
    let r = rep.get(k);
    if (!r) {
      r = v;
      rep.set(k, r);
    }
    return r;
  };

  const faces: Face[] = [];
  for (const f of body.faces) {
    const welded = f.vertices.map(weld);
    // Drop vertices equal to their predecessor (collapsed edges).
    const cleaned = welded.filter((v, i) => v !== welded[(i - 1 + welded.length) % welded.length]);
    if (cleaned.length >= 3) {
      faces.push({ id: f.id, vertices: cleaned, normal: f.normal });
    }
  }

  const edges: Edge[] = [];
  for (const e of body.edges) {
    const s = weld(e.start);
    const t = weld(e.end);
    if (s !== t) edges.push({ id: e.id, start: s, end: t });
  }

  return { id: body.id, name: body.name, vertices: Array.from(rep.values()), faces, edges };
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
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (l < 1e-10) return { x: 0, y: 1, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function vecLen(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
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

/**
 * Sweep: extrude a 2D profile along a 3D path. The profile is a loop of 2D
 * points (in the local XY plane) that gets oriented perpendicular to the path
 * tangent at each path sample. Returns a closed solid body.
 *
 * @param profile  2D profile points (closed loop, in XY plane, Z=0).
 * @param path     3D path points (at least 2).
 * @param twist    Total twist angle in radians (default 0).
 */
export function sweepBody(profile: { x: number; y: number }[], path: Vec3[], twist = 0): SolidBody {
  if (profile.length < 3 || path.length < 2) throw new Error('Profile needs ≥3 points, path needs ≥2 points');

  const faces: Face[] = [];
  const edges: Edge[] = [];
  const profileN = profile.length;
  const pathN = path.length;

  // Compute path tangents at each sample.
  const tangents: Vec3[] = [];
  for (let i = 0; i < pathN; i++) {
    let t: Vec3;
    if (i === 0) {
      t = normalize({ x: path[1]!.x - path[0]!.x, y: path[1]!.y - path[0]!.y, z: path[1]!.z - path[0]!.z });
    } else if (i === pathN - 1) {
      t = normalize({ x: path[i]!.x - path[i - 1]!.x, y: path[i]!.y - path[i - 1]!.y, z: path[i]!.z - path[i - 1]!.z });
    } else {
      t = normalize({ x: path[i + 1]!.x - path[i - 1]!.x, y: path[i + 1]!.y - path[i - 1]!.y, z: path[i + 1]!.z - path[i - 1]!.z });
    }
    tangents.push(t);
  }

  // Build a rotation frame (up, right) at each path point using a reference
  // vector that avoids gimbal lock.
  const ref = Math.abs(tangents[0]!.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const frames: { up: Vec3; right: Vec3 }[] = [];
  let prevUp = ref;
  for (let i = 0; i < pathN; i++) {
    const t = tangents[i]!;
    // Gram-Schmidt: project prevUp onto the plane perpendicular to t.
    const dot = prevUp.x * t.x + prevUp.y * t.y + prevUp.z * t.z;
    let up = normalize({ x: prevUp.x - dot * t.x, y: prevUp.y - dot * t.y, z: prevUp.z - dot * t.z });
    const right = cross(t, up);
    frames.push({ up, right });
    prevUp = up;
  }

  // Place the profile at each path point and connect with quads.
  const rings: Vec3[][] = [];
  for (let i = 0; i < pathN; i++) {
    const p = path[i]!;
    const { up, right } = frames[i]!;
    const angle = (twist * i) / (pathN - 1);
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const ring: Vec3[] = [];
    for (const pt of profile) {
      // Rotate by twist, then orient in 3D.
      const lx = pt.x * cosA - pt.y * sinA;
      const ly = pt.x * sinA + pt.y * cosA;
      ring.push({
        x: p.x + right.x * lx + up.x * ly,
        y: p.y + right.x * lx + up.y * ly, // BUG: should be right.y
        z: p.z + right.z * lx + up.z * ly,
      });
    }
    rings.push(ring);
  }

  // Fix the y component bug above — let me rewrite the placement.
  // Actually, let me just fix it inline:
  rings.length = 0;
  for (let i = 0; i < pathN; i++) {
    const p = path[i]!;
    const { up, right } = frames[i]!;
    const angle = (twist * i) / (pathN - 1);
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const ring: Vec3[] = [];
    for (const pt of profile) {
      const lx = pt.x * cosA - pt.y * sinA;
      const ly = pt.x * sinA + pt.y * cosA;
      ring.push({
        x: p.x + right.x * lx + up.x * ly,
        y: p.y + right.y * lx + up.y * ly,
        z: p.z + right.z * lx + up.z * ly,
      });
    }
    rings.push(ring);
  }

  // Side faces: connect adjacent rings.
  for (let i = 0; i < pathN - 1; i++) {
    const r0 = rings[i]!;
    const r1 = rings[i + 1]!;
    for (let j = 0; j < profileN; j++) {
      const j2 = (j + 1) % profileN;
      const v00 = r0[j]!, v01 = r0[j2]!;
      const v10 = r1[j]!, v11 = r1[j2]!;
      const fn = computeFaceNormal(v00, v10, v11);
      faces.push({ id: genId('face'), vertices: [v00, v10, v11, v01], normal: fn });
      edges.push(
        { id: genId('edge'), start: v00, end: v10 },
        { id: genId('edge'), start: v01, end: v11 },
      );
    }
  }

  // Cap faces: start and end.
  const capStart = rings[0]!;
  const capEnd = rings[pathN - 1]!;
  const startNormal = normalize({ x: -tangents[0]!.x, y: -tangents[0]!.y, z: -tangents[0]!.z });
  const endNormal = tangents[pathN - 1]!;
  faces.push({ id: genId('face'), vertices: [...capStart].reverse(), normal: startNormal });
  faces.push({ id: genId('face'), vertices: [...capEnd], normal: endNormal });

  // Ring edges.
  for (const ring of rings) {
    for (let j = 0; j < profileN; j++) {
      edges.push({ id: genId('edge'), start: ring[j]!, end: ring[(j + 1) % profileN]! });
    }
  }

  const vertices: Vec3[] = [];
  for (const f of faces) vertices.push(...f.vertices);
  return { id: genId('body'), name: 'Sweep', vertices, faces, edges };
}
