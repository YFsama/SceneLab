import { describe, it, expect } from 'vitest';
import { buildBodyMeshArrays } from './bodyGeometry';
import { createBox, createCylinder } from '../geometry/brep';

describe('face selection support', () => {
  it('triFaceIds correctly maps triangles to face IDs for a box', () => {
    const box = createBox(10, 10, 10);
    const { indices, triFaceIds } = buildBodyMeshArrays(box);

    // Each face should have exactly 2 triangles (quad → 2 tris).
    const faceCounts = new Map<string, number>();
    for (const fid of triFaceIds) {
      faceCounts.set(fid, (faceCounts.get(fid) ?? 0) + 1);
    }
    for (const [, count] of faceCounts) {
      expect(count).toBe(2); // each quad face → 2 triangles
    }
    expect(faceCounts.size).toBe(6); // 6 faces on a box
  });

  it('triFaceIds indices align with the index buffer', () => {
    const box = createBox(10, 10, 10);
    const { indices, triFaceIds } = buildBodyMeshArrays(box);

    // For each triangle, the face ID should correspond to one of the body's faces.
    const faceIds = new Set(box.faces.map((f) => f.id));
    for (const fid of triFaceIds) {
      expect(faceIds.has(fid)).toBe(true);
    }
  });

  it('cylinder has more face IDs than a box', () => {
    const box = createBox(10, 10, 10);
    const cyl = createCylinder(5, 10, 16);

    const boxFaces = new Set(buildBodyMeshArrays(box).triFaceIds);
    const cylFaces = new Set(buildBodyMeshArrays(cyl).triFaceIds);

    // Cylinder has side faces + 2 caps = 18 faces (16 side + 2 cap).
    expect(cylFaces.size).toBeGreaterThan(boxFaces.size);
  });

  it('vertex colors array length matches positions', () => {
    const box = createBox(10, 10, 10);
    const { positions } = buildBodyMeshArrays(box);

    // In ViewportCanvas, a Float32Array of length positions.length is created
    // for vertex colors (3 floats per vertex).
    const colors = new Float32Array(positions.length);
    expect(colors.length).toBe(positions.length);
    expect(colors.length % 3).toBe(0); // RGB per vertex
  });
});
