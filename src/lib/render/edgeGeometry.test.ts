import { describe, it, expect } from 'vitest';
import { buildEdgePositions } from './edgeGeometry';
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
