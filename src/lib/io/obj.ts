import type { SolidBody, Vec3, Face, Edge } from '../geometry/types';

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / l, y: ny / l, z: nz / l };
}

/** Export a body as a Wavefront OBJ string (polygon faces preserved). */
export function exportOBJ(body: SolidBody): string {
  const verts: Vec3[] = [];
  const index = new Map<string, number>();
  const key = (v: Vec3) => `${v.x},${v.y},${v.z}`;
  const indexOf = (v: Vec3): number => {
    const k = key(v);
    let i = index.get(k);
    if (i === undefined) {
      verts.push(v);
      i = verts.length; // 1-based
      index.set(k, i);
    }
    return i;
  };

  // Resolve face indices first so `verts` is fully populated.
  const faceIndices = body.faces.map((f) => f.vertices.map(indexOf));

  let out = `# SceneLab OBJ export\no ${body.name}\n`;
  for (const v of verts) out += `v ${v.x} ${v.y} ${v.z}\n`;
  for (const fi of faceIndices) out += `f ${fi.join(' ')}\n`;
  return out;
}

/** Parse a Wavefront OBJ string into a SolidBody. */
export function importOBJ(text: string): SolidBody {
  const verts: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  let name = 'Imported';
  let id = 1;

  const num = (s: string) => Number.parseFloat(s);

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push({ x: num(p[1]!), y: num(p[2]!), z: num(p[3]!) });
    } else if (line.startsWith('o ')) {
      name = line.slice(2).trim() || name;
    } else if (line.startsWith('f ')) {
      const tokens = line.split(/\s+/).slice(1);
      const fv: Vec3[] = [];
      for (const tok of tokens) {
        let i = Number.parseInt(tok.split('/')[0]!, 10);
        if (Number.isNaN(i)) continue;
        if (i < 0) i = verts.length + i + 1; // negative = relative to end
        const v = verts[i - 1];
        if (v) fv.push(v);
      }
      if (fv.length >= 3) {
        faces.push({ id: `face_${id++}`, vertices: fv, normal: faceNormal(fv[0]!, fv[1]!, fv[2]!) });
        for (let k = 0; k < fv.length; k++) {
          edges.push({ id: `edge_${id++}`, start: fv[k]!, end: fv[(k + 1) % fv.length]! });
        }
      }
    }
  }

  return { id: `body_${id}`, name, vertices: verts, faces, edges };
}
