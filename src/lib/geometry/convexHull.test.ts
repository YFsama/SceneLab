import { describe, it, expect } from 'vitest';
import { computeConvexHull, convexHull2D } from './convexHull';
import { createBox, createSphere } from './brep';

describe('convexHull2D', () => {
  it('drops interior points and keeps the outer corners', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
      { x: 2, y: 2 }, // interior
      { x: 2, y: 0 }, // edge-collinear
    ];
    const hull = convexHull2D(pts);
    expect(hull).toHaveLength(4); // the 4 corners only
  });

  it('returns fewer-than-3 point sets unchanged', () => {
    expect(convexHull2D([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(2);
  });
});

describe('computeConvexHull', () => {
  it('hulls a box to itself (8 verts, 12 tris, full volume)', () => {
    const h = computeConvexHull(createBox(10, 10, 10).vertices)!;
    expect(h).not.toBeNull();
    expect(h.vertices).toHaveLength(8);
    expect(h.faces).toHaveLength(12);
    expect(h.volume).toBeCloseTo(1000, 3);
  });

  it('excludes interior points', () => {
    const cloud = [...createBox(10, 10, 10).vertices, { x: 0, y: 5, z: 0 }, { x: 1, y: 4, z: -1 }];
    const h = computeConvexHull(cloud)!;
    expect(h.vertices).toHaveLength(8); // only the 8 corners
    expect(h.volume).toBeCloseTo(1000, 3);
  });

  it('a tessellated sphere hull approaches the sphere volume from below', () => {
    const h = computeConvexHull(createSphere(6, 24).vertices)!;
    const ideal = (4 / 3) * Math.PI * 6 ** 3;
    expect(h.volume).toBeGreaterThan(ideal * 0.9);
    expect(h.volume).toBeLessThanOrEqual(ideal + 1e-6); // inscribed polyhedron ≤ sphere
  });

  it('returns null for degenerate (coplanar / too few) inputs', () => {
    expect(computeConvexHull([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }])).toBeNull();
    const coplanar = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }];
    expect(computeConvexHull(coplanar)).toBeNull();
  });
});
