import type { SolidBody } from '../geometry/types';
import { triangulateFace } from '../geometry/brep';

export interface MeshArrays {
  /** Flat XYZ positions, 3 numbers per vertex. */
  positions: number[];
  /** Triangle vertex indices into `positions` (every 3 = one triangle). */
  indices: number[];
  /** Maps each triangle (by index / 3) to the original face ID. */
  triFaceIds: string[];
}

/**
 * Build flat position/index arrays for a body's render mesh. Each face is
 * triangulated (concave-safe ear-clip — the Manifold decimation can emit
 * concave polygonal faces a naive fan would wind inside-out, inverting one
 * triangle over the pocket in the viewport and picking) and contributes its
 * own copy of its vertices, so adjacent faces don't share vertices — giving
 * correct flat (faceted) shading once normals are derived from the winding.
 * Pure (no Three.js), so it is unit testable and reusable for
 * export/screenshot paths.
 */
export function buildBodyMeshArrays(body: SolidBody): MeshArrays {
  const positions: number[] = [];
  const indices: number[] = [];
  const triFaceIds: string[] = [];

  for (const face of body.faces) {
    if (face.vertices.length < 3) continue;
    const baseIdx = positions.length / 3;
    for (const v of face.vertices) {
      positions.push(v.x, v.y, v.z);
    }
    // Concave-safe ear-clip (decimated bodies carry concave polygonal faces
    // a naive fan would wind inside-out). triangulateFace yields vertex
    // references from the same array — map them back to local indices.
    const localIndexOf = new Map(face.vertices.map((v, i) => [v, i] as const));
    for (const tri of triangulateFace(face.vertices)) {
      const a = localIndexOf.get(tri[0]);
      const b = localIndexOf.get(tri[1]);
      const c = localIndexOf.get(tri[2]);
      if (a === undefined || b === undefined || c === undefined) continue; // defensive: clone drift
      indices.push(baseIdx + a, baseIdx + b, baseIdx + c);
      triFaceIds.push(face.id);
    }
  }

  return { positions, indices, triFaceIds };
}
