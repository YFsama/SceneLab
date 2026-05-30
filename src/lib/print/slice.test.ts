import { describe, it, expect } from 'vitest';
import { sliceCrossSection } from './slice';
import { createBox, createCylinder } from '../geometry/brep';

describe('sliceCrossSection', () => {
  it('cuts a box to its constant rectangular section', () => {
    // 10(x) × 20(y) × 10(z), build axis +Y. Mid-cut → 10×10 area, 40mm perimeter.
    const r = sliceCrossSection(createBox(10, 20, 10), 10);
    expect(r.area).toBeCloseTo(100, 4);
    expect(r.perimeter).toBeCloseTo(40, 4);
    expect(r.segments).toBeGreaterThan(0);
  });

  it('cuts a cylinder to ~its circular section', () => {
    // r=5, h=10 along +Y, cut at y=5 → area πr²≈78.5, perimeter 2πr≈31.4.
    const r = sliceCrossSection(createCylinder(5, 10, 64), 5);
    const idealArea = Math.PI * 25;
    const idealPerim = 2 * Math.PI * 5;
    // Faceting makes the polygon slightly smaller than the ideal circle.
    expect(r.area).toBeGreaterThan(idealArea * 0.97);
    expect(r.area).toBeLessThanOrEqual(idealArea + 1e-6);
    expect(r.perimeter).toBeGreaterThan(idealPerim * 0.97);
    expect(r.perimeter).toBeLessThanOrEqual(idealPerim + 1e-6);
  });

  it('returns an empty section above or below the part', () => {
    const box = createBox(10, 20, 10);
    expect(sliceCrossSection(box, 25).area).toBe(0);
    expect(sliceCrossSection(box, 25).segments).toBe(0);
    expect(sliceCrossSection(box, -5).area).toBe(0);
  });

  it('section area is translation invariant', () => {
    const box = createBox(8, 12, 6);
    const at5 = sliceCrossSection(box, 5).area;
    const moved = {
      ...box,
      vertices: box.vertices.map((v) => ({ x: v.x + 50, y: v.y + 100, z: v.z - 7 })),
      faces: box.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => ({ x: v.x + 50, y: v.y + 100, z: v.z - 7 })) })),
    };
    expect(sliceCrossSection(moved, 105).area).toBeCloseTo(at5, 4);
  });
});
