import { describe, it, expect } from 'vitest';
import { offsetRegion } from './offsetRegion';
import { polygonArea, pointInPolygon, type Point2 } from './silhouette';

const square = (minU: number, minV: number, size: number): Point2[] => [
  { u: minU, v: minV },
  { u: minU + size, v: minV },
  { u: minU + size, v: minV + size },
  { u: minU, v: minV + size },
];

const regularGon = (n: number, r: number): Point2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { u: Math.cos(a) * r, v: Math.sin(a) * r };
  });

/** Minimum distance from p to the boundary of a polygon. */
function distToPolygonBoundary(p: Point2, poly: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const lenSq = du * du + dv * dv;
    const t = lenSq < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
    best = Math.min(best, Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv)));
  }
  return best;
}

describe('offsetRegion — distance correctness', () => {
  it('erodes a square to the exact inset square (sharp convex corners)', () => {
    const comps = offsetRegion(square(0, 0, 100), [], -3);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.holes).toHaveLength(0);
    const outer = comps[0]!.outer;
    // Convex corners stay mitered under erosion: the result is exactly 94×94.
    expect(outer).toHaveLength(4);
    expect(polygonArea(outer)).toBeCloseTo(94 * 94, 6);
    for (const p of outer) {
      expect(distToPolygonBoundary(p, square(0, 0, 100))).toBeCloseTo(3, 6);
    }
  });

  it('erodes a near-circle so every vertex keeps the radial distance', () => {
    const gon = regularGon(64, 20);
    const comps = offsetRegion(gon, [], -5);
    expect(comps).toHaveLength(1);
    // Every output vertex sits ≈5 mm from the input boundary; the slack is
    // the arc tolerance (round join discretization on the reflex side) plus
    // the 2 µm input decimation budget.
    for (const p of comps[0]!.outer) {
      const d = distToPolygonBoundary(p, gon);
      expect(Math.abs(d - 5)).toBeLessThanOrEqual(0.02 + 0.002 + 1e-6);
    }
  });

  it('dilates a square with rounded convex corners (disc-cutter exact)', () => {
    const comps = offsetRegion(square(0, 0, 10), [], 2);
    expect(comps).toHaveLength(1);
    const outer = comps[0]!.outer;
    // Rounded rectangle: area = 14² − (4 − π)·r² for corner radius 2. The
    // round join is discretized to the arc tolerance, so the polyline sits
    // slightly INSIDE the true arc — allow a small deficit, no excess.
    expect(polygonArea(outer)).toBeGreaterThan(14 * 14 - (4 - Math.PI) * 4 - 0.3);
    expect(polygonArea(outer)).toBeLessThan(14 * 14 - (4 - Math.PI) * 4 + 0.02);
    // Every emitted vertex is exactly 2 mm from the original boundary.
    for (const p of outer) {
      expect(distToPolygonBoundary(p, square(0, 0, 10))).toBeCloseTo(2, 2);
    }
  });

  it('miter join keeps dilation corners sharp (contour parity mode)', () => {
    const comps = offsetRegion(square(0, 0, 10), [], 2, { joinType: 'miter' });
    expect(comps[0]!.outer).toHaveLength(4);
    expect(polygonArea(comps[0]!.outer)).toBeCloseTo(14 * 14, 6);
  });
});

describe('offsetRegion — islands and topology', () => {
  it('erodes a square-with-island to the correct annulus', () => {
    // 40×40 region with a centred 10×10 island, eroded by 3: outer becomes
    // 34×34, the island grows to 16×16 with rounded convex corners of radius
    // 3 (hole area 16² − (4−π)·9).
    const hole = square(15, 15, 10);
    const comps = offsetRegion(square(5, 5, 40), [hole], -3);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.holes).toHaveLength(1);
    expect(polygonArea(comps[0]!.outer)).toBeCloseTo(34 * 34, 6);
    // Hole grown to 16×16 with rounded convex corners of radius 3; the join
    // discretization sits slightly inside the arcs (small deficit only).
    const holeArea = -polygonArea(comps[0]!.holes[0]!);
    expect(holeArea).toBeGreaterThan(16 * 16 - (4 - Math.PI) * 9 - 0.4);
    expect(holeArea).toBeLessThan(16 * 16 - (4 - Math.PI) * 9 + 0.02);
    // The topology is real: the hole is inside the outer, not a sibling.
    expect(pointInPolygon(comps[0]!.holes[0]![0]!, comps[0]!.outer)).toBe(true);
    expect(comps[0]!.holes[0]!.length).toBeGreaterThan(8); // the rounded corners
  });

  it('erodes to nothing → [] (tool too large)', () => {
    expect(offsetRegion(square(0, 0, 10), [], -8)).toEqual([]);
    // The island swallowing the whole region is also empty.
    expect(offsetRegion(square(0, 0, 20), [square(5, 5, 10)], -8)).toEqual([]);
  });

  it('two close islands merge into ONE hole under erosion', () => {
    // Islands A u∈[−12,−2] and B u∈[0,10] leave a 2 mm gap; eroding 1.5
    // grows each island 1.5 per side (A→[−13.5,−0.5], B→[−1.5,11.5]), the
    // gap closes, and the pair must come back as ONE merged hole ring
    // spanning the full grown width (25 mm).
    const holes = [square(-12, -5, 10), square(0, -5, 10)];
    const comps = offsetRegion(square(-20, -20, 40), holes, -1.5);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.holes).toHaveLength(1);
    // Each grown island alone is ≈167 (13×13 minus corner rounding); the
    // merged union minus the 1 mm overlap ≈ 322 — far beyond one island.
    expect(-polygonArea(comps[0]!.holes[0]!)).toBeGreaterThan(300);
    const us = comps[0]!.holes[0]!.map((p) => p.u);
    expect(Math.max(...us) - Math.min(...us)).toBeGreaterThanOrEqual(24.9);
  });

  it('erosion splits a dumbbell into two components', () => {
    // Two 20×20 pads joined by a 4 mm neck: eroding by 3 kills the neck and
    // leaves two components. Each is the 14×14 eroded pad PLUS a lens bulge
    // reaching into the dead neck (points ≥3 mm from both reentrant corners
    // extend to u = 2+√5 ≈ 4.24), so the area is slightly above 196.
    const dumbbell: Point2[] = [
      { u: -22, v: -10 }, { u: -2, v: -10 }, { u: -2, v: -2 }, { u: 2, v: -2 },
      { u: 2, v: -10 }, { u: 22, v: -10 }, { u: 22, v: 10 }, { u: 2, v: 10 },
      { u: 2, v: 2 }, { u: -2, v: 2 }, { u: -2, v: 10 }, { u: -22, v: 10 },
    ];
    const comps = offsetRegion(dumbbell, [], -3);
    expect(comps).toHaveLength(2);
    for (const c of comps) {
      expect(c.holes).toHaveLength(0);
      expect(polygonArea(c.outer)).toBeGreaterThan(196 - 1e-6);
      expect(polygonArea(c.outer)).toBeLessThan(197.2);
    }
  });

  it('L-shape erosion keeps the reflex corner rounded', () => {
    // L 40×40 minus a 20×20 notch, eroded by 2. The reflex corner of the
    // region becomes a radius-2 fillet (the cutter centre cannot reach into
    // the sharp inside corner), so the eroded area equals the union of the
    // two eroded bars plus the fillet. Assert via independent distance-field
    // grid sampling instead of a hand-derived closed form.
    const lShape: Point2[] = [
      { u: 0, v: 0 }, { u: 40, v: 0 }, { u: 40, v: 40 }, { u: 20, v: 40 },
      { u: 20, v: 20 }, { u: 0, v: 20 },
    ];
    const comps = offsetRegion(lShape, [], -2);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.holes).toHaveLength(0);
    const outer = comps[0]!.outer;
    // Every vertex honours the erosion distance (within arc tolerance).
    for (const p of outer) {
      expect(Math.abs(distToPolygonBoundary(p, lShape) - 2)).toBeLessThanOrEqual(0.0221);
    }
    // Area ≈ distance-field estimate: grid points inside the L AND ≥2 mm from
    // its boundary, scaled by the cell area (0.5 mm grid ⇒ <0.5% bias).
    let est = 0;
    const cell = 0.5;
    for (let u = 0.25; u < 40; u += cell) {
      for (let v = 0.25; v < 40; v += cell) {
        const p = { u, v };
        if (pointInPolygon(p, lShape) && distToPolygonBoundary(p, lShape) >= 2) est += cell * cell;
      }
    }
    expect(polygonArea(outer)).toBeGreaterThan(0.99 * est);
    expect(polygonArea(outer)).toBeLessThan(1.01 * est);
  });
});

describe('offsetRegion — conventions and degenerates', () => {
  it('returns output wound outer-CCW / holes-CW with canonical starts', () => {
    const comps = offsetRegion(square(-20, -20, 40), [[...square(-5, -5, 10)].reverse()], -3);
    expect(comps).toHaveLength(1);
    expect(polygonArea(comps[0]!.outer)).toBeGreaterThan(0);
    for (const h of comps[0]!.holes) expect(polygonArea(h)).toBeLessThan(0);
    const canon = (pts: Point2[]): void => {
      let best = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i]!.u < pts[best]!.u || (pts[i]!.u === pts[best]!.u && pts[i]!.v < pts[best]!.v)) best = i;
      }
      expect(best).toBe(0);
    };
    canon(comps[0]!.outer);
    for (const h of comps[0]!.holes) canon(h);
  });

  it('accepts holes in either winding (topSilhouette hands out all-CCW)', () => {
    const ccwHole = square(-5, -5, 10);
    const a = offsetRegion(square(-20, -20, 40), [[...ccwHole].reverse()], -3);
    const b = offsetRegion(square(-20, -20, 40), [ccwHole], -3);
    expect(b).toHaveLength(1);
    expect(b[0]!.holes).toHaveLength(1);
    expect(polygonArea(b[0]!.outer)).toBeCloseTo(polygonArea(a[0]!.outer), 6);
    expect(polygonArea(b[0]!.holes[0]!)).toBeCloseTo(polygonArea(a[0]!.holes[0]!), 6);
  });

  it('zero delta returns the region verbatim (winding only, no clipper pass)', () => {
    const outer = square(0, 0, 10);
    const comps = offsetRegion(outer, [], 0);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.outer).toEqual(outer);
    // A CW outer is re-wound CCW, still no geometry change.
    const cw = [...outer].reverse();
    const comps2 = offsetRegion(cw, [], -0);
    expect(comps2[0]!.outer).toEqual([...cw].reverse());
  });

  it('degenerate inputs yield []', () => {
    expect(offsetRegion([], [], -3)).toEqual([]);
    expect(offsetRegion([{ u: 0, v: 0 }, { u: 1, v: 0 }], [], -3)).toEqual([]);
    // Zero-area sliver (collinear ring) is degenerate, not a region.
    expect(offsetRegion([{ u: 0, v: 0 }, { u: 10, v: 0 }, { u: 5, v: 0 }], [], -3)).toEqual([]);
    // Degenerate holes are dropped, not fatal.
    const comps = offsetRegion(square(0, 0, 40), [[{ u: 0, v: 0 }, { u: 1, v: 0 }]], -3);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.holes).toHaveLength(0);
    // Non-finite delta is rejected defensively.
    expect(offsetRegion(square(0, 0, 10), [], Number.NaN)).toEqual([]);
  });

  it('is deterministic: identical calls produce identical output', () => {
    const outer = square(-20, -20, 40);
    const holes = [[...square(-5, -5, 10)].reverse()];
    expect(offsetRegion(outer, holes, -2.5)).toEqual(offsetRegion(outer, holes, -2.5));
  });

  it('far-from-origin geometry offsets identically (re-centring)', () => {
    const off = 5000;
    const near = offsetRegion(square(0, 0, 40), [], -3);
    const far = offsetRegion(square(off, off, 40), [], -3);
    expect(polygonArea(far[0]!.outer)).toBeCloseTo(polygonArea(near[0]!.outer), 6);
    expect(far[0]!.outer[0]!.u - (off + 3)).toBeCloseTo(near[0]!.outer[0]!.u - 3, 6);
  });
});

describe('offsetRegion — performance sanity', () => {
  it('20 ring offsets of a 2000-vertex contour stay interactive', () => {
    // The pathological case for the CAM ring family: an imported-mesh-quality
    // smooth contour offset 20 times. The 2 µm input decimation collapses the
    // near-circle ~7× before each boolean; without it this measured ~1.4 s
    // total (pass #35 profiling), with it the whole family is ~10× faster.
    // Generous bound (1.5 s) — this catches accidental quadratic blow-ups,
    // not machine speed.
    const gon = regularGon(2000, 30);
    const t0 = performance.now();
    let rings = 0;
    for (let k = 1; k <= 20; k++) {
      const comps = offsetRegion(gon, [], -k * 1.2);
      if (comps.length === 0) break;
      rings++;
    }
    const dt = performance.now() - t0;
    expect(rings).toBe(20);
    expect(dt).toBeLessThan(1500);
  });
});
