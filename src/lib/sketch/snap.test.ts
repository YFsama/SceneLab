import { describe, it, expect } from 'vitest';
import { snapToPoints, inferLineEnd, nearestVertexWithin } from './snap';

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

describe('inferLineEnd', () => {
  const s = { x: 0, y: 0 };

  it('snaps a near-horizontal line to exactly horizontal', () => {
    const r = inferLineEnd(s, { x: 10, y: 0.3 }); // ~1.7°
    expect(r.constraint).toBe('horizontal');
    expect(r.point).toEqual({ x: 10, y: 0 });
  });

  it('snaps a near-vertical line to exactly vertical', () => {
    const r = inferLineEnd(s, { x: 0.2, y: 10 });
    expect(r.constraint).toBe('vertical');
    expect(r.point).toEqual({ x: 0, y: 10 });
  });

  it('leaves a clearly diagonal line unchanged', () => {
    const r = inferLineEnd(s, { x: 10, y: 10 }); // 45°
    expect(r.constraint).toBeNull();
    expect(r.point).toEqual({ x: 10, y: 10 });
  });

  it('handles a zero-length segment', () => {
    expect(inferLineEnd(s, { x: 0, y: 0 }).constraint).toBeNull();
  });
});

describe('nearestVertexWithin', () => {
  const verts = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }];

  it('snaps to the nearest vertex within tolerance', () => {
    expect(nearestVertexWithin({ x: 9.5, y: 0.2, z: 0.1 }, verts, 1)).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('returns null when nothing is within tolerance', () => {
    expect(nearestVertexWithin({ x: 5, y: 5, z: 5 }, verts, 1)).toBeNull();
  });

  it('returns null with no vertices', () => {
    expect(nearestVertexWithin({ x: 0, y: 0, z: 0 }, [], 1)).toBeNull();
  });
});
