import type { SolidBody } from '../geometry/types';

/** Export body as 3MF (XML-based 3D Manufacturing Format) */
export function export3MF(bodies: SolidBody[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<model unit="millimeter" xml:lang="en-US"\n';
  xml += '  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"\n';
  xml += '  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n';
  xml += '  <resources>\n';

  let objectId = 1;
  const objectIds: number[] = [];

  for (const body of bodies) {
    const id = objectId++;
    objectIds.push(id);

    // Index vertices by coordinate (interning each face vertex). Matching by
    // reference identity breaks for any transformed body, since operations
    // rebuild face vertices as separate objects from body.vertices — yielding
    // invalid -1 triangle indices. Interning keeps <vertices> and the triangle
    // indices consistent regardless, and is O(n) rather than O(n²).
    const indexByKey = new Map<string, number>();
    const orderedVerts: typeof body.vertices = [];
    const indexOf = (v: (typeof body.vertices)[number]): number => {
      const key = `${v.x},${v.y},${v.z}`;
      let idx = indexByKey.get(key);
      if (idx === undefined) {
        idx = orderedVerts.length;
        indexByKey.set(key, idx);
        orderedVerts.push(v);
      }
      return idx;
    };

    const triangleLines: string[] = [];
    for (const face of body.faces) {
      for (let i = 1; i < face.vertices.length - 1; i++) {
        const v0 = indexOf(face.vertices[0]!);
        const v1 = indexOf(face.vertices[i]!);
        const v2 = indexOf(face.vertices[i + 1]!);
        triangleLines.push(`          <triangle v1="${v0}" v2="${v1}" v3="${v2}" />\n`);
      }
    }

    xml += `    <object id="${id}" name="${escapeXml(body.name)}" type="model">\n`;
    xml += '      <mesh>\n';
    xml += '        <vertices>\n';

    for (const v of orderedVerts) {
          xml += `          <vertex x="${v.x}" y="${v.y}" z="${v.z}" />\n`;
    }

    xml += '        </vertices>\n';
    xml += '        <triangles>\n';
    for (const line of triangleLines) xml += line;
    xml += '        </triangles>\n';
    xml += '      </mesh>\n';
    xml += '    </object>\n';
  }

  xml += '  </resources>\n';
  xml += '  <build>\n';

  for (const id of objectIds) {
    xml += `    <item objectid="${id}" />\n`;
  }

  xml += '  </build>\n';
  xml += '</model>\n';

  return xml;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* Proper OPC package + import. A real .3mf file is a ZIP (OPC) with   */
/* [Content_Types].xml, _rels/.rels and 3D/3dmodel.model — the bare    */
/* XML that export3MF returns is only the model document.              */
/* ------------------------------------------------------------------ */
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import type { Vec3, Face } from '../geometry/types';
import { buildEdgesFromFaces } from '../geometry/brep';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`;

/** Package the model document into a spec-compliant .3mf ZIP. */
export function export3MFPackage(bodies: SolidBody[]): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(export3MF(bodies)),
  }, { level: 6 });
}

/**
 * Import a 3MF file — either a spec ZIP package or a bare model document —
 * into one SolidBody per model object. Triangles share a per-object vertex
 * pool; faces are rebuilt as single triangles with computed outward normals
 * (3MF winding: counter-clockwise seen from outside).
 */
export function import3MF(data: Uint8Array | string): SolidBody[] {
  let xml: string;
  if (typeof data === 'string') {
    xml = data;
  } else if (data.length > 2 && data[0] === 0x50 && data[1] === 0x4b) {
    const files = unzipSync(data);
    const modelPath =
      Object.keys(files).find((p) => p.replace(/\\/g, '/').endsWith('3D/3dmodel.model')) ??
      Object.keys(files).find((p) => p.replace(/\\/g, '/').endsWith('.model'));
    if (!modelPath) throw new Error('No 3D model part found in 3MF package');
    xml = strFromU8(files[modelPath]!);
  } else {
    xml = strFromU8(data);
  }

  const bodies: SolidBody[] = [];
  let nextId = 1;
  // Parse per <object> blocks: each has one <vertices> and one <triangles>.
  const objRe = /<object\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/object>|<object\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml)) !== null) {
    const name = m[1] || `3MF Object ${nextId}`;
    const inner = m[2] ?? '';
    const vertRe = /<vertex\b[^>]*\bx="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    const verts: Vec3[] = [];
    let vm: RegExpExecArray | null;
    while ((vm = vertRe.exec(inner)) !== null) {
      const x = Number(vm[1]), y = Number(vm[2]), z = Number(vm[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push({ x, y, z });
    }
    const triRe = /<triangle\b[^>]*\bv1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    const faces: Face[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = triRe.exec(inner)) !== null) {
      const [i1, i2, i3] = [Number(tm[1]), Number(tm[2]), Number(tm[3])];
      const a = verts[i1], b = verts[i2], c = verts[i3];
      if (!a || !b || !c) continue;
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
      const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      faces.push({
        id: `face_3mf_${nextId}_${faces.length}`,
        vertices: [a, b, c],
        normal: { x: nx / len, y: ny / len, z: nz / len },
      });
    }
    if (faces.length === 0 || verts.length === 0) continue;
    const vertices: Vec3[] = [];
    for (const f of faces) vertices.push(...f.vertices);
    bodies.push({
      id: `body_3mf_${nextId}`,
      name,
      vertices,
      faces,
      edges: buildEdgesFromFaces(faces),
    });
    nextId++;
  }
  if (bodies.length === 0) throw new Error('No mesh objects found in 3MF file');
  return bodies;
}
