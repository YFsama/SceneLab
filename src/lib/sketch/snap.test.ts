import { describe, it, expect } from 'vitest';
import { snapToPoints } from './snap';

describe('snapToPoints', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

  it('snaps to a candidate within tolerance', () => {
    const r = snapToPoints({ x: 9.8, y: 0.1 }, pts, 0.5);
    expect(r.snapped).toBe(true);
    expect(r.point).toEqual({ x: 10, y: 0 });
  });

  it('leaves the point unchanged when nothing is within tolerance', () => {
    const r = snapToPoints({ x: 5, y: 5 }, pts, 0.5);
    expect(r.snapped).toBe(false);
    expect(r.point).toEqual({ x: 5, y: 5 });
  });

  it('chooses the nearest candidate', () => {
    const r = snapToPoints({ x: 0.3, y: 0.0 }, [{ x: 0, y: 0 }, { x: 0.5, y: 0 }], 1);
    expect(r.point).toEqual({ x: 0.5, y: 0 }); // 0.2 away vs 0.3
  });

  it('returns the point unchanged with no candidates', () => {
    expect(snapToPoints({ x: 2, y: 3 }, [], 0.5)).toEqual({ point: { x: 2, y: 3 }, snapped: false });
  });
});
