import type { SolidBody } from '../geometry/types';

export interface MeshArrays {
  /** Flat XYZ positions, 3 numbers per vertex. */
  positions: number[];
  /** Triangle vertex indices into `positions` (every 3 = one triangle). */
  indices: number[];
}

/**
 * Build flat position/index arrays for a body's render mesh. Each face is
 * fan-triangulated and contributes its own copy of its vertices, so adjacent
 * faces don't share vertices — giving correct flat (faceted) shading once
 * normals are derived from the winding. Pure (no Three.js), so it is unit
 * testable and reusable for export/screenshot paths.
 */
export function buildBodyMeshArrays(body: SolidBody): MeshArrays {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const face of body.faces) {
    if (face.vertices.length < 3) continue;
    const baseIdx = positions.length / 3;
    for (const v of face.vertices) {
      positions.push(v.x, v.y, v.z);
    }
    for (let i = 1; i < face.vertices.length - 1; i++) {
      indices.push(baseIdx, baseIdx + i, baseIdx + i + 1);
    }
  }

  return { positions, indices };
}
