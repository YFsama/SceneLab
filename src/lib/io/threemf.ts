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

    xml += `    <object id="${id}" name="${escapeXml(body.name)}" type="model">\n`;
    xml += '      <mesh>\n';
    xml += '        <vertices>\n';

    for (const v of body.vertices) {
          xml += `          <vertex x="${v.x}" y="${v.y}" z="${v.z}" />\n`;
    }

    xml += '        </vertices>\n';
    xml += '        <triangles>\n';

    for (const face of body.faces) {
      for (let i = 1; i < face.vertices.length - 1; i++) {
        const v0 = body.vertices.indexOf(face.vertices[0]!);
        const v1 = body.vertices.indexOf(face.vertices[i]!);
        const v2 = body.vertices.indexOf(face.vertices[i + 1]!);
        xml += `          <triangle v1="${v0}" v2="${v1}" v3="${v2}" />\n`;
      }
    }

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
