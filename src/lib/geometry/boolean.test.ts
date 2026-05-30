import { describe, it, expect } from 'vitest';
import { booleanOp } from './boolean';
import { createBox, checkManifold, computeVolume } from './brep';
import { translateBody } from './operations';

describe('booleanOp', () => {
  const a = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10], vol 1000
  const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }); // overlap x∈[0,5] → 500

  const vol = (op: 'union' | 'difference' | 'intersect') => Math.abs(computeVolume(booleanOp(a, b, op, 30)!));

  it('union ≈ A + B − overlap, watertight', () => {
    const r = booleanOp(a, b, 'union', 30)!;
    expect(checkManifold(r).boundaryEdges).toBe(0); // closed
    expect(Math.abs(computeVolume(r))).toBeCloseTo(1500, -2); // 1000+1000-500
  });

  it('intersect ≈ the overlap volume', () => {
    expect(vol('intersect')).toBeGreaterThan(450);
    expect(vol('intersect')).toBeLessThan(550);
  });

  it('difference A−B ≈ A minus the overlap', () => {
    expect(vol('difference')).toBeGreaterThan(450);
    expect(vol('difference')).toBeLessThan(550);
  });

  it('intersect of disjoint bodies is null', () => {
    const far = translateBody(createBox(10, 10, 10), { x: 40, y: 0, z: 0 });
    expect(booleanOp(a, far, 'intersect', 16)).toBeNull();
  });
});
