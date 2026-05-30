import type { SolidBody, Vec3 } from '../geometry/types';
import { weldVertices } from '../geometry';

/** Export a body as binary STL */
export function exportSTLBinary(body: SolidBody): ArrayBuffer {
  const triangles = body.faces.flatMap((face) => {
    const tris: Array<{ normal: Vec3; verts: Vec3[] }> = [];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      tris.push({
        normal: face.normal,
        verts: [face.vertices[0]!, face.vertices[i]!, face.vertices[i + 1]!],
      });
    }
    return tris;
  });

  const bufferSize = 84 + triangles.length * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // Header (80 bytes)
  const header = 'SceneLab STL Export';
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, header.charCodeAt(i) ?? 0);
  }

  // Triangle count
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  for (const tri of triangles) {
    // Normal
    view.setFloat32(offset, tri.normal.x, true); offset += 4;
    view.setFloat32(offset, tri.normal.y, true); offset += 4;
    view.setFloat32(offset, tri.normal.z, true); offset += 4;

    // Vertices
    for (const v of tri.verts) {
      view.setFloat32(offset, v.x, true); offset += 4;
      view.setFloat32(offset, v.y, true); offset += 4;
      view.setFloat32(offset, v.z, true); offset += 4;
    }

    // Attribute byte count
    view.setUint16(offset, 0, true); offset += 2;
  }

  return buffer;
}

/** Export a body as ASCII STL */
export function exportSTLAscii(body: SolidBody): string {
  let output = `solid ${body.name}\n`;

  for (const face of body.faces) {
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const v0 = face.vertices[0]!;
      const v1 = face.vertices[i]!;
      const v2 = face.vertices[i + 1]!;

      output += `  facet normal ${face.normal.x} ${face.normal.y} ${face.normal.z}\n`;
      output += '    outer loop\n';
      output += `      vertex ${v0.x} ${v0.y} ${v0.z}\n`;
      output += `      vertex ${v1.x} ${v1.y} ${v1.z}\n`;
      output += `      vertex ${v2.x} ${v2.y} ${v2.z}\n`;
      output += '    endloop\n';
      output += '  endfacet\n';
    }
  }

  output += `endsolid ${body.name}\n`;
  return output;
}

let importId = 1;

/** Unit normal from a triangle's winding (right-hand rule), or null if degenerate. */
function windingNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

function normalizeOrZero(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / len, y: v.y / len, z: v.z / len };
}

function buildBody(
  name: string,
  tris: Array<{ normal: Vec3; verts: [Vec3, Vec3, Vec3] }>,
): SolidBody {
  const vertices: Vec3[] = [];
  const seen = new Map<string, Vec3>();
  const faces = [];
  const edges = [];
  const key = (v: Vec3) => `${v.x},${v.y},${v.z}`;
  const intern = (v: Vec3): Vec3 => {
    const k = key(v);
    let existing = seen.get(k);
    if (!existing) {
      existing = v;
      seen.set(k, v);
      vertices.push(v);
    }
    return existing;
  };

  for (const tri of tris) {
    const a = intern(tri.verts[0]);
    const b = intern(tri.verts[1]);
    const c = intern(tri.verts[2]);
    // The STL spec makes the vertex winding (right-hand rule) authoritative;
    // file facet normals are frequently (0,0,0) or wrong. Recompute from the
    // winding so imported parts have valid normals for printability analysis,
    // falling back to the file normal only for degenerate (zero-area) triangles.
    const normal = windingNormal(a, b, c) ?? normalizeOrZero(tri.normal);
    faces.push({ id: `face_${importId++}`, vertices: [a, b, c], normal });
    edges.push(
      { id: `edge_${importId++}`, start: a, end: b },
      { id: `edge_${importId++}`, start: b, end: c },
      { id: `edge_${importId++}`, start: c, end: a },
    );
  }

  return { id: `body_${importId++}`, name, vertices, faces, edges };
}

/**
 * Parse an ASCII STL string into a SolidBody (one face per triangle).
 * Near-coincident vertices are welded (set weldTolerance to 0 to disable).
 */
export function importSTLAscii(text: string, weldTolerance = 1e-4): SolidBody {
  const tris: Array<{ normal: Vec3; verts: [Vec3, Vec3, Vec3] }> = [];
  const nameMatch = text.match(/^\s*solid\s+(.*)$/m);
  const name = nameMatch?.[1]?.trim() || 'Imported';

  const num = (s: string) => Number.parseFloat(s);
  let normal: Vec3 = { x: 0, y: 0, z: 0 };
  let loop: Vec3[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('facet normal')) {
      const p = line.split(/\s+/);
      normal = { x: num(p[2]!), y: num(p[3]!), z: num(p[4]!) };
      loop = [];
    } else if (line.startsWith('vertex')) {
      const p = line.split(/\s+/);
      loop.push({ x: num(p[1]!), y: num(p[2]!), z: num(p[3]!) });
    } else if (line.startsWith('endfacet')) {
      if (loop.length >= 3) tris.push({ normal, verts: [loop[0]!, loop[1]!, loop[2]!] });
    }
  }

  const body = buildBody(name, tris);
  return weldTolerance > 0 ? weldVertices(body, weldTolerance) : body;
}

/**
 * Parse a binary STL buffer into a SolidBody (one face per triangle).
 * Near-coincident vertices are welded (set weldTolerance to 0 to disable).
 */
export function importSTLBinary(buffer: ArrayBuffer, weldTolerance = 1e-4): SolidBody {
  const view = new DataView(buffer);
  if (buffer.byteLength < 84) throw new Error('Invalid binary STL: too short');
  const count = view.getUint32(80, true);
  if (buffer.byteLength < 84 + count * 50) throw new Error('Invalid binary STL: truncated');

  const tris: Array<{ normal: Vec3; verts: [Vec3, Vec3, Vec3] }> = [];
  let offset = 84;
  const readVec = (): Vec3 => {
    const v = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
    offset += 12;
    return v;
  };
  for (let i = 0; i < count; i++) {
    const normal = readVec();
    const verts: [Vec3, Vec3, Vec3] = [readVec(), readVec(), readVec()];
    offset += 2; // attribute byte count
    tris.push({ normal, verts });
  }

  const body = buildBody('Imported', tris);
  return weldTolerance > 0 ? weldVertices(body, weldTolerance) : body;
}

/**
 * Parse STL from either a string (ASCII) or an ArrayBuffer, auto-detecting
 * binary vs ASCII by the binary length formula (84 + 50·triangles).
 */
export function importSTL(data: string | ArrayBuffer, weldTolerance = 1e-4): SolidBody {
  if (typeof data === 'string') return importSTLAscii(data, weldTolerance);
  if (data.byteLength >= 84) {
    const tri = new DataView(data).getUint32(80, true);
    if (84 + tri * 50 === data.byteLength) return importSTLBinary(data, weldTolerance);
  }
  // Not a well-formed binary STL — treat the bytes as ASCII text.
  return importSTLAscii(new TextDecoder().decode(data), weldTolerance);
}
