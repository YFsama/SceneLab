import { describe, it, expect } from 'vitest';
import { createBox, createCylinder, createSphere, createTorus, createWedge, findBoundaryLoops } from './brep';
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

  it('a watertight cylinder has no holes', () => {
    const cyl = createCylinder(5, 10, 16);
    const r = findBoundaryLoops(cyl);
    expect(r.holeCount).toBe(0);
    expect(r.boundaryEdgeCount).toBe(0);
  });

  it('a watertight sphere has no holes', () => {
    const sphere = createSphere(7, 16);
    const r = findBoundaryLoops(sphere);
    expect(r.holeCount).toBe(0);
    expect(r.boundaryEdgeCount).toBe(0);
  });

  it('returns empty loops array for a watertight body', () => {
    const r = findBoundaryLoops(createBox(10, 10, 10));
    expect(r.loops).toEqual([]);
  });

  it('a watertight torus has no holes', () => {
    const torus = createTorus(10, 3, 16, 8);
    const r = findBoundaryLoops(torus);
    expect(r.holeCount).toBe(0);
    expect(r.boundaryEdgeCount).toBe(0);
  });

  it('a watertight wedge has no holes', () => {
    const wedge = createWedge(10, 6, 4);
    const r = findBoundaryLoops(wedge);
    expect(r.holeCount).toBe(0);
    expect(r.boundaryEdgeCount).toBe(0);
  });

  it('removing one face from a cylinder creates a hole', () => {
    const cyl = createCylinder(5, 10, 16);
    const open: SolidBody = { ...cyl, faces: cyl.faces.slice(1) };
    const r = findBoundaryLoops(open);
    expect(r.holeCount).toBeGreaterThan(0);
  });

  it('hole edge count is always even (each edge shared by two faces)', () => {
    const box = createBox(10, 10, 10);
    const open: SolidBody = { ...box, faces: box.faces.slice(1) };
    const r = findBoundaryLoops(open);
    expect(r.boundaryEdgeCount % 2).toBe(0);
  });
});
