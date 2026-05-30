import { describe, it, expect } from 'vitest';
import { listFaces } from './query';
import { createBox } from './brep';

describe('listFaces', () => {
  it('reports a box face: 6 faces, area 100, unit axis normals', () => {
    const faces = listFaces(createBox(10, 10, 10));
    expect(faces).toHaveLength(6);
    for (const f of faces) {
      expect(f.area).toBeCloseTo(100, 3);
      expect(Math.hypot(f.normal.x, f.normal.y, f.normal.z)).toBeCloseTo(1, 6);
      expect(f.id).toBeTruthy();
    }
    // There is a +Y face whose centroid sits at the top (y = 10).
    const top = faces.find((f) => f.normal.y > 0.99);
    expect(top).toBeDefined();
    expect(top!.centroid.y).toBeCloseTo(10, 4);
  });
});
