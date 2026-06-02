import { describe, it, expect } from 'vitest';
import { buildEdgePositions, edgeMidpoints, faceCenters } from './edgeGeometry';
import { createBox } from '../geometry/brep';

describe('buildEdgePositions', () => {
  it('emits 6 numbers (two xyz endpoints) per edge', () => {
    const box = createBox(10, 10, 10);
    const pos = buildEdgePositions(box);
    expect(pos).toHaveLength(box.edges.length * 6);
    expect(box.edges.length).toBeGreaterThan(0);
  });

  it('matches the first edge endpoints', () => {
    const box = createBox(2, 2, 2);
    const e = box.edges[0]!;
    const pos = buildEdgePositions(box);
    expect(pos.slice(0, 6)).toEqual([e.start.x, e.start.y, e.start.z, e.end.x, e.end.y, e.end.z]);
  });
});

describe('edgeMidpoints', () => {
  it('returns one midpoint per edge, at the segment centre', () => {
    const box = createBox(2, 2, 2);
    const mids = edgeMidpoints(box);
    expect(mids).toHaveLength(box.edges.length);
    const e = box.edges[0]!;
    expect(mids[0]).toEqual({ x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2, z: (e.start.z + e.end.z) / 2 });
  });
});

describe('faceCenters', () => {
  it('returns a centroid per face, on the face plane', () => {
    const box = createBox(10, 10, 10); // 6 faces, the +Y face centre at y=10
    const centers = faceCenters(box);
    expect(centers).toHaveLength(box.faces.length);
    const top = box.faces.find((f) => f.normal.y > 0.99)!;
    const idx = box.faces.indexOf(top);
    expect(centers[idx]!.y).toBeCloseTo(10, 4);
  });
});
