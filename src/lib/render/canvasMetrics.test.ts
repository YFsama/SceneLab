import { describe, it, expect } from 'vitest';
import { clampedDpr, canvasBackingSize, shouldApplyResize } from './canvasMetrics';

describe('clampedDpr', () => {
  it('passes through ratios up to the 2x cap', () => {
    expect(clampedDpr(1)).toBe(1);
    expect(clampedDpr(1.25)).toBe(1.25);
    expect(clampedDpr(2)).toBe(2);
  });

  it('clamps above 2 (the viewport perf ceiling)', () => {
    expect(clampedDpr(2.5)).toBe(2);
    expect(clampedDpr(4)).toBe(2);
  });

  it('falls back to 1 for unusable values instead of propagating NaN/0', () => {
    expect(clampedDpr(NaN)).toBe(1);
    expect(clampedDpr(Infinity)).toBe(1);
    expect(clampedDpr(-Infinity)).toBe(1);
    expect(clampedDpr(0)).toBe(1);
    expect(clampedDpr(-1)).toBe(1);
  });
});

describe('canvasBackingSize', () => {
  it('multiplies the CSS size by the clamped DPR and floors', () => {
    expect(canvasBackingSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(canvasBackingSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    // Fractional DPRs floor, they never round up past the available pixels.
    expect(canvasBackingSize(333, 222, 1.5)).toEqual({ width: 499, height: 333 });
    expect(canvasBackingSize(100.9, 50.9, 1)).toEqual({ width: 100, height: 50 });
  });

  it('applies the 2x clamp before multiplying', () => {
    expect(canvasBackingSize(500, 400, 3)).toEqual({ width: 1000, height: 800 });
    expect(canvasBackingSize(500, 400, 5)).toEqual({ width: 1000, height: 800 });
  });

  it('never produces a degenerate 0-sized surface (hidden/zero container)', () => {
    expect(canvasBackingSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
    expect(canvasBackingSize(0, 600, 1)).toEqual({ width: 1, height: 600 });
  });

  it('treats NaN client dimensions as 0 rather than NaN', () => {
    expect(canvasBackingSize(NaN, 600, 1)).toEqual({ width: 1, height: 600 });
    expect(canvasBackingSize(800, NaN, 2)).toEqual({ width: 1600, height: 1 });
    // A NaN DPR is clamped to 1 first.
    expect(canvasBackingSize(800, 600, NaN)).toEqual({ width: 800, height: 600 });
  });
});

describe('shouldApplyResize', () => {
  const prev = { w: 800, h: 600, dpr: 1 };

  it('is false only when all three fields are unchanged', () => {
    expect(shouldApplyResize(prev, { w: 800, h: 600, dpr: 1 })).toBe(false);
  });

  it('is true when any single field moves (dpr-only is the cross-monitor case)', () => {
    expect(shouldApplyResize(prev, { w: 900, h: 600, dpr: 1 })).toBe(true);
    expect(shouldApplyResize(prev, { w: 800, h: 640, dpr: 1 })).toBe(true);
    expect(shouldApplyResize(prev, { w: 800, h: 600, dpr: 2 })).toBe(true);
  });

  it('never treats NaN as equal (corrupt reads apply rather than get swallowed)', () => {
    expect(shouldApplyResize(prev, { w: NaN, h: 600, dpr: 1 })).toBe(true);
    expect(shouldApplyResize({ w: NaN, h: 1, dpr: 1 }, { w: NaN, h: 1, dpr: 1 })).toBe(true);
  });
});
