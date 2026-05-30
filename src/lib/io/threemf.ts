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
