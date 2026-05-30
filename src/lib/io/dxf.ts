import type { SolidBody, Vec3 } from '../geometry/types';

/** Export body as DXF (AutoCAD Drawing Exchange Format) */
export function exportDXF(body: SolidBody): string {
  const lines: string[] = [];

  // DXF Header
  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1009');
  lines.push('0', 'ENDSEC');

  // Tables section (minimal)
  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER', '70', '3');
  lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'EDGES', '70', '0', '62', '1', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'HIDDEN', '70', '0', '62', '5', '6', 'DASHED');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  // Entities section
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  // Project edges to XY plane (top view) for 2D DXF
  for (const edge of body.edges) {
    addLine(lines, edge.start, edge.end, 'EDGES');
  }

  // Also add face outlines projected to XY
  for (const face of body.faces) {
    for (let i = 0; i < face.vertices.length; i++) {
      const next = (i + 1) % face.vertices.length;
      addLine(lines, face.vertices[i]!, face.vertices[next]!, '0');
    }
  }

  lines.push('0', 'ENDSEC');

  // EOF
  lines.push('0', 'EOF');

  return lines.join('\r\n');
}

function addLine(lines: string[], start: Vec3, end: Vec3, layer: string): void {
  lines.push('0', 'LINE');
  lines.push('8', layer);
  lines.push('10', start.x.toFixed(6));
  lines.push('20', start.y.toFixed(6));
  lines.push('30', start.z.toFixed(6));
  lines.push('11', end.x.toFixed(6));
  lines.push('21', end.y.toFixed(6));
  lines.push('31', end.z.toFixed(6));
}

/** Emit one triangular 3DFACE entity (the 4th vertex repeats the 3rd). */
function add3DFace(lines: string[], v0: Vec3, v1: Vec3, v2: Vec3): void {
  lines.push('0', '3DFACE');
  lines.push('8', 'FACES');
  lines.push('10', v0.x.toFixed(6), '20', v0.y.toFixed(6), '30', v0.z.toFixed(6));
  lines.push('11', v1.x.toFixed(6), '21', v1.y.toFixed(6), '31', v1.z.toFixed(6));
  lines.push('12', v2.x.toFixed(6), '22', v2.y.toFixed(6), '32', v2.z.toFixed(6));
  lines.push('13', v2.x.toFixed(6), '23', v2.y.toFixed(6), '33', v2.z.toFixed(6));
}

/** Export body as 3D DXF with POLYLINE faces */
export function exportDXF3D(body: SolidBody): string {
  const lines: string[] = [];

  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1009');
  lines.push('0', 'ENDSEC');

  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER', '70', '2');
  lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'FACES', '70', '0', '62', '3', '6', 'CONTINUOUS');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  lines.push('0', 'SECTION', '2', 'ENTITIES');

  // Write faces as 3DFACE entities. A 3DFACE holds at most 4 vertices, so
  // fan-triangulate any larger polygon (e.g. an n-gon cylinder/cone cap) —
  // writing only the first four would silently drop the rest of the face.
  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    for (let i = 1; i < verts.length - 1; i++) {
      add3DFace(lines, verts[0]!, verts[i]!, verts[i + 1]!);
    }
  }

  // Also write edges as LINE entities
  for (const edge of body.edges) {
    addLine(lines, edge.start, edge.end, '0');
  }

  lines.push('0', 'ENDSEC');
  lines.push('0', 'EOF');

  return lines.join('\r\n');
}
