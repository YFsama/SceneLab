import { describe, it, expect } from 'vitest';
import { booleanOp, hollowBody, splitByPlane, mirrorMerge } from './boolean';
import { createBox, createCylinder, checkManifold, computeVolume } from './brep';
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

describe('mirrorMerge', () => {
  // createBox(10,10,10): x ∈ [-5,5], y ∈ [0,10], z ∈ [-5,5], vol 1000.
  const box = createBox(10, 10, 10);

  it('fuses a body with its reflection into one symmetric watertight solid', () => {
    // Mirror across x = 5: the copy fills x ∈ [5,15]; union ≈ a 20×10×10 box.
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 40)!;
    expect(merged).not.toBeNull();
    expect(checkManifold(merged).boundaryEdges).toBe(0); // closed, single seamless body
    expect(Math.abs(computeVolume(merged))).toBeCloseTo(2000, -2);
  });

  it('is symmetric about the mirror plane (bounding box centred on it)', () => {
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const v of merged.vertices) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); }
    expect((minX + maxX) / 2).toBeCloseTo(5, 1);
  });
});

describe('booleanOp with different body types', () => {
  it('unions two cylinders', () => {
    const a = createCylinder(5, 10, 16);
    const b = translateBody(createCylinder(5, 10, 16), { x: 8, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30);
    expect(r).not.toBeNull();
    expect(Math.abs(computeVolume(r!))).toBeGreaterThan(0);
  });

  it('intersects two overlapping cylinders', () => {
    const a = createCylinder(5, 10, 16);
    const b = translateBody(createCylinder(5, 10, 16), { x: 3, y: 0, z: 0 });
    const r = booleanOp(a, b, 'intersect', 30);
    expect(r).not.toBeNull();
    expect(Math.abs(computeVolume(r!))).toBeGreaterThan(0);
  });

  it('differences a box minus a cylinder', () => {
    const box = createBox(20, 20, 20);
    const cyl = createCylinder(5, 20, 16);
    const r = booleanOp(box, cyl, 'difference', 30);
    expect(r).not.toBeNull();
    // Volume should be less than the box alone.
    expect(Math.abs(computeVolume(r!))).toBeLessThan(Math.abs(computeVolume(box)));
  });

  it('union with disjoint bodies returns non-null', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 100, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30);
    expect(r).not.toBeNull();
  });

  it('union preserves total volume for disjoint bodies', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 100, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30)!;
    const volA = Math.abs(computeVolume(a));
    const volB = Math.abs(computeVolume(b));
    const volR = Math.abs(computeVolume(r));
    // Voxel approximation has some error, so allow 20% tolerance.
    expect(volR).toBeGreaterThan((volA + volB) * 0.8);
    expect(volR).toBeLessThan((volA + volB) * 1.2);
  });

  it('difference removes volume', () => {
    const a = createBox(20, 20, 20);
    const b = createBox(10, 10, 10);
    const r = booleanOp(a, b, 'difference', 30)!;
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(a)));
  });

  it('intersect volume is less than either input', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 3, y: 0, z: 0 });
    const r = booleanOp(a, b, 'intersect', 30)!;
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(a)));
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(b)));
  });
});

describe('splitByPlane edge cases', () => {
  const box = createBox(10, 10, 10);

  it('splits along X axis', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('splits along Z axis', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('diagonal plane produces two halves', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
  });

  it('both halves are watertight', () => {
    const plane = makePlane({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(checkManifold(positive!).boundaryEdges).toBe(0);
    expect(checkManifold(negative!).boundaryEdges).toBe(0);
  });
});

describe('hollowBody edge cases', () => {
  it('hollow body has less volume than solid', () => {
    const box = createBox(20, 20, 20);
    const hollow = hollowBody(box, 2, 40)!;
    expect(hollow).not.toBeNull();
    expect(Math.abs(computeVolume(hollow))).toBeLessThan(Math.abs(computeVolume(box)));
  });

  it('hollow body has positive volume', () => {
    const box = createBox(20, 20, 20);
    const hollow = hollowBody(box, 2, 40)!;
    expect(hollow).not.toBeNull();
    expect(Math.abs(computeVolume(hollow))).toBeGreaterThan(0);
  });

  it('throws on non-positive wall thickness', () => {
    const box = createBox(20, 20, 20);
    expect(() => hollowBody(box, 0, 40)).toThrow('positive');
    expect(() => hollowBody(box, -1, 40)).toThrow('positive');
  });

  it('thicker wall produces different volume than thinner wall', () => {
    const box = createBox(20, 20, 20);
    const thin = hollowBody(box, 1, 40)!;
    const thick = hollowBody(box, 4, 40)!;
    // Both should have positive volume.
    expect(Math.abs(computeVolume(thin))).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(thick))).toBeGreaterThan(0);
    // They should be different.
    expect(Math.abs(computeVolume(thick))).not.toBeCloseTo(Math.abs(computeVolume(thin)), 0);
  });
});

describe('mirrorMerge edge cases', () => {
  it('mirror merge doubles the volume', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    const volOrig = Math.abs(computeVolume(box));
    const volMerged = Math.abs(computeVolume(merged));
    // Mirror merge should approximately double the volume.
    expect(volMerged).toBeGreaterThan(volOrig * 1.5);
  });

  it('mirror merge produces watertight result', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(checkManifold(merged).boundaryEdges).toBe(0);
  });

  it('mirror merge across Y axis', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 0, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(Math.abs(computeVolume(merged))).toBeGreaterThan(0);
  });
});

describe('hollowBody wall thickness edge cases', () => {
  it('thicker wall produces different volume', () => {
    const box = createBox(20, 20, 20);
    const thin = hollowBody(box, 1, 40)!;
    const thick = hollowBody(box, 4, 40)!;
    expect(Math.abs(computeVolume(thin))).not.toBeCloseTo(Math.abs(computeVolume(thick)), 0);
  });

  it('wall thickness of 1mm works', () => {
    const box = createBox(20, 20, 20);
    const h = hollowBody(box, 1, 40)!;
    expect(h).not.toBeNull();
    expect(Math.abs(computeVolume(h))).toBeGreaterThan(0);
  });

  it('wall thickness close to half dimension still produces valid result', () => {
    const box = createBox(20, 20, 20);
    // Wall thickness = 9mm (almost fills the 10mm half-dimension).
    const h = hollowBody(box, 9, 40);
    // May return null if wall consumes the entire part.
    if (h) {
      expect(Math.abs(computeVolume(h))).toBeGreaterThan(0);
    }
  });
});
