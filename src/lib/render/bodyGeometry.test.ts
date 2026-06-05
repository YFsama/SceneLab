import { describe, it, expect } from 'vitest';
import { buildBodyMeshArrays } from './bodyGeometry';
import { createBox, createCylinder } from '../geometry/brep';
import type { SolidBody } from '../geometry/types';

describe('buildBodyMeshArrays', () => {
  it('fan-triangulates each face and indexes into its own vertices', () => {
    // A box: 6 quad faces → 4 verts each (24 positions) and 2 triangles each.
    const { positions, indices } = buildBodyMeshArrays(createBox(10, 10, 10));
    expect(positions.length).toBe(6 * 4 * 3); // 6 faces × 4 verts × xyz
    expect(indices.length).toBe(6 * 2 * 3); // 6 faces × 2 tris × 3 indices
    // Every index must reference an emitted vertex.
    const vertCount = positions.length / 3;
    for (const i of indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(vertCount);
    }
  });

  it('triangulates an n-gon cap into (n-2) triangles', () => {
    // A cylinder has two 32-gon caps + 32 quad sides.
    const segs = 32;
    const { indices } = buildBodyMeshArrays(createCylinder(5, 10, segs));
    const triCount = indices.length / 3;
    const expected = 2 * (segs - 2) + segs * 2; // caps + side quads
    expect(triCount).toBe(expected);
  });

  it('skips degenerate faces with fewer than 3 vertices', () => {
    const body: SolidBody = {
      id: 'b',
      name: 'b',
      vertices: [],
      faces: [{ id: 'f', vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], normal: { x: 0, y: 1, z: 0 } }],
      edges: [],
    };
    const { positions, indices } = buildBodyMeshArrays(body);
    expect(positions).toHaveLength(0);
    expect(indices).toHaveLength(0);
  });

  it('triFaceIds maps each triangle to a face ID', () => {
    const box = createBox(10, 10, 10);
    const { indices, triFaceIds } = buildBodyMeshArrays(box);
    expect(triFaceIds.length).toBe(indices.length / 3);
    // All face IDs should be non-empty strings.
    for (const fid of triFaceIds) {
      expect(fid.length).toBeGreaterThan(0);
    }
  });

  it('triFaceIds contains unique face IDs for a box', () => {
    const box = createBox(10, 10, 10);
    const { triFaceIds } = buildBodyMeshArrays(box);
    const uniqueIds = new Set(triFaceIds);
    expect(uniqueIds.size).toBe(6); // 6 faces
  });

  it('triFaceIds references valid face IDs from the body', () => {
    const box = createBox(10, 10, 10);
    const { triFaceIds } = buildBodyMeshArrays(box);
    const faceIds = new Set(box.faces.map((f) => f.id));
    for (const fid of triFaceIds) {
      expect(faceIds.has(fid)).toBe(true);
    }
  });
});
