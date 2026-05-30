import { describe, it, expect } from 'vitest';
import { mirrorAcrossAxis, splitAcrossAxis } from './planeOps';
import { createBox, computeVolume, checkManifold, computeBoundingBox } from './brep';

describe('mirrorAcrossAxis', () => {
  // createBox(10,10,10): x,z ∈ [-5,5], y ∈ [0,10], vol 1000.
  const box = createBox(10, 10, 10);

  it('doubles the part along X about its min face, watertight', () => {
    const r = mirrorAcrossAxis(box, 'x', 40)!;
    expect(r).not.toBeNull();
    expect(checkManifold(r).boundaryEdges).toBe(0);
    expect(Math.abs(computeVolume(r))).toBeCloseTo(2000, -2);
    // X-extent doubles from 10 to ~20.
    const bb = computeBoundingBox(r);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 0);
  });
});

describe('splitAcrossAxis', () => {
  const box = createBox(10, 10, 10);

  it('cuts a body into two watertight halves through its centre', () => {
    const halves = splitAcrossAxis(box, 'y', 40);
    expect(halves).toHaveLength(2);
    let total = 0;
    for (const h of halves) {
      expect(checkManifold(h).boundaryEdges).toBe(0);
      total += Math.abs(computeVolume(h));
    }
    expect(total).toBeCloseTo(1000, -2);
  });
});
