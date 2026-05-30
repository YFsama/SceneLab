import { describe, it, expect } from 'vitest';
import { arrangeOnPlate } from './arrange';
import { createBox, computeBoundingBox } from '../geometry';

function bbox(b: ReturnType<typeof createBox>) {
  return computeBoundingBox(b);
}

function overlapsXZ(a: ReturnType<typeof createBox>, b: ReturnType<typeof createBox>): boolean {
  const A = bbox(a);
  const B = bbox(b);
  const sep = A.max.x <= B.min.x + 1e-6 || B.max.x <= A.min.x + 1e-6 ||
              A.max.z <= B.min.z + 1e-6 || B.max.z <= A.min.z + 1e-6;
  return !sep;
}

describe('arrangeOnPlate', () => {
  it('places four boxes non-overlapping, seated on the bed, within a fitting bed', () => {
    const boxes = [createBox(10, 10, 10), createBox(10, 10, 10), createBox(10, 10, 10), createBox(10, 10, 10)];
    const r = arrangeOnPlate(boxes, 25, 25, 5);
    expect(r.fits).toBe(true);
    // All seated on the bed (min Y ≈ 0).
    for (const b of r.bodies) expect(bbox(b).min.y).toBeCloseTo(0, 6);
    // No two overlap in the XZ plane.
    for (let i = 0; i < r.bodies.length; i++) {
      for (let j = i + 1; j < r.bodies.length; j++) {
        expect(overlapsXZ(r.bodies[i]!, r.bodies[j]!)).toBe(false);
      }
    }
    // Two per row → 2×2 grid within 25×25.
    expect(r.usedX).toBeLessThanOrEqual(25);
    expect(r.usedZ).toBeLessThanOrEqual(25);
  });

  it('packs by decreasing depth so similar-depth items share rows (NFDH)', () => {
    // Two deep (z=20) and two shallow (z=5) boxes, 10 wide, interleaved. Two fit
    // per 25-wide row. Sorted: row1 = both deep (depth 20), row2 = both shallow
    // (depth 5) → usedZ = 20 + spacing(5) + 5 = 30. Arbitrary order would mix a
    // deep box into the second row and waste space.
    const boxes = [
      createBox(10, 10, 5),
      createBox(10, 10, 20),
      createBox(10, 10, 5),
      createBox(10, 10, 20),
    ];
    const r = arrangeOnPlate(boxes, 25, 100, 5);
    expect(r.fits).toBe(true);
    expect(r.usedZ).toBeCloseTo(30, 6);
    // Without sorting the same input wastes more depth.
    const unsorted = arrangeOnPlate(boxes, 25, 100, 5, false);
    expect(unsorted.usedZ).toBeGreaterThan(r.usedZ);
  });

  it('reports fits=false when the bed is too small', () => {
    const boxes = [createBox(20, 10, 20), createBox(20, 10, 20)];
    const r = arrangeOnPlate(boxes, 25, 25, 5); // two 20-wide boxes can't share a 25 bed
    expect(r.fits).toBe(false);
  });
});
