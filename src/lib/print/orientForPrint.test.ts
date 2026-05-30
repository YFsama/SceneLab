import { describe, it, expect } from 'vitest';
import { orientForPrint } from './orientForPrint';
import { recommendOrientation } from './orientation';
import { createBox, computeBoundingBox, computeVolume } from '../geometry';

describe('orientForPrint', () => {
  it('rotates a box so its shortest axis becomes the build height', () => {
    // Tallest along Y (20); best orientation lies along a 10-tall axis.
    const box = createBox(10, 20, 10);
    const result = orientForPrint(box);
    expect(result.rotated).toBe(true);

    // After orienting, the build height (Y extent) should be the minimal 10.
    const bb = computeBoundingBox(result.body);
    expect(bb.max.y - bb.min.y).toBeCloseTo(10, 3);

    // Volume is preserved by a rigid rotation.
    expect(Math.abs(computeVolume(result.body))).toBeCloseTo(Math.abs(computeVolume(box)), 2);
  });

  it('leaves a body unchanged when +Y is already best', () => {
    // Shortest axis is Y (height 5) → best orientation is already +Y.
    const flat = createBox(40, 5, 40);
    const best = recommendOrientation(flat).best;
    expect(best.label).toBe('+Y');
    const result = orientForPrint(flat);
    expect(result.rotated).toBe(false);
    expect(result.body).toBe(flat);
  });

  it('the oriented body needs no more support than the original best', () => {
    const box = createBox(10, 20, 10);
    const result = orientForPrint(box);
    // Re-evaluating the rotated body, +Y should now be (among) the best.
    const reoriented = recommendOrientation(result.body).best;
    expect(reoriented.supportArea).toBe(0);
  });
});
