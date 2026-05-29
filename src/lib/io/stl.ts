import type { SolidBody, Vec3 } from '../geometry/types';

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
