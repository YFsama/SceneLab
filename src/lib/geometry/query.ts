import type { SolidBody, Vec3 } from './types';
import { computeFaceAreas } from './brep';

export interface FaceInfo {
  id: string;
  area: number;
  /** Unit outward normal. */
  normal: Vec3;
  /** Face centroid (average of its vertices). */
  centroid: Vec3;
  vertexCount: number;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Inspect a body's faces — id, area, outward normal and centroid — so the UI
 * or AI can reference specific faces (e.g. to fillet, chamfer, or shell). The
 * face ids match those accepted by the face-based operations.
 */
export function listFaces(body: SolidBody): FaceInfo[] {
  const areaById = new Map<string, number>();
  for (const { faceId, area } of computeFaceAreas(body)) areaById.set(faceId, area);

  return body.faces.map((f) => {
    const c = { x: 0, y: 0, z: 0 };
    for (const v of f.vertices) {
      c.x += v.x / f.vertices.length;
      c.y += v.y / f.vertices.length;
      c.z += v.z / f.vertices.length;
    }
    return {
      id: f.id,
      area: areaById.get(f.id) ?? 0,
      normal: normalize(f.normal),
      centroid: c,
      vertexCount: f.vertices.length,
    };
  });
}
