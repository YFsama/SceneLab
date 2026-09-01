import { describe, it, expect } from 'vitest';
import { createLoftSections } from './brep';
import { computeVolume, computeTopology, findBoundaryLoops } from './brep';

/** Square ring of the given half-size centred at the origin, at height y. */
function square(half: number, y: number): { x: number; y: number; z: number }[] {
  return [
    { x: -half, y, z: -half },
    { x: half, y, z: -half },
    { x: half, y, z: half },
    { x: -half, y, z: half },
  ];
}

describe('createLoftSections', () => {
  it('two identical parallel sections produce a prism', () => {
    const body = createLoftSections([square(5, 0), square(5, 20)]);
    expect(computeVolume(body)).toBeCloseTo(10 * 10 * 20, 0);
  });

  it('two different-sized sections produce a frustum', () => {
    // Frustum volume = h/3 * (A1 + A2 + sqrt(A1*A2)).
    const body = createLoftSections([square(5, 0), square(3, 20)]);
    const a1 = 100, a2 = 36;
    expect(computeVolume(body)).toBeCloseTo((20 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), 0);
  });

  it('three sections skin through the middle section', () => {
    const body = createLoftSections([square(5, 0), square(3, 10), square(5, 20)]);
    expect(computeVolume(body)).toBeGreaterThan(0);
    expect(Number.isFinite(computeVolume(body))).toBe(true);
  });

  it('is watertight (no boundary loops) for two sections', () => {
    const body = createLoftSections([square(5, 0), square(3, 20)]);
    expect(findBoundaryLoops(body).loops.length).toBe(0);
  });

  it('has genus 0 (sphere-like topology)', () => {
    const body = createLoftSections([square(5, 0), square(5, 20)]);
    expect(computeTopology(body).genus).toBe(0);
  });

  it('resamples sections with different vertex counts', () => {
    // A square (4 pts) and a hexagon (6 pts) — resampling must even them out.
    const hex = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return { x: 4 * Math.cos(a), y: 20, z: 4 * Math.sin(a) };
    });
    const body = createLoftSections([square(5, 0), hex]);
    expect(Number.isFinite(computeVolume(body))).toBe(true);
    expect(computeVolume(body)).toBeGreaterThan(0);
  });

  it('throws for fewer than 2 sections or tiny sections', () => {
    expect(() => createLoftSections([square(5, 0)])).toThrow();
    expect(() => createLoftSections([square(5, 0), [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]])).toThrow();
  });
});
