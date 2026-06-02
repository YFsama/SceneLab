import { describe, it, expect } from 'vitest';
import { selectionSummary } from './selectionSummary';
import { createBox } from './geometry/brep';
import { translateBody } from './geometry/operations';

describe('selectionSummary', () => {
  it('returns null for an empty selection', () => {
    expect(selectionSummary([])).toBeNull();
  });

  it('aggregates count, combined size and total volume', () => {
    const a = createBox(10, 10, 10); // vol 1000, x ∈ [-5,5]
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25]
    const s = selectionSummary([a, b])!;
    expect(s.count).toBe(2);
    expect(s.size.x).toBeCloseTo(30, 4); // -5 .. 25
    expect(s.size.y).toBeCloseTo(10, 4);
    expect(s.totalVolume).toBeCloseTo(2000, 2);
  });
});
