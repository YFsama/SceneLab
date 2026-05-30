import { describe, it, expect } from 'vitest';
import { booleanOp, hollowBody, splitByPlane } from './boolean';
import { createBox, checkManifold, computeVolume } from './brep';
import { translateBody } from './operations';
import { makePlane } from './referenceGeometry';

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

describe('hollowBody', () => {
  it('produces a closed shell with less material than the solid', () => {
    const solid = createBox(20, 20, 20); // vol 8000
    const h = hollowBody(solid, 2, 40)!;
    expect(h).not.toBeNull();
    expect(checkManifold(h).boundaryEdges).toBe(0); // watertight
    const v = Math.abs(computeVolume(h));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(8000 * 0.75); // hollowed out (material removed)
  });

  it('throws on non-positive wall thickness', () => {
    expect(() => hollowBody(createBox(10, 10, 10), 0)).toThrow();
  });
});

describe('splitByPlane', () => {
  // createBox(10,10,10): x,z ∈ [-5,5], y ∈ [0,10], vol 1000.
  const box = createBox(10, 10, 10);

  it('a mid-height horizontal plane halves the volume, both sides watertight', () => {
    const plane = makePlane({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    expect(checkManifold(positive!).boundaryEdges).toBe(0);
    expect(checkManifold(negative!).boundaryEdges).toBe(0);
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp).toBeCloseTo(500, -2);
    expect(vn).toBeCloseTo(500, -2);
    // The two halves together conserve the original volume.
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('a plane outside the body leaves one side empty', () => {
    const plane = makePlane({ x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 30);
    expect(positive).toBeNull(); // nothing above y=100
    expect(negative).not.toBeNull(); // whole body below
  });
});
