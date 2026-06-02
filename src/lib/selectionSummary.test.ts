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

  it('reports the gap between exactly two bodies', () => {
    const a = createBox(10, 10, 10); // x ∈ [-5,5]
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25] → gap 10
    const s = selectionSummary([a, b])!;
    expect(s.gap).toBeCloseTo(10, 3);
  });

  it('omits the gap for one or three bodies', () => {
    const a = createBox(10, 10, 10);
    expect(selectionSummary([a])!.gap).toBeUndefined();
  });

  it('reports interference volume for two overlapping bodies', () => {
    const a = createBox(10, 10, 10); // x ∈ [-5,5]
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }); // overlaps x ∈ [0,5]
    const s = selectionSummary([a, b])!;
    expect(s.interference).toBeGreaterThan(0);
  });

  it('no interference for disjoint bodies', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 50, y: 0, z: 0 });
    expect(selectionSummary([a, b])!.interference).toBeUndefined();
  });
});
