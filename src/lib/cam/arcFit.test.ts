import { describe, it, expect } from 'vitest';
import { fitArcs } from './arcFit';
import type { ArcSpec } from './arcFit';
import type { ToolpathPoint } from './types';

type FitItem = ToolpathPoint | ArcSpec;

const isArc = (item: FitItem): item is ArcSpec => 'center' in item;
const isPoint = (item: FitItem): item is ToolpathPoint => !isArc(item);

const TOL = 0.01;
const MAX_SWEEP = (120 * Math.PI) / 180;

/** Closed circle loop of n segments (CCW in the (x, z) plane), constant y. */
function circleLoop(n: number, r: number, y = 5, startDeg = 0): ToolpathPoint[] {
  const pts: ToolpathPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    pts.push({ x: r * Math.cos(a), y, z: r * Math.sin(a), rapid: false });
  }
  return pts;
}

/** Index of a point BY REFERENCE — fitArcs must hand back the original objects. */
function refIndex(pts: ToolpathPoint[], p: ToolpathPoint): number {
  const idx = pts.indexOf(p);
  expect(idx, 'arc endpoint must reference an original point object').toBeGreaterThanOrEqual(0);
  return idx;
}

/**
 * Structural coverage walk: the item sequence must reproduce the polyline
 * exactly — singles advance one point, an arc starts ON the current point
 * and lands on a later one, and the walk ends on the last point. Every
 * original move is replaced or kept, none lost, none duplicated.
 */
function assertCoversPolyline(pts: ToolpathPoint[], items: FitItem[]): void {
  expect(items[0], 'the run entry point is always emitted as a single').toBe(pts[0]);
  let cur = 0;
  for (const item of items.slice(1)) {
    if (isPoint(item)) {
      expect(pts.indexOf(item)).toBe(cur + 1);
      cur += 1;
    } else {
      expect(pts.indexOf(item.start)).toBe(cur);
      const e = refIndex(pts, item.end);
      expect(e).toBeGreaterThan(cur + 1); // an arc spans ≥ 2 moves
      cur = e;
    }
  }
  expect(cur).toBe(pts.length - 1);
}

/**
 * Truth assertion for one fitted arc: every ORIGINAL point of the spanned
 * range stays within tolerance radially, and the sagitta + offset bound holds
 * for every original segment (the arc never leaves the tolerance envelope).
 */
function assertArcWithinTolerance(pts: ToolpathPoint[], arc: ArcSpec, tolerance: number): void {
  const s = refIndex(pts, arc.start);
  const e = refIndex(pts, arc.end);
  expect(e, 'arc must advance along the polyline').toBeGreaterThan(s);
  for (let k = s; k <= e; k++) {
    const p = pts[k]!;
    expect(Math.abs(Math.hypot(p.x - arc.center.x, p.z - arc.center.z) - arc.radius)).toBeLessThanOrEqual(
      tolerance + 1e-12,
    );
  }
  for (let k = s; k < e; k++) {
    const p = pts[k]!;
    const q = pts[k + 1]!;
    const dP = Math.abs(Math.hypot(p.x - arc.center.x, p.z - arc.center.z) - arc.radius);
    const dQ = Math.abs(Math.hypot(q.x - arc.center.x, q.z - arc.center.z) - arc.radius);
    const aP = Math.atan2(p.z - arc.center.z, p.x - arc.center.x);
    const aQ = Math.atan2(q.z - arc.center.z, q.x - arc.center.x);
    let d = Math.abs(aQ - aP);
    if (d > Math.PI) d = 2 * Math.PI - d;
    const sagitta = arc.radius * (1 - Math.cos(d / 2));
    expect(Math.max(dP, dQ) + sagitta).toBeLessThanOrEqual(tolerance + 1e-9);
  }
}

describe('fitArcs — circles', () => {
  it('fits a fine 96-gon loop into arcs that reconstruct the true circle', () => {
    // 96 segments keep the chord sagitta R·(1 − cos(1.875°)) ≈ 5.4 µm inside
    // the 0.01 mm tolerance; a 64-gon (12 µm) is correctly left as polyline.
    const pts = circleLoop(96, 10);
    const items = fitArcs(pts, TOL);
    const arcs = items.filter(isArc);
    expect(arcs.length).toBeGreaterThanOrEqual(3);

    // The move INTO the first point stays linear; single items are originals.
    expect(items[0]).toBe(pts[0]);
    for (const item of items) {
      if (isPoint(item)) expect(pts.indexOf(item)).toBeGreaterThanOrEqual(0);
    }

    let totalSweep = 0;
    for (const arc of arcs) {
      assertArcWithinTolerance(pts, arc, TOL);
      // Center/radius reconstruct the generating circle at the layer height.
      expect(arc.radius).toBeCloseTo(10, 6);
      expect(Math.hypot(arc.center.x, arc.center.z)).toBeLessThan(1e-6);
      expect(arc.center.y).toBeCloseTo(5, 9);
      // CCW input loop ⇒ G3-style arcs, sweep capped at 120°.
      expect(arc.ccw).toBe(true);
      expect(arc.sweep).toBeLessThanOrEqual(MAX_SWEEP + 1e-9);
      totalSweep += arc.sweep;
    }
    // The arcs partition the whole closed loop: every move is kept or
    // replaced, none lost (sweep sum ≥ 92 of the 96 segments' worth).
    assertCoversPolyline(pts, items);
    expect(totalSweep).toBeGreaterThan(2 * Math.PI - 4 * ((2 * Math.PI) / 96));
  });

  it('splits spans wider than the 120° cap into multiple arcs', () => {
    const pts = Array.from({ length: 27 }, (_, k) => {
      const a = ((130 * k) / 26) * (Math.PI / 180);
      return { x: 10 * Math.cos(a), y: 5, z: 10 * Math.sin(a), rapid: false } as ToolpathPoint;
    });
    const arcs = fitArcs(pts, TOL).filter(isArc);
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    let totalSweep = 0;
    for (const arc of arcs) {
      assertArcWithinTolerance(pts, arc, TOL);
      expect(arc.sweep).toBeLessThanOrEqual(MAX_SWEEP + 1e-6);
      totalSweep += arc.sweep;
    }
    // Full coverage of the 130° span — no move lost between arcs.
    assertCoversPolyline(pts, fitArcs(pts, TOL));
    expect(totalSweep).toBeCloseTo((130 * Math.PI) / 180, 6);
  });

  it('never fits a rectangle: concyclic corners do not make straight edges arcs', () => {
    const pts: ToolpathPoint[] = [
      { x: 0, y: 5, z: 0, rapid: false },
      { x: 28, y: 5, z: 0, rapid: false },
      { x: 28, y: 5, z: 36, rapid: false },
      { x: 0, y: 5, z: 36, rapid: false },
      { x: 0, y: 5, z: 0, rapid: false },
    ];
    // All four corners lie on one circle (deviation 0), but the edges bow
    // R·(1 − cos 45°) ≈ 6.7 mm off it — the sagitta guard must reject.
    expect(fitArcs(pts, TOL).every(isPoint)).toBe(true);
  });

  it('respects the tolerance: a dented circle is not fitted across the dent', () => {
    const pts = circleLoop(96, 10);
    const dent = 32;
    pts[dent] = { x: pts[dent]!.x * 0.7, y: 5, z: pts[dent]!.z * 0.7 }; // pulled 3 mm inward
    const arcs = fitArcs(pts, TOL).filter(isArc);
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    for (const arc of arcs) {
      assertArcWithinTolerance(pts, arc, TOL);
      const s = refIndex(pts, arc.start);
      const e = refIndex(pts, arc.end);
      // No arc strictly spans the dent.
      expect(s >= dent || e <= dent).toBe(true);
    }
  });
});

describe('fitArcs — run breaks', () => {
  it('breaks runs at rapids — arcs never span a rapid point', () => {
    const quarter = (startDeg: number): ToolpathPoint[] =>
      Array.from({ length: 25 }, (_, k) => {
        const a = ((startDeg + (90 * k) / 24) * Math.PI) / 180;
        return { x: 10 * Math.cos(a), y: 5, z: 10 * Math.sin(a), rapid: false };
      });
    const pts: ToolpathPoint[] = [
      { x: 10, y: 15, z: 0, rapid: true },
      ...quarter(0),
      { x: 0, y: 15, z: 10, rapid: true }, // rapid out — must break
      ...quarter(180),
      { x: 0, y: 15, z: -10, rapid: true },
    ];
    const rapidAt = new Set([0, 26, 52]);
    const arcs = fitArcs(pts, TOL).filter(isArc);
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    for (const arc of arcs) {
      const s = refIndex(pts, arc.start);
      const e = refIndex(pts, arc.end);
      for (const r of rapidAt) {
        expect(s > r || e < r, `arc [${s}, ${e}] must not span rapid point ${r}`).toBe(true);
      }
      assertArcWithinTolerance(pts, arc, TOL);
    }
  });

  it('breaks runs at depth changes — a helical ramp never becomes an arc', () => {
    const pts: ToolpathPoint[] = [{ x: 10, y: 6, z: 0, rapid: true }];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI; // half turn while descending 1 mm
      pts.push({ x: 10 * Math.cos(a), y: 6 - k * 0.02, z: 10 * Math.sin(a), rapid: false });
    }
    const items = fitArcs(pts, TOL);
    expect(items.filter(isArc)).toHaveLength(0);
    expect(items.every(isPoint)).toBe(true);
  });

  it('fits arcs on the flat stretch of a ramp-then-flat run only', () => {
    const ramp: ToolpathPoint[] = Array.from({ length: 6 }, (_, k) => ({
      x: k,
      y: 6 - k * 0.2, // descending — every step changes y
      z: 0,
      rapid: false,
    }));
    const flat = Array.from({ length: 25 }, (_, k) => {
      const a = (90 * k) / 24 * (Math.PI / 180);
      return { x: 10 * Math.cos(a), y: 5, z: 10 * Math.sin(a), rapid: false };
    });
    const pts = [{ x: 0, y: 12, z: 0, rapid: true } as ToolpathPoint, ...ramp, ...flat];
    const arcs = fitArcs(pts, TOL).filter(isArc);
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    for (const arc of arcs) {
      const s = refIndex(pts, arc.start);
      const e = refIndex(pts, arc.end);
      expect(s).toBeGreaterThanOrEqual(7); // flat run starts after the ramp
      expect(e).toBeLessThanOrEqual(pts.length - 1);
      assertArcWithinTolerance(pts, arc, TOL);
    }
  });
});

describe('fitArcs — degenerate and disabled inputs', () => {
  it('leaves straight polylines untouched', () => {
    const pts = Array.from({ length: 20 }, (_, k) => ({ x: k, y: 5, z: k * 0.5, rapid: false }));
    const items = fitArcs(pts, TOL);
    expect(items.every(isPoint)).toBe(true);
    expect(items).toHaveLength(pts.length);
    items.forEach((item, k) => expect(item).toBe(pts[k]));
  });

  it('passes through empty, single and two-point inputs unchanged', () => {
    expect(fitArcs([], TOL)).toEqual([]);
    const one: ToolpathPoint[] = [{ x: 1, y: 2, z: 3, rapid: false }];
    const two: ToolpathPoint[] = [...one, { x: 2, y: 2, z: 3, rapid: false }];
    expect(fitArcs(one, TOL)[0]).toBe(one[0]);
    expect(fitArcs(two, TOL)[1]).toBe(two[1]);
  });

  it('tolerance ≤ 0 disables fitting (polyline pass-through)', () => {
    const pts = circleLoop(64, 10);
    const items = fitArcs(pts, 0);
    expect(items.every(isPoint)).toBe(true);
    expect(items).toHaveLength(pts.length);
  });

  it('keeps feedRate/rapid context on the original point objects', () => {
    const pts = circleLoop(48, 10);
    pts[0] = { ...pts[0]!, feedRate: 500 };
    const items = fitArcs(pts, TOL);
    const first = items[0]!;
    expect(isPoint(first)).toBe(true);
    if (isPoint(first)) expect(first.feedRate).toBe(500);
    for (const arc of items.filter(isArc)) {
      expect(arc.start.rapid).not.toBe(true);
      expect(arc.end.rapid).not.toBe(true);
    }
  });
});

describe('fitArcs — span cap (review pass #33)', () => {
  it('caps greedy spans at 512 points: monster runs stay fast and fully covered', () => {
    // A 20k-segment imported-mesh circle froze the main thread for ~3.4 s
    // before the cap (O(n²) per run); the cap splits big circles into
    // consecutive arcs instead. The default vitest timeout doubles as the
    // perf guard for this test.
    const pts = circleLoop(20000, 100);
    const items = fitArcs(pts, TOL);
    assertCoversPolyline(pts, items);
    const arcs = items.filter(isArc);
    expect(arcs.length).toBeGreaterThan(10); // still a massive reduction
    for (const arc of arcs) {
      expect(refIndex(pts, arc.end) - refIndex(pts, arc.start)).toBeLessThanOrEqual(512);
      assertArcWithinTolerance(pts, arc, TOL);
    }
  });
});
