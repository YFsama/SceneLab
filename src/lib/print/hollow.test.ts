import { describe, it, expect } from 'vitest';
import { estimateHollowSavings } from './hollow';
import { createBox } from '../geometry';

describe('estimateHollowSavings', () => {
  it('reports the shell volume and savings for a cube', () => {
    // 20mm cube: solid 8000, surface 2400 → shell(1.2) = 2400·1.2 = 2880.
    const r = estimateHollowSavings(createBox(20, 20, 20), 1.2);
    expect(r.solidVolumeMm3).toBeCloseTo(8000, 0);
    expect(r.shellVolumeMm3).toBeCloseTo(2880, 0);
    expect(r.savedVolumeMm3).toBeCloseTo(5120, 0);
    expect(r.savedPercent).toBeCloseTo(64, 0);
  });

  it('saves nothing when the wall is thicker than the part', () => {
    const r = estimateHollowSavings(createBox(2, 2, 2), 100);
    expect(r.savedVolumeMm3).toBe(0);
    expect(r.savedPercent).toBe(0);
  });
});
