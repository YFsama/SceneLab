import { describe, it, expect } from 'vitest';
import { exportOBJ, importOBJ } from './obj';
import { createBox, createCylinder, createSphere, computeVolume, findBoundaryLoops } from '../geometry/brep';

describe('exportOBJ', () => {
  it('emits v and polygon f lines', () => {
    const obj = exportOBJ(createBox(10, 10, 10));
    expect(obj).toContain('v ');
    expect(obj).toMatch(/^f \d+ \d+ \d+ \d+$/m); // quad faces preserved
  });
});

describe('importOBJ', () => {
  it('round-trips a box, preserving quads and volume', () => {
    const box = createBox(10, 10, 10);
    const imported = importOBJ(exportOBJ(box));
    expect(imported.vertices).toHaveLength(8);
    expect(imported.faces).toHaveLength(6); // quads, not triangulated
    expect(Math.abs(computeVolume(imported))).toBeCloseTo(1000, 3);
  });

  it('round-trips to a watertight mesh (shared vertices)', () => {
    const imported = importOBJ(exportOBJ(createBox(10, 10, 10)));
    expect(findBoundaryLoops(imported).holeCount).toBe(0);
  });

  it('parses faces with v/vt/vn tokens and the object name', () => {
    const obj = [
      'o widget',
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'f 1/1/1 2/2/1 3/3/1',
    ].join('\n');
    const body = importOBJ(obj);
    expect(body.name).toBe('widget');
    expect(body.vertices).toHaveLength(3);
    expect(body.faces).toHaveLength(1);
  });

  it('round-trips a cylinder', () => {
    const cyl = createCylinder(5, 10, 16);
    const imported = importOBJ(exportOBJ(cyl));
    expect(imported.vertices.length).toBeGreaterThan(0);
    expect(imported.faces.length).toBeGreaterThan(0);
  });

  it('round-trips a sphere', () => {
    const sphere = createSphere(5, 16);
    const imported = importOBJ(exportOBJ(sphere));
    expect(imported.vertices.length).toBeGreaterThan(0);
    expect(imported.faces.length).toBeGreaterThan(0);
  });

  it('preserves face count for a box', () => {
    const box = createBox(10, 10, 10);
    const obj = exportOBJ(box);
    const imported = importOBJ(obj);
    expect(imported.faces.length).toBe(box.faces.length);
  });

  it('handles empty face lines gracefully', () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
    const body = importOBJ(obj);
    expect(body.vertices).toHaveLength(3);
    expect(body.faces).toHaveLength(0);
  });
});
