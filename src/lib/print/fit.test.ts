import { describe, it, expect } from 'vitest';
import { computeFitScale, scaleToFit } from './fit';
import { createBox } from '../geometry';
import { computeBoundingBox } from '../geometry';

describe('computeFitScale', () => {
  it('reports a shrink factor for an oversized part', () => {
    const big = createBox(300, 300, 300);
    const res = computeFitScale(big, { x: 200, y: 200, z: 200 });
    expect(res.fits).toBe(false);
    expect(res.factor).toBeCloseTo(200 / 300, 5);
  });

  it('reports fits=true with headroom for a small part', () => {
    const small = createBox(100, 100, 100);
    const res = computeFitScale(small, { x: 200, y: 200, z: 200 });
    expect(res.fits).toBe(true);
    expect(res.factor).toBeCloseTo(2, 5);
  });

  it('accounts for a margin', () => {
    const part = createBox(180, 100, 100);
    const res = computeFitScale(part, { x: 200, y: 200, z: 200 }, 20);
    // available X = 200 - 40 = 160 < 180 → must shrink
    expect(res.fits).toBe(false);
    expect(res.factor).toBeCloseTo(160 / 180, 5);
  });
});

describe('scaleToFit', () => {
  it('shrinks an oversized part to fit', () => {
    const big = createBox(300, 300, 300);
    const fitted = scaleToFit(big, { x: 200, y: 200, z: 200 });
    const bb = computeBoundingBox(fitted);
    expect(bb.max.x - bb.min.x).toBeLessThanOrEqual(200 + 1e-6);
    expect(bb.max.y - bb.min.y).toBeCloseTo(200, 3);
  });

  it('leaves a fitting part unchanged', () => {
    const small = createBox(50, 50, 50);
    const fitted = scaleToFit(small, { x: 200, y: 200, z: 200 });
    expect(fitted).toBe(small); // same reference, not rescaled
  });
});
