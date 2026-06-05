import { describe, it, expect } from 'vitest';
import { buildBodyMeshArrays } from './bodyGeometry';
import { createBox, createCylinder } from '../geometry/brep';

describe('buildBodyMeshArrays', () => {
  it('produces positions, indices, and triFaceIds', () => {
    const box = createBox(10, 10, 10);
    const result = buildBodyMeshArrays(box);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.indices.length).toBeGreaterThan(0);
    expect(result.triFaceIds.length).toBeGreaterThan(0);
  });

  it('triFaceIds maps each triangle to a face ID', () => {
    const box = createBox(10, 10, 10);
    const result = buildBodyMeshArrays(box);
    // Each triangle (3 indices) should have a corresponding face ID.
    expect(result.triFaceIds.length).toBe(result.indices.length / 3);
    // All face IDs should be non-empty strings.
    for (const fid of result.triFaceIds) {
      expect(fid.length).toBeGreaterThan(0);
    }
  });

  it('produces correct vertex count for a box (6 faces × 4 verts = 24)', () => {
    const box = createBox(10, 10, 10);
    const result = buildBodyMeshArrays(box);
    // Box has 6 faces, each a quad (4 vertices, 2 triangles).
    expect(result.positions.length / 3).toBe(24); // 6 × 4
    expect(result.indices.length / 3).toBe(12); // 6 × 2
    expect(result.triFaceIds.length).toBe(12);
  });

  it('produces correct vertex count for a cylinder', () => {
    const cyl = createCylinder(5, 10, 16);
    const result = buildBodyMeshArrays(cyl);
    // Cylinder has side faces + 2 caps.
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.indices.length).toBeGreaterThan(0);
    expect(result.triFaceIds.length).toBe(result.indices.length / 3);
  });

  it('triFaceIds contains unique face IDs', () => {
    const box = createBox(10, 10, 10);
    const result = buildBodyMeshArrays(box);
    const uniqueIds = new Set(result.triFaceIds);
    // A box has 6 faces, so 6 unique face IDs.
    expect(uniqueIds.size).toBe(6);
  });
});
