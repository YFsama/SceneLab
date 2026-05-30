import { describe, it, expect } from 'vitest';
import { analyzeStability } from './stability';
import { createBox } from '../geometry';
import type { SolidBody } from '../geometry/types';

describe('analyzeStability', () => {
  it('a centered box is stable with a positive margin', () => {
    const box = createBox(20, 10, 20); // 20×20 base, 10 tall (Y up)
    const r = analyzeStability(box);
    expect(r.comInsideBase).toBe(true);
    expect(r.stable).toBe(true);
    expect(r.footprintArea).toBeCloseTo(400, 0);
    // CoM at the center projects ~10mm from each base edge.
    expect(r.marginMm).toBeGreaterThan(5);
    expect(r.centerOfMass.y).toBeCloseTo(5, 5);
    // CoM 5mm up, 10mm margin → tips at atan(10/5) = atan(2) ≈ 63.43°.
    expect(r.comHeightMm).toBeCloseTo(5, 5);
    expect(r.tippingAngleDeg).toBeCloseTo((Math.atan2(10, 5) * 180) / Math.PI, 1);
  });

  it('a tall narrow box tips at a smaller angle than a short wide one', () => {
    const tall = analyzeStability(createBox(10, 40, 10)); // narrow base, tall
    const wide = analyzeStability(createBox(40, 10, 40)); // wide base, short
    expect(tall.tippingAngleDeg).toBeLessThan(wide.tippingAngleDeg);
    // A cube tips at exactly 45° (margin == CoM height).
    const cube = analyzeStability(createBox(20, 20, 20));
    expect(cube.tippingAngleDeg).toBeCloseTo(45, 4);
  });

  it('a top-heavy, off-center mass is unstable', () => {
    // Small base square at y=0, but most vertices clustered far out at y=10,
    // dragging the centroid well beyond the footprint.
    const body: SolidBody = {
      id: 'tippy',
      name: 'tippy',
      vertices: [
        { x: -1, y: 0, z: -1 },
        { x: 1, y: 0, z: -1 },
        { x: 1, y: 0, z: 1 },
        { x: -1, y: 0, z: 1 },
        ...Array.from({ length: 6 }, () => ({ x: 50, y: 10, z: 0 })),
      ],
      faces: [],
      edges: [],
    };
    const r = analyzeStability(body);
    expect(r.comInsideBase).toBe(false);
    expect(r.stable).toBe(false);
    expect(r.marginMm).toBeLessThan(0); // CoM projects outside the base
  });

  it('returns an empty report for an empty body', () => {
    const body: SolidBody = { id: 'e', name: 'e', vertices: [], faces: [], edges: [] };
    const r = analyzeStability(body);
    expect(r.stable).toBe(false);
    expect(r.footprintArea).toBe(0);
  });

  it('a degenerate (line) base is not stable', () => {
    const body: SolidBody = {
      id: 'line',
      name: 'line',
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 5, y: 8, z: 0 },
      ],
      faces: [],
      edges: [],
    };
    const r = analyzeStability(body);
    expect(r.comInsideBase).toBe(false);
  });
});
