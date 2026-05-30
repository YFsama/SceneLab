import { describe, it, expect } from 'vitest';
import { listFaces, angleBetweenFaces } from './query';
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

describe('angleBetweenFaces', () => {
  const box = createBox(10, 10, 10);
  const faces = listFaces(box);
  const top = faces.find((f) => f.normal.y > 0.99)!;
  const bottom = faces.find((f) => f.normal.y < -0.99)!;
  const side = faces.find((f) => f.normal.x > 0.99)!;

  it('adjacent box faces meet at 90°', () => {
    expect(angleBetweenFaces(box, top.id, side.id)).toBeCloseTo(90, 6);
  });

  it('opposite box faces read 180°', () => {
    expect(angleBetweenFaces(box, top.id, bottom.id)).toBeCloseTo(180, 6);
  });

  it('a face against itself reads 0°', () => {
    expect(angleBetweenFaces(box, top.id, top.id)).toBeCloseTo(0, 6);
  });

  it('returns null for an unknown face id', () => {
    expect(angleBetweenFaces(box, top.id, 'nope')).toBeNull();
  });
});
