import { describe, it, expect } from 'vitest';
import { createBox, findBoundaryLoops } from './brep';
import type { SolidBody } from './types';

describe('findBoundaryLoops', () => {
  it('a watertight box has no holes', () => {
    const r = findBoundaryLoops(createBox(10, 10, 10));
    expect(r.holeCount).toBe(0);
    expect(r.boundaryEdgeCount).toBe(0);
  });

  it('an open box (one face removed) has a single 4-edge hole', () => {
    const box = createBox(10, 10, 10);
    const open: SolidBody = { ...box, faces: box.faces.slice(1) };
    const r = findBoundaryLoops(open);
    expect(r.holeCount).toBe(1);
    expect(r.boundaryEdgeCount).toBe(4);
    expect(r.loops[0]).toHaveLength(4);
  });

  it('removing both Y caps gives two separate holes', () => {
    const box = createBox(10, 10, 10);
    // Extrude order is [bottom, top, ...sides]; drop both caps → two loops.
    const open: SolidBody = { ...box, faces: box.faces.slice(2) };
    const r = findBoundaryLoops(open);
    expect(r.holeCount).toBe(2);
    expect(r.boundaryEdgeCount).toBe(8);
  });
});
