import { describe, it, expect } from 'vitest';
import { snapToPoints, sketchSnapPoints, inferAlignment, inferLineEnd, nearestVertexWithin, angleAtVertex } from './snap';

describe('inferAlignment', () => {
  it('snaps x to a vertically-aligned candidate, leaving y free', () => {
    const r = inferAlignment({ x: 10.1, y: 0 }, [{ x: 10, y: 5 }], 0.3);
    expect(r.point).toEqual({ x: 10, y: 0 });
    expect(r.guideX).toEqual({ x: 10, y: 5 });
    expect(r.guideY).toBeNull();
  });

  it('snaps both axes when candidates align on each', () => {
    const r = inferAlignment({ x: 10.1, y: 4.9 }, [{ x: 10, y: 5 }], 0.3);
    expect(r.point).toEqual({ x: 10, y: 5 });
    expect(r.guideX).toEqual({ x: 10, y: 5 });
    expect(r.guideY).toEqual({ x: 10, y: 5 });
  });

  it('leaves the point unchanged when nothing is within tol', () => {
    const r = inferAlignment({ x: 1, y: 1 }, [{ x: 10, y: 5 }], 0.3);
    expect(r.point).toEqual({ x: 1, y: 1 });
    expect(r.guideX).toBeNull();
    expect(r.guideY).toBeNull();
  });
});

describe('sketchSnapPoints', () => {
  it('always includes the origin first, even with no endpoints', () => {
    expect(sketchSnapPoints([])).toEqual([{ x: 0, y: 0 }]);
  });

  it('appends endpoints after the origin and de-dupes', () => {
    expect(sketchSnapPoints([{ x: 10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('lets a point near the origin snap to (0,0)', () => {
    const snap = snapToPoints({ x: 0.2, y: -0.1 }, sketchSnapPoints([]), 0.4);
    expect(snap.snapped).toBe(true);
    expect(snap.point).toEqual({ x: 0, y: 0 });
  });
});

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

  it('reports snapped for an exact coincidence (snap feedback uses a tiny tol)', () => {
    expect(snapToPoints({ x: 10, y: 0 }, pts, 1e-6).snapped).toBe(true);
    expect(snapToPoints({ x: 9.9, y: 0 }, pts, 1e-6).snapped).toBe(false);
  });

  it('snaps to the closest of multiple candidates', () => {
    const r = snapToPoints({ x: 5.1, y: 5.1 }, [{ x: 10, y: 10 }, { x: 5, y: 5 }], 1);
    expect(r.snapped).toBe(true);
    expect(r.point).toEqual({ x: 5, y: 5 });
  });

  it('does not snap when outside tolerance', () => {
    const r = snapToPoints({ x: 5.5, y: 5.5 }, [{ x: 5, y: 5 }], 0.3);
    expect(r.snapped).toBe(false);
  });

  it('snaps to origin when near (0,0)', () => {
    const r = snapToPoints({ x: 0.1, y: 0.1 }, [{ x: 0, y: 0 }], 0.5);
    expect(r.snapped).toBe(true);
    expect(r.point).toEqual({ x: 0, y: 0 });
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

  it('snaps to the closest of multiple vertices', () => {
    const verts = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 }, { x: 10, y: 10, z: 10 }];
    expect(nearestVertexWithin({ x: 4.9, y: 4.9, z: 4.9 }, verts, 1)).toEqual({ x: 5, y: 5, z: 5 });
  });

  it('returns the vertex when exactly at tolerance boundary', () => {
    // At exactly distance 1 from vertex — the function uses <= for tolerance.
    const verts = [{ x: 0, y: 0, z: 0 }];
    expect(nearestVertexWithin({ x: 1, y: 0, z: 0 }, verts, 1)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('angleAtVertex', () => {
  it('measures a right angle', () => {
    // arms along +X and +Z from the origin → 90°.
    expect(angleAtVertex({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(90, 6);
  });

  it('measures a straight angle', () => {
    expect(angleAtVertex({ x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(180, 6);
  });

  it('returns 0 for a degenerate arm', () => {
    expect(angleAtVertex({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(0);
  });

  it('measures a 45° angle', () => {
    expect(angleAtVertex({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 })).toBeCloseTo(45, 0);
  });

  it('measures a 60° angle', () => {
    expect(angleAtVertex({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0.866 })).toBeCloseTo(60, 0);
  });
});

describe('snapToPoints edge cases', () => {
  it('returns raw point when no candidates', () => {
    const result = snapToPoints({ x: 5, y: 5 }, [], 1);
    expect(result.snapped).toBe(false);
    expect(result.point).toEqual({ x: 5, y: 5 });
  });

  it('snaps to the nearest candidate within tolerance', () => {
    const result = snapToPoints({ x: 5.1, y: 5.1 }, [{ x: 5, y: 5 }], 0.5);
    expect(result.snapped).toBe(true);
    expect(result.point).toEqual({ x: 5, y: 5 });
  });

  it('does not snap when outside tolerance', () => {
    const result = snapToPoints({ x: 5.5, y: 5.5 }, [{ x: 5, y: 5 }], 0.3);
    expect(result.snapped).toBe(false);
  });

  it('snaps to the closest of multiple candidates', () => {
    const result = snapToPoints({ x: 5.1, y: 5.1 }, [{ x: 10, y: 10 }, { x: 5, y: 5 }], 1);
    expect(result.snapped).toBe(true);
    expect(result.point).toEqual({ x: 5, y: 5 });
  });
});

describe('inferLineEnd edge cases', () => {
  const s = { x: 0, y: 0 };

  it('preserves diagonal lines (no constraint)', () => {
    const r = inferLineEnd(s, { x: 10, y: 10 });
    expect(r.constraint).toBeNull();
    expect(r.point).toEqual({ x: 10, y: 10 });
  });

  it('snaps near-vertical lines', () => {
    const r = inferLineEnd(s, { x: 0.3, y: 10 });
    expect(r.constraint).toBe('vertical');
    expect(r.point).toEqual({ x: 0, y: 10 });
  });

  it('handles zero-length line', () => {
    const r = inferLineEnd(s, { x: 0, y: 0 });
    expect(r.point).toEqual({ x: 0, y: 0 });
  });
});
