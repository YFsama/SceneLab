import { describe, it, expect, beforeAll } from 'vitest';
import {
  generatePocketToolpath,
  generateContourToolpath,
  generateDrillToolpath,
  generateFaceToolpath,
} from './toolpath';
import { estimateMachiningTime } from './gcode';
import { createBox, createCylinder, createTube, createExtrude } from '../geometry/brep';
import { booleanOpManifold, warmUpBooleanEngine } from '../geometry/booleanManifold';
import { translateBody } from '../geometry/operations';
import { taggedCylinderBody } from './arcSources.test';
import type { ToolDefinition, CAMParameters, Toolpath, ToolpathPoint } from './types';
import { polygonArea, topSilhouette, pointInPolygon, type Point2 } from './silhouette';
import { offsetRegion } from './offsetRegion';

/**
 * Round-join offset geometry of the 50×30 test box with the ⌀6 tool (r = 3):
 * straight runs on the 56×36 rectangle (|x| ≤ 28 / |z| ≤ 18) plus a quarter
 * arc of radius r about each box corner (±25, ±15). Loop perimeter
 * L = 2·(50 + 30) + 2π·r (the four miter corner legs r+r replaced by π/2·r).
 */
const ROUND_R = 3;
const ROUND_L = 2 * (50 + 30) + 2 * Math.PI * ROUND_R;

/** True when (x, z) lies on that round-join offset loop (chords of the join
 *  arcs may dip 5 µm inside — the offsetter's arcTolerance). */
const onOffsetLoop = (x: number, z: number): boolean => {
  const onV = Math.abs(Math.abs(x) - 28) < 1e-6 && Math.abs(z) <= 15 + 1e-6;
  const onH = Math.abs(Math.abs(z) - 18) < 1e-6 && Math.abs(x) <= 25 + 1e-6;
  if (onV || onH) return true;
  const du = Math.abs(x) - 25;
  const dv = Math.abs(z) - 15;
  return du > 0 && dv > 0 && Math.abs(Math.hypot(du, dv) - ROUND_R) < 2e-3;
};

const tool: ToolDefinition = {
  id: 'em-6mm',
  name: '6mm Endmill',
  diameter: 6,
  flutes: 2,
  type: 'endmill',
  fluteLength: 20,
  overallLength: 50,
  material: 'carbide',
};

const params: CAMParameters = {
  feedRate: 1000,
  plungeRate: 500,
  spindleSpeed: 10000,
  depthOfCut: 2,
  stepover: 3,
  stockTop: 0,
  stockBottom: -10,
};

/** Distance from a point to a segment in the u/v (x/z) plane. */
function distToSegment(
  p: { u: number; v: number },
  a: { u: number; v: number },
  b: { u: number; v: number },
): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
  return Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv));
}

/** Cutting segments of a toolpath in the planning plane (u = x, v = z). */
function cuttingSegments(tp: Toolpath): Array<[ToolpathPoint, ToolpathPoint]> {
  const segs: Array<[ToolpathPoint, ToolpathPoint]> = [];
  for (let i = 1; i < tp.points.length; i++) {
    const a = tp.points[i - 1]!;
    const b = tp.points[i]!;
    // The move INTO a non-rapid point executes as G1 — even when it follows a
    // rapid (ramp entries), the tool sweeps this segment while cutting.
    if (!b.rapid) segs.push([a, b]);
  }
  return segs;
}

/**
 * Every depth-entering (machine-Z only, i.e. scene-y only) cut move must run
 * at the plunge feed — the D4 regression.
 */
function assertPlungeFeeds(tp: Toolpath, plungeRate: number): void {
  for (let i = 1; i < tp.points.length; i++) {
    const prev = tp.points[i - 1]!;
    const p = tp.points[i]!;
    if (p.rapid) continue;
    const xyMove = Math.abs(p.x - prev.x) > 1e-9 || Math.abs(p.z - prev.z) > 1e-9;
    const yMove = Math.abs(p.y - prev.y) > 1e-9;
    if (yMove && !xyMove) {
      expect(
        p.feedRate,
        `depth-only cut at index ${i} must carry the plunge feed`,
      ).toBe(plungeRate);
    }
  }
}

/**
 * Contour cutting runs: each run is the plunge + cut points of one closed
 * loop at one level, bounded by rapids (a spring pass extends the final-level
 * run instead of starting a new one).
 */
function contourRuns(tp: Toolpath): ToolpathPoint[][] {
  const runs: ToolpathPoint[][] = [];
  let cur: ToolpathPoint[] = [];
  for (const p of tp.points) {
    if (p.rapid) {
      if (cur.length > 0) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

/** Signed area of a cutting run in the planning plane (positive = CCW). */
function runArea(run: ToolpathPoint[]): number {
  return polygonArea(run.map((p) => ({ u: p.x, v: p.z })));
}

/** Planar (machine XY) arc length travelled by a run. */
function planarArc(run: ToolpathPoint[]): number {
  let s = 0;
  for (let i = 1; i < run.length; i++) {
    s += Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.z - run[i - 1]!.z);
  }
  return s;
}

/**
 * Arc spans [s0, s1] where the run rises above `ground` (a holding-tab ride).
 * Spans are measured from the last grounded point to the first grounded point
 * around the ride, so a span covers ramps + flat and its width is the tab's
 * full arc width.
 */
function liftedArcs(run: ToolpathPoint[], ground: number): Array<[number, number]> {
  // Cumulative planar arc at each point of the run.
  const cum: number[] = [0];
  for (let i = 1; i < run.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.z - run[i - 1]!.z));
  }
  const spans: Array<[number, number]> = [];
  let lastGround = 0;
  let open: number | null = null;
  for (let i = 0; i < run.length; i++) {
    const p = run[i]!;
    if (p.y > ground + 1e-9) {
      if (open === null) open = lastGround;
    } else {
      if (open !== null) spans.push([open, cum[i]!]);
      open = null;
      lastGround = cum[i]!;
    }
  }
  if (open !== null) spans.push([open, cum[cum.length - 1]!]);
  return spans;
}

/** True when the closed segments a→b and c→d share any point (incl. touching). */
function testSegmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (o: Point2, p: Point2, q: Point2): number =>
    (p.u - o.u) * (q.v - o.v) - (p.v - o.v) * (q.u - o.u);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const onSegment = (p: Point2, q: Point2, e: Point2): boolean =>
    cross(p, q, e) === 0 &&
    Math.min(p.u, q.u) <= e.u && e.u <= Math.max(p.u, q.u) &&
    Math.min(p.v, q.v) <= e.v && e.v <= Math.max(p.v, q.v);
  return (
    (d1 === 0 && onSegment(c, d, a)) || (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) || (d4 === 0 && onSegment(a, b, d))
  );
}

/** Simple-polygon check: every non-adjacent edge pair must not intersect. */
function loopSelfIntersects(pts: Point2[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing pair shares vertex 0
      if (testSegmentsIntersect(pts[i]!, pts[(i + 1) % n]!, pts[j]!, pts[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

interface DetectedLoop {
  /** Cut points of one closed loop, in emission order. */
  loop: ToolpathPoint[];
  /** Plan position where the loop starts (and closes). */
  start: Point2;
  /** Signed shoelace area over the loop points (positive = CCW). */
  area: number;
  /** Loop perimeter including the closing edge. */
  per: number;
}

/**
 * Detect the closed loops a toolpath cuts (rings, finish passes, tab-free
 * contour revolutions). A loop is a maximal sequence of cut moves that
 * returns to where it began — anchored EITHER at the position right before
 * its first cut (plunge/ramp entries start from a rapid there; a helical
 * true-up starts from the previous cut) OR at the first cut point itself
 * (link entries: the link move ends ON the loop start). Cut sequences that
 * never return (raster rows) stay open and are dropped.
 */
function closedLoops(tp: Toolpath): DetectedLoop[] {
  const out: DetectedLoop[] = [];
  const same = (a: Point2, b: Point2): boolean =>
    Math.abs(a.u - b.u) < 1e-6 && Math.abs(a.v - b.v) < 1e-6;
  let cur: Point2 | null = null;
  let anchorPrev: Point2 | null = null;
  let anchorFirst: Point2 | null = null;
  let moved = false;
  let collect: ToolpathPoint[] = [];
  for (const p of tp.points) {
    const plan = { u: p.x, v: p.z };
    if (p.rapid) {
      cur = plan;
      anchorPrev = null;
      anchorFirst = null;
      moved = false;
      collect = [];
      continue;
    }
    if (anchorFirst === null) {
      anchorPrev = cur;
      anchorFirst = plan;
      moved = false;
      collect = [];
    }
    collect.push(p);
    if (!same(plan, anchorPrev!) && !same(plan, anchorFirst)) moved = true;
    cur = plan;
    if (moved && (same(plan, anchorPrev!) || same(plan, anchorFirst))) {
      const pts = collect.map((q) => ({ u: q.x, v: q.z }));
      let per = 0;
      for (let i = 1; i < pts.length; i++) {
        per += Math.hypot(pts[i]!.u - pts[i - 1]!.u, pts[i]!.v - pts[i - 1]!.v);
      }
      per += Math.hypot(pts[0]!.u - pts[pts.length - 1]!.u, pts[0]!.v - pts[pts.length - 1]!.v);
      out.push({ loop: collect, start: same(plan, anchorPrev!) ? anchorPrev! : anchorFirst!, area: polygonArea(pts), per });
      anchorPrev = null;
      anchorFirst = null;
      moved = false;
      collect = [];
    }
  }
  return out;
}

/** Loop points as a plan polygon, trailing duplicate of the start dropped. */
function loopPolygon(loop: ToolpathPoint[]): Point2[] {
  const pts = loop.map((p) => ({ u: p.x, v: p.z }));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && Math.abs(first.u - last.u) < 1e-9 && Math.abs(first.v - last.v) < 1e-9) {
    pts.pop();
  }
  return pts;
}

/** Signed planar angle swept by consecutive points around a centre. */
function sweptAngle(pts: ToolpathPoint[], e: { u: number; v: number }): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const au = a.x - e.u;
    const av = a.z - e.v;
    const bu = b.x - e.u;
    const bv = b.z - e.v;
    total += Math.atan2(au * bv - av * bu, au * bu + av * bv);
  }
  return total;
}

/**
 * Recover the helical first entry of a toolpath: the first cutting run's
 * descent prefix (points above the level, plus the first point that reaches
 * it) and the flat true-up circle that follows. The helix angles are uniform
 * over whole revolutions, so the descent centroid IS the helix centre.
 */
function recoverHelixEntry(tp: Toolpath, yLevel: number): {
  preRun: ToolpathPoint;
  descent: ToolpathPoint[];
  flat: ToolpathPoint[];
  center: Point2;
  radius: number;
  revs: number;
} {
  const start = tp.points.findIndex((p) => !p.rapid);
  expect(start).toBeGreaterThan(0);
  const run: ToolpathPoint[] = [];
  for (let i = start; i < tp.points.length && !tp.points[i]!.rapid; i++) run.push(tp.points[i]!);
  const di = run.findIndex((p) => Math.abs(p.y - yLevel) < 1e-9);
  expect(di).toBeGreaterThan(0);
  const descent = run.slice(0, di + 1);
  let cu = 0;
  let cv = 0;
  for (const p of descent) {
    cu += p.x / descent.length;
    cv += p.z / descent.length;
  }
  const center = { u: cu, v: cv };
  const radius = descent.reduce((s, p) => s + Math.hypot(p.x - cu, p.z - cv), 0) / descent.length;
  const flat: ToolpathPoint[] = [];
  for (let i = di + 1; i < run.length; i++) {
    if (Math.abs(Math.hypot(run[i]!.x - cu, run[i]!.z - cv) - radius) > 1e-6) break;
    flat.push(run[i]!);
  }
  const turn = sweptAngle([tp.points[start - 1]!, ...descent], center);
  return {
    preRun: tp.points[start - 1]!,
    descent,
    flat,
    center,
    radius,
    revs: Math.round(turn / (2 * Math.PI)),
  };
}

describe('generatePocketToolpath', () => {
  const pocketBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 0, z: 10 } };

  beforeAll(async () => {
    await warmUpBooleanEngine(); // the narrow-island test pockets a boolean body
  });

  // The audit's case: 10 mm-wide pocket, 6 mm cutter. Tool-centre rows must
  // span [3, 7] with the final row clamped ON 7, leaving no standing strip.
  it('covers the whole pocket — grid-sampled, including the final row clamp', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, {
      ...params,
      depthOfCut: 10,
      stockTop: 10,
      stockBottom: 0,
    });
    const r = tool.diameter / 2;
    const segs = cuttingSegments(tp);
    expect(segs.length).toBeGreaterThan(0);

    // Tool-centre inset rectangle [3,47]×[3,7].
    const distToInsetRect = (u: number, v: number): number => {
      const du = Math.max(3 - u, 0, u - 47);
      const dv = Math.max(3 - v, 0, v - 7);
      return Math.hypot(du, dv);
    };

    for (let u = 0.25; u < 50; u += 0.5) {
      for (let v = 0.25; v < 10; v += 0.5) {
        // Only points the cutter can physically reach (skips rounded corners).
        if (distToInsetRect(u, v) > r - 0.15) continue;
        const d = Math.min(
          ...segs.map(([a, b]) => distToSegment({ u, v }, { u: a.x, v: a.z }, { u: b.x, v: b.z })),
        );
        expect(
          Math.max(0, d - r),
          `material left standing at (${u.toFixed(2)}, ${v.toFixed(2)}): ${d.toFixed(2)} from path`,
        ).toBeLessThanOrEqual(0.15);
      }
    }
  });

  it('emits a final row exactly at maxV − r', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, {
      ...params,
      depthOfCut: 10,
      stockTop: 10,
      stockBottom: 0,
    });
    const rows = [
      ...new Set(tp.cuttingMoves.map((p) => p.z.toFixed(3))),
    ].map(Number).sort((a, b) => a - b);
    // Inset region v ∈ [3, 7]; the last row must sit ON 7, not 1.6 mm short.
    expect(rows[rows.length - 1]!).toBeCloseTo(7, 3);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]! - rows[i - 1]!).toBeLessThanOrEqual(2.4 + 1e-6); // ≤ stepover
    }
  });

  it('ramps the first entry instead of plunging straight down', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, {
      ...params,
      depthOfCut: 2,
      stockTop: 10,
      stockBottom: 0,
    });
    const firstCut = tp.points.findIndex((p) => !p.rapid);
    const a = tp.points[firstCut - 1]!;
    const b = tp.points[firstCut]!;
    // The ramp descends while advancing along the row (both u and y change).
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(1);
    expect(b.y).toBeLessThan(a.y);
  });

  it('every depth-only cut runs at the plunge feed', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, params);
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('retracts vertically between rows — no diagonal rapids below safe height', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, params);
    const safe = params.stockTop + 5;
    for (let i = 1; i < tp.points.length; i++) {
      const prev = tp.points[i - 1]!;
      const p = tp.points[i]!;
      if (p.rapid && prev.y < safe - 1e-6) {
        // A rapid starting below safe height must be straight up.
        expect(Math.abs(p.x - prev.x)).toBeLessThan(1e-9);
        expect(Math.abs(p.z - prev.z)).toBeLessThan(1e-9);
        expect(p.y).toBeGreaterThan(prev.y);
      }
    }
  });

  it('plans in the XZ plane: y is the depth axis', () => {
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: -10 }, max: { x: 50, y: 0, z: -4 } },
      tool,
      params,
    );
    for (const p of tp.points) {
      // Raster stays within the plan bounds; depth is carried by y.
      expect(p.z).toBeGreaterThanOrEqual(-10 - 1e-6);
      expect(p.z).toBeLessThanOrEqual(-4 + tool.diameter / 2 + 1e-6);
      expect(p.y).toBeLessThanOrEqual(params.stockTop + 5 + 1e-6);
    }
  });

  it('clips the raster to the body silhouette when a body is given', () => {
    const cylinder = createCylinder(15, 20, 32);
    const tp = generatePocketToolpath(
      { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } },
      tool,
      { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0 },
      { body: cylinder },
    );
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    const r = tool.diameter / 2;
    for (const p of tp.cuttingMoves) {
      // Inside the silhouette inset by the cutter radius (miter ≈ radial).
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(15 - r + 0.05);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(15 - r - 0.5);
    }
  });

  it('links consecutive rows with cut moves — fewer rapids, less estimated time', () => {
    // A plain rectangular pocket: every row transition is linkable, so the
    // retract→rapid→plunge detours disappear except at the level boundary.
    const linked = generatePocketToolpath(pocketBounds, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
    });
    const unlinked = generatePocketToolpath(pocketBounds, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
    }, { linkRows: false });

    // Same coverage: identical cutting rows.
    expect(linked.cuttingMoves.length).toBeGreaterThan(0);
    // Fewer rapids (retract+traverse+feedplane per row saved)…
    expect(linked.rapidMoves.length).toBeLessThan(unlinked.rapidMoves.length);
    // …so the estimated machining time drops.
    expect(estimateMachiningTime(linked)).toBeLessThan(estimateMachiningTime(unlinked));

    // A link move is a CUT between two different rows: consecutive non-rapid
    // points whose z (row axis) differs and which is not a plunge.
    let links = 0;
    for (let i = 1; i < linked.points.length; i++) {
      const a = linked.points[i - 1]!;
      const b = linked.points[i]!;
      if (b.rapid) continue;
      if (Math.abs(b.z - a.z) > 1e-6 && b.feedRate !== params.plungeRate) links++;
    }
    expect(links).toBeGreaterThan(0);
  });

  it('never links across an island — the chord guard falls back to the retract detour', () => {
    // A tube pocketed: the ⌀12 hole is an island. Rows crossing the hole
    // split into two intervals; the straight chord between them runs through
    // the island, so the midpoint guard must reject the link.
    const tube = createTube(15, 6, 20, 32);
    const tp = generatePocketToolpath(
      { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } },
      { ...tool, diameter: 3, fluteLength: 12 },
      { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0 },
      { body: tube },
    );
    // Every cut stays inside the annulus: outside the island grown by the
    // cutter radius (6+1.5) and inside the outer loop inset by it (15−1.5).
    const r = 1.5;
    for (const p of tp.cuttingMoves) {
      const dist = Math.hypot(p.x, p.z);
      expect(dist).toBeGreaterThanOrEqual(6 + r - 0.05);
      expect(dist).toBeLessThanOrEqual(15 - r + 0.05);
    }
  });

  it('never links across a NARROW island — the segment×AABB guard catches what the quarter samples missed', () => {
    // A 0.6 mm-wide through-slot island in a 50×10 plate, pocketed with a
    // ⌀3 cutter. When a row splits into two intervals the interval
    // directions alternate, so the link chord can run from one interval's
    // far end BACK ACROSS the slot — the island sits in the first tenth of
    // the chord where the t=.25/.5/.75 samples never look, and the cutter
    // gouged straight through the wall (pass-30 P3 T2). The clipper-grown
    // keep-out now has ROUNDED caps (disc dilation of the slot rectangle),
    // so the guard criterion here is the true one: every cut segment keeps
    // the tool centre ≥ r−0.02 from the slot rectangle itself.
    const plate = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }, { x: 50, y: 0, z: 10 }, { x: 0, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const slot = translateBody(
      createExtrude({
        profile: [
          { x: -0.3, y: 0, z: -3 }, { x: 0.3, y: 0, z: -3 }, { x: 0.3, y: 0, z: 3 }, { x: -0.3, y: 0, z: 3 },
        ],
        direction: { x: 0, y: 1, z: 0 }, distance: 12, symmetric: false,
      }),
      { x: 24.3, y: -1, z: 5 },
    );
    const body = booleanOpManifold(plate, slot, 'difference');
    expect(body).not.toBeNull();
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 10, z: 10 } },
      { ...tool, diameter: 3, fluteLength: 12 },
      { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 },
      { body: body! },
    );
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);

    // The slot rectangle in the planning plane (u, v).
    const rect: Point2[] = [
      { u: 24.0, v: 2.0 }, { u: 24.6, v: 2.0 }, { u: 24.6, v: 8.0 }, { u: 24.0, v: 8.0 },
    ];
    /** Distance between segments a→b and c→d (0 when they touch). */
    const distSegSeg = (a: { x: number; z: number }, b: { x: number; z: number }, c: Point2, d: Point2): number => {
      const A = { u: a.x, v: a.z };
      const B = { u: b.x, v: b.z };
      if (testSegmentsIntersect(A, B, c, d)) return 0;
      return Math.min(
        distToSegment(A, c, d), distToSegment(B, c, d),
        distToSegment(c, A, B), distToSegment(d, A, B),
      );
    };
    const r = 1.5;
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (b.rapid) continue;
      if (a.y > 0.5 || b.y > 0.5) continue; // depth cuts only
      for (let e = 0; e < 4; e++) {
        const d = distSegSeg(a, b, rect[e]!, rect[(e + 1) % 4]!);
        expect(
          d,
          `gouging link (${a.x.toFixed(2)},${a.z.toFixed(2)}) → (${b.x.toFixed(2)},${b.z.toFixed(2)}) only ${d.toFixed(3)} from the island`,
        ).toBeGreaterThanOrEqual(r - 0.02);
      }
    }
    // The detour actually happens: crossing rows retract (the unlinked path
    // has strictly more rapids than the same pocket without the slot).
    const plain = generatePocketToolpath(pocketBounds, { ...tool, diameter: 3, fluteLength: 12 }, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
    });
    expect(tp.rapidMoves.length).toBeGreaterThan(plain.rapidMoves.length);
  });

  it('pockets BOTH sides when a grown island splits the region (multi-component raster)', () => {
    // A tall narrow island grown by the cutter radius spans the whole cleared
    // height, so the region erosion splits into two components. Both must be
    // machined by their own raster sweep — the old single-ring inset milled
    // one merged (wrong) region; silently dropping a component would leave
    // half the pocket standing.
    const plate = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }, { x: 50, y: 0, z: 10 }, { x: 0, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const wall = translateBody(
      createExtrude({
        profile: [
          { x: -0.5, y: 0, z: -4 }, { x: 0.5, y: 0, z: -4 }, { x: 0.5, y: 0, z: 4 }, { x: -0.5, y: 0, z: 4 },
        ],
        direction: { x: 0, y: 1, z: 0 }, distance: 12, symmetric: false,
      }),
      { x: 25, y: -1, z: 5 },
    );
    const body = booleanOpManifold(plate, wall, 'difference');
    expect(body).not.toBeNull();
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 10, z: 10 } },
      { ...tool, diameter: 3, fluteLength: 12 },
      { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 },
      { body: body! },
    );
    const cuts = tp.cuttingMoves.filter((p) => p.y < 0.5);
    expect(cuts.filter((p) => p.x < 23).length).toBeGreaterThan(0);
    expect(cuts.filter((p) => p.x > 27).length).toBeGreaterThan(0);
  });

  it('keeps every rapid that starts below safe height vertical (linking version)', () => {
    const tp = generatePocketToolpath(pocketBounds, tool, params);
    const safe = params.stockTop + 5;
    for (let i = 1; i < tp.points.length; i++) {
      const prev = tp.points[i - 1]!;
      const p = tp.points[i]!;
      if (p.rapid && prev.y < safe - 1e-6) {
        expect(Math.abs(p.x - prev.x)).toBeLessThan(1e-9);
        expect(Math.abs(p.z - prev.z)).toBeLessThan(1e-9);
        expect(p.y).toBeGreaterThan(prev.y);
      }
    }
  });

  it('honors safeZAboveStock for the traverse height (pass-29 review #10)', () => {
    const high = generatePocketToolpath(pocketBounds, tool, {
      ...params, safeZAboveStock: 12, stockTop: 10, stockBottom: 0, depthOfCut: 10,
    });
    const low = generatePocketToolpath(pocketBounds, tool, {
      ...params, safeZAboveStock: 3, stockTop: 10, stockBottom: 0, depthOfCut: 10,
    });
    const maxY = (tp: Toolpath) => Math.max(...tp.points.map((p) => p.y));
    // The traverse plane tracks the margin, not the hardcoded +5.
    expect(maxY(high)).toBeCloseTo(10 + 12, 6);
    expect(maxY(low)).toBeCloseTo(10 + 3, 6);
    // …and nothing was ever planned above the respective safe plane.
    for (const p of low.points) expect(p.y).toBeLessThanOrEqual(10 + 3 + 1e-9);
  });
});

describe('generateContourToolpath', () => {
  // The audit case: cylinder(15, 20, 32) — was a rectangle through the
  // extremes; must be a 32-segment loop outside radius 15 by the cutter
  // radius. With ROUND joins the loop is the 32 offset flats joined by 32
  // corner arcs of radius r about the 32-gon's vertices — every point sits
  // exactly r off the silhouette (the geometrically exact cutter-centre
  // locus; the legacy miter vertices overshot to 18.016 instead).
  it('cylinder contour is the 32-gon offset by the cutter radius, corners rounded', () => {
    const body = createCylinder(15, 20, 32);
    const tp = generateContourToolpath(body, tool, {
      ...params,
      depthOfCut: 20,
      stockTop: 20,
      stockBottom: 0,
    });
    const offset = tool.diameter / 2;
    const distinct = new Set(tp.cuttingMoves.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`));
    // 32 flats + 32 discretized corner arcs — many more than the miter 32,
    // and the loop perimeter is the n-gon perimeter plus a full 2π·r.
    expect(distinct.size).toBeGreaterThanOrEqual(64);
    const run = contourRuns(tp)[0]!;
    expect(planarArc(run)).toBeCloseTo(2 * 32 * 15 * Math.sin(Math.PI / 32) + 2 * Math.PI * offset, 1);
    for (const p of tp.cuttingMoves) {
      // Never outside the true offset circle by more than quantization…
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(15 + offset + 2e-3);
      // …and never closer than r − ε to the 32-gon silhouette (cutter
      // compensation holds on the flats AND the corner arcs).
      const dSil = Math.min(
        ...Array.from({ length: 32 }, (_, i) => {
          const a0 = ((2 * Math.PI * i) / 32);
          const v = { u: 15 * Math.cos(a0), v: 15 * Math.sin(a0) };
          const a1 = (2 * Math.PI * (i + 1)) / 32;
          const w = { u: 15 * Math.cos(a1), v: 15 * Math.sin(a1) };
          return distToSegment({ u: p.x, v: p.z }, v, w);
        }),
      );
      expect(dSil).toBeGreaterThanOrEqual(offset - 0.01);
    }
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('box contour runs outside the walls by the FULL cutter radius', () => {
    const body = createBox(50, 10, 30); // x ±25, z ±15
    const tp = generateContourToolpath(body, tool, {
      ...params,
      depthOfCut: 10,
      stockTop: 10,
      stockBottom: 0,
    });
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    // Round join: every offset EDGE sits exactly r outside a wall, and the
    // four corners sweep true quarter arcs of radius r about the box corners
    // — every point clears the wall by exactly the full radius (the legacy
    // miter version overshot each corner diagonally to r·√2 instead).
    const r = tool.diameter / 2;
    const us = tp.cuttingMoves.map((p) => Math.abs(p.x));
    const vs = tp.cuttingMoves.map((p) => Math.abs(p.z));
    expect(Math.max(...us)).toBeCloseTo(25 + r, 2);
    expect(Math.max(...vs)).toBeCloseTo(15 + r, 2);
    // Every path point clears the wall by the full radius (mitered corners
    // only ever add clearance).
    for (const p of tp.cuttingMoves) {
      const du = Math.max(Math.abs(p.x) - 25, 0);
      const dv = Math.max(Math.abs(p.z) - 15, 0);
      expect(Math.hypot(du, dv)).toBeGreaterThanOrEqual(r - 0.01);
    }
  });

  it('tube contour cuts the outer wall and the island wall', () => {
    const body = createTube(15, 6, 20, 32);
    const tp = generateContourToolpath(body, tool, {
      ...params,
      depthOfCut: 20,
      stockTop: 20,
      stockBottom: 0,
    });
    const radii = tp.cuttingMoves.map((p) => Math.hypot(p.x, p.z));
    // Outer loop at 15+3=18; island loop inside the hole at 6−3=3.
    expect(Math.max(...radii)).toBeCloseTo(18, 1);
    expect(Math.min(...radii)).toBeCloseTo(3, 1);
  });

  it('descends in depthOfCut steps from stockTop to stockBottom', () => {
    const body = createBox(20, 10, 20);
    const tp = generateContourToolpath(body, tool, {
      ...params,
      depthOfCut: 4,
      stockTop: 10,
      stockBottom: 0,
    });
    const levels = [...new Set(tp.cuttingMoves.map((p) => p.y.toFixed(3)))].map(Number).sort((a, b) => b - a);
    expect(levels).toEqual([6, 2, 0]);
  });
});

describe('generateContourToolpath — cut direction (climb/conventional)', () => {
  it('default/climb mills the outer loop CW; conventional reverses it CCW', () => {
    const body = createBox(50, 10, 30);
    const base = { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 };
    const climb = generateContourToolpath(body, tool, base);
    const conv = generateContourToolpath(body, tool, { ...base, direction: 'conventional' });
    const aC = runArea(contourRuns(climb)[0]!);
    const aV = runArea(contourRuns(conv)[0]!);
    // Corrected convention (pass #34 review, chip-thickness simulation): M3
    // climb ⇔ material on the RIGHT of travel — with the tool outside the
    // part the enclosed material sits on the right when the loop runs CW
    // (negative shoelace area), mirrored for conventional. Pass #33 shipped
    // this inverted; 0.28.0 fixes it.
    expect(aC).toBeLessThan(0);
    expect(aV).toBeGreaterThan(0);
    // Same offset rectangle either way: (50 + 2r) × (30 + 2r) with the four
    // corners rounded at radius r — the shoelace area is the miter rectangle
    // minus the four (1 − π/4)·r² corner bits, same start either way.
    expect(Math.abs(aC)).toBeCloseTo(56 * 36 - (4 - Math.PI) * 3 * 3, 0); // chords of the join arcs shave ~0.06 mm²
    expect(aC).toBeCloseTo(-aV, 6);
    expect(contourRuns(conv)[0]![0]!.x).toBeCloseTo(contourRuns(climb)[0]![0]!.x, 6);
    expect(contourRuns(conv)[0]![0]!.z).toBeCloseTo(contourRuns(climb)[0]![0]!.z, 6);
  });

  it('climb mills island loops CCW; conventional CW (tube through-hole)', () => {
    const body = createTube(15, 6, 20, 32);
    const base = { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0 };
    const climb = generateContourToolpath(body, tool, base);
    const conv = generateContourToolpath(body, tool, { ...base, direction: 'conventional' });
    const classify = (tp: Toolpath): { outer: number; island: number } => {
      const runs = contourRuns(tp);
      const outerRun = runs.find((r) => Math.max(...r.map((p) => Math.hypot(p.x, p.z))) > 10)!;
      const islandRun = runs.find((r) => Math.max(...r.map((p) => Math.hypot(p.x, p.z))) < 10)!;
      return { outer: runArea(outerRun), island: runArea(islandRun) };
    };
    // Material lies OUTSIDE an island loop, so climb (material on the right)
    // keeps it there by running the loop CCW (positive area).
    expect(classify(climb).outer).toBeLessThan(0);
    expect(classify(climb).island).toBeGreaterThan(0);
    expect(classify(conv).outer).toBeGreaterThan(0);
    expect(classify(conv).island).toBeLessThan(0);
  });
});

describe('generateContourToolpath — holding tabs', () => {
  // Box 50×10×30 → offset loop 56 × 36 with the four corners rounded at
  // radius 3 (perimeter ROUND_L = 2·(50+30) + 2π·3 ≈ 178.85); levels
  // [8,6,4,2,0] with depthOfCut 2, final level 0, tabTop = 0 + 3.
  const box = createBox(50, 10, 30);
  const base = { ...params, depthOfCut: 2, stockTop: 10, stockBottom: 0 };
  const tabs = { count: 2, height: 3, width: 6 };

  /** True when (x, z) lies on the round-join offset loop boundary. */
  const onOffsetRect = onOffsetLoop;

  it('rides 3D tabs on sub-tabTop levels: flat top at tabTop, ground elsewhere', () => {
    const tp = generateContourToolpath(box, tool, { ...base, tabs });
    const runs = contourRuns(tp);
    expect(runs).toHaveLength(5); // 5 levels × 1 outer loop

    const final = runs[4]!;
    // Heights stay within [finalLevel, tabTop] and reach tabTop exactly.
    for (const p of final) {
      expect(p.y).toBeGreaterThanOrEqual(0 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(3 + 1e-9);
      // Tabs never leave the path: every point stays on the offset rectangle.
      expect(onOffsetRect(p.x, p.z)).toBe(true);
    }
    expect(Math.max(...final.map((p) => p.y))).toBeCloseTo(3, 6);

    // Two rides per revolution, each exactly `width` of arc…
    const spans = liftedArcs(final, 0);
    expect(spans).toHaveLength(2);
    for (const [s0, s1] of spans) expect(s1 - s0).toBeCloseTo(6, 6);
    // …and the tabs sit centred evenly by arc length (perimeter ROUND_L →
    // ROUND_L/2 apart)…
    const centers = spans.map(([s0, s1]) => (s0 + s1) / 2).sort((a, b) => a - b);
    expect(centers[1]! - centers[0]!).toBeCloseTo(ROUND_L / 2, 1);

    // …and the Y truth along the arc: the flat window (6 mm tab − two 2 mm
    // ramps) sits at exactly tabTop, everything outside the intervals at
    // exactly the final level.
    const inFlat = (s: number): boolean =>
      spans.some(([s0, s1]) => s > s0 + 2 + 1e-6 && s < s1 - 2 - 1e-6);
    const inTab = (s: number): boolean =>
      spans.some(([s0, s1]) => s > s0 + 1e-6 && s < s1 - 1e-6);
    let s = 0;
    for (let i = 0; i < final.length; i++) {
      const p = final[i]!;
      if (inFlat(s)) expect(p.y).toBeCloseTo(3, 6);
      else if (!inTab(s)) expect(p.y).toBeCloseTo(0, 6);
      const b = final[(i + 1) % final.length]!;
      s += Math.hypot(b.x - p.x, b.z - p.z);
    }

    // The level just under tabTop (y = 2 < 3) also rides, topped at tabTop.
    const lvl2 = runs[3]!;
    expect(Math.max(...lvl2.map((p) => p.y))).toBeCloseTo(3, 6);
    expect(liftedArcs(lvl2, 2)).toHaveLength(2);
    // Upper levels (8, 6, 4 ≥ tabTop) never lift.
    const depths = [8, 6, 4];
    runs.slice(0, 3).forEach((run, i) => {
      for (const p of run) expect(p.y).toBeCloseTo(depths[i]!, 6);
    });
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('silently ignores invalid tab specs — output identical to no tabs', () => {
    const specs = [
      { count: 0, height: 3, width: 6 },
      { count: 2, height: 0, width: 6 },
      { count: 2, height: 3, width: 0 },
    ];
    const plain = generateContourToolpath(box, tool, { ...base, depthOfCut: 10 });
    for (const t of specs) {
      const tp = generateContourToolpath(box, tool, { ...base, depthOfCut: 10, tabs: t });
      expect(tp.points).toEqual(plain.points);
    }
  });

  it('wraps overlapping tab intervals across the loop seam without gouging', () => {
    // width > L/count is the only way an interval can cross the seam (centres
    // sit half a spacing away from it); with count 3 / width 64 on the ROUND_L
    // ≈ 178.85 mm loop the tabs overlap and must merge into one continuous ride.
    const tp = generateContourToolpath(box, tool, {
      ...base, depthOfCut: 10, tabs: { count: 3, height: 3, width: 64 },
    });
    const final = contourRuns(tp)[0]!;
    const ys = final.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(3, 6);
    // Tabs cover the whole loop: the cutter never reaches the final level…
    expect(Math.min(...ys)).toBeGreaterThan(1);
    // …the ride is continuous (|Δy| bounded by the ramp slope H/2mm per mm of
    // arc — a seam mishandled as flat ground would jump ~2 mm over no arc)…
    for (let i = 1; i < final.length; i++) {
      const a = final[i - 1]!;
      const b = final[i]!;
      const arc = Math.hypot(b.x - a.x, b.z - a.z);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual((3 / 2) * arc + 1e-6);
    }
    // …and the seam itself is ridden: plunge and closure agree above ground.
    expect(final[0]!.y).toBeCloseTo(final[final.length - 1]!.y, 6);
    expect(final[0]!.y).toBeGreaterThan(0);
  });
});

describe('generateContourToolpath — spring pass', () => {
  it('adds exactly one extra revolution at the final depth, without retracting', () => {
    const body = createBox(50, 10, 30);
    const base = { ...params, depthOfCut: 5, stockTop: 10, stockBottom: 0 }; // levels [5, 0]
    const plain = generateContourToolpath(body, tool, base);
    const spring = generateContourToolpath(body, tool, { ...base, springPass: true });

    // The spring revolution reuses the entry/exit: no extra rapids, no extra run.
    expect(spring.rapidMoves.length).toBe(plain.rapidMoves.length);
    expect(contourRuns(spring).length).toBe(contourRuns(plain).length);

    const p = contourRuns(plain);
    const s = contourRuns(spring);
    expect(planarArc(p[0]!)).toBeCloseTo(ROUND_L, 1); // one revolution = perimeter
    expect(planarArc(s[0]!)).toBeCloseTo(ROUND_L, 1); // non-final level unchanged
    expect(planarArc(s[1]!)).toBeCloseTo(2 * ROUND_L, 1); // final level: two revolutions
    for (const pt of s[1]!) expect(pt.y).toBeCloseTo(0, 6);
  });

  it('re-rides the tabs on the spring revolution (3D tab protection)', () => {
    const body = createBox(50, 10, 30);
    const tp = generateContourToolpath(body, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
      tabs: { count: 2, height: 3, width: 6 }, springPass: true,
    });
    const final = contourRuns(tp)[0]!;
    // Two revolutions × two tabs = four rides, each the full tab width.
    const spans = liftedArcs(final, 0);
    expect(spans).toHaveLength(4);
    for (const [s0, s1] of spans) expect(s1 - s0).toBeCloseTo(6, 6);
    expect(Math.max(...final.map((p) => p.y))).toBeCloseTo(3, 6);
  });
});

describe('generateContourToolpath — ramp entry', () => {
  const body = createBox(50, 10, 30);
  const onOffsetRect = onOffsetLoop; // round-join loop (straight runs + corner arcs)

  it('descends along the path on the first level; deeper levels still plunge', () => {
    const tp = generateContourToolpath(body, tool, {
      ...params, depthOfCut: 5, stockTop: 10, stockBottom: 0, rampEntry: true,
    }); // levels [5, 0]; first feedPlane = stockTop + 1 = 11
    const firstIdx = tp.points.findIndex((p) => !p.rapid);
    const a = tp.points[firstIdx - 1]!; // rapid at the feed plane, loop start
    const b = tp.points[firstIdx]!;
    expect(a.y).toBeCloseTo(11, 6);
    // The first cutting move descends diagonally: strictly between the feed
    // plane and the level, while advancing along the path…
    expect(b.y).toBeGreaterThan(5 + 1e-9);
    expect(b.y).toBeLessThan(11 - 1e-9);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.1);
    // …and a later move on this level completes the descent to yLevel.
    const firstRun = contourRuns(tp)[0]!;
    expect(firstRun.some((p) => Math.abs(p.y - 5) < 1e-9)).toBe(true);
    for (const p of firstRun) {
      expect(p.y).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(11 + 1e-9);
      // The ramp follows the offset rectangle instead of chording it.
      expect(onOffsetRect(p.x, p.z)).toBe(true);
    }
    assertPlungeFeeds(tp, params.plungeRate);

    // The second level keeps the legacy vertical plunge at plunge feed.
    const secondRun = contourRuns(tp)[1]!;
    const idx = tp.points.indexOf(secondRun[0]!);
    const prev = tp.points[idx - 1]!;
    expect(prev.y).toBeCloseTo(6, 6); // feedPlane = previous level + 1
    expect(secondRun[0]!.x).toBeCloseTo(prev.x, 9);
    expect(secondRun[0]!.z).toBeCloseTo(prev.z, 9);
    expect(secondRun[0]!.y).toBeCloseTo(0, 6);
    expect(secondRun[0]!.feedRate).toBe(params.plungeRate);
  });

  it('default entry stays a vertical plunge at plunge feed (legacy)', () => {
    const tp = generateContourToolpath(body, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
    });
    const firstIdx = tp.points.findIndex((p) => !p.rapid);
    const a = tp.points[firstIdx - 1]!;
    const b = tp.points[firstIdx]!;
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
    expect(b.y).toBeCloseTo(0, 6);
    expect(b.feedRate).toBe(params.plungeRate);
    // Classic structure: plunge + the loop's vertex cuts + closure, one run,
    // and the run covers exactly one revolution of the round-join loop.
    expect(contourRuns(tp)).toHaveLength(1);
    expect(planarArc(contourRuns(tp)[0]!)).toBeCloseTo(ROUND_L, 1);
  });
});

describe('generateContourToolpath — review pass #33 regressions', () => {
  it('single-level ramp entry re-cuts the entry wedge at full depth', () => {
    // One depth level only: the ramp covers [0, rampLen] and the revolution
    // [rampLen, L], so without a closing re-cut of the entry span the part
    // would stay attached to the stock by the ramp wedge — the exact failure
    // mode holding tabs exist to prevent.
    const body = createBox(50, 10, 30); // offset loop = rounded rect, straight ±28/±18, L = ROUND_L
    const tp = generateContourToolpath(body, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0, rampEntry: true,
    });
    let covered = 0;
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (!b.rapid && Math.abs(b.y) < 1e-9 && Math.abs(a.y) < 1e-9) {
        covered += Math.hypot(b.x - a.x, b.z - a.z);
      }
    }
    expect(covered).toBeGreaterThanOrEqual(ROUND_L - 5e-2); // join-arc chords shave ~0.003 mm off the true arc length
    // …and the wedge cleanup must NOT fire when a spring pass already covers
    // the full loop: the spring revolution [0, L] swallows the wedge, so the
    // total full-depth coverage is exactly two loops minus the diagonal ramp
    // approach (which is never at full depth by construction).
    const spring = generateContourToolpath(body, tool, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0, rampEntry: true, springPass: true,
    });
    let springCovered = 0;
    for (let i = 1; i < spring.points.length; i++) {
      const a = spring.points[i - 1]!;
      const b = spring.points[i]!;
      if (!b.rapid && Math.abs(b.y) < 1e-9 && Math.abs(a.y) < 1e-9) {
        springCovered += Math.hypot(b.x - a.x, b.z - a.z);
      }
    }
    const rampLen = Math.min(Math.max(2 * tool.diameter, 10 / Math.tan((15 * Math.PI) / 180)), ROUND_L);
    expect(springCovered).toBeCloseTo(2 * ROUND_L - rampLen, 1);
  });

  it('ramp × tab: emitted chords never ride above the true envelope (two-sided bisection)', () => {
    // The reviewer's failing geometry: 56×36 ring, single level, tabs 3@20.
    // The old emitTo only bisected the FIRST half of a suspicious chord, so a
    // descent line crossing a tab flank could close with a chord up to
    // ~height/40 above the profile. Rebuild the envelope analytically and
    // sample every chord against it.
    const body = createBox(56, 8, 36);
    const spec = {
      ...params, depthOfCut: 8, stockTop: 8, stockBottom: 0,
      rampEntry: true, tabs: { count: 3, height: 3, width: 20 },
    };
    const tp = generateContourToolpath(body, tool, spec);

    // Offset loop for XY → arc-length mapping: the generator's own round-join
    // region offset (straight edges + corner-arc polylines — emitted stops
    // are loop vertices or interpolated along its edges, so arc-length lerp
    // between them is exact).
    const sil = topSilhouette(body);
    expect(sil).not.toBeNull();
    const comps = offsetRegion(
      sil!.outer.points,
      sil!.islands.map((l) => l.points),
      tool.diameter / 2,
      { arcTolerance: 0.005 },
    );
    expect(comps.length).toBeGreaterThanOrEqual(1);
    const loop = comps[0]!.outer;
    const cum: number[] = [0];
    for (let i = 1; i < loop.length; i++) {
      cum.push(cum[i - 1]! + Math.hypot(loop[i]!.u - loop[i - 1]!.u, loop[i]!.v - loop[i - 1]!.v));
    }
    const L = cum[cum.length - 1]! + Math.hypot(loop[0]!.u - loop[loop.length - 1]!.u, loop[0]!.v - loop[loop.length - 1]!.v);

    /** Arc length of an emitted point: nearest edge (incl. the closing edge). */
    const arcOf = (u: number, v: number): number => {
      let best = { d: Infinity, s: 0 };
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % loop.length]!;
        const base = cum[i]!;
        const du = b.u - a.u;
        const dv = b.v - a.v;
        const lenSq = du * du + dv * dv;
        const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((u - a.u) * du + (v - a.v) * dv) / lenSq));
        const d = Math.hypot(u - (a.u + t * du), v - (a.v + t * dv));
        if (d < best.d) best = { d, s: base + t * Math.sqrt(lenSq) };
      }
      expect(best.d).toBeLessThan(1e-6); // emitted points sit ON the loop
      return best.s;
    };

    // Analytic envelope: max(linear ramp descent, tab trapezoids, yLevel 0).
    // The ramp window lives at the START of the EMISSION. The loop array is
    // CCW, but the corrected climb convention runs the outer contour CW
    // (pass #34), so travel distance runs AGAINST the array arc length:
    // d = L − s. Detect the emission direction from the first two cut points
    // instead of assuming it (the test must hold under either convention).
    const feedPlane = spec.stockTop + 1;
    const rampLen = Math.min(Math.max(2 * tool.diameter, spec.stockTop / Math.tan((15 * Math.PI) / 180)), L);
    const tabTop = spec.tabs.height;
    const tabRamp = Math.min(spec.tabs.width * 0.4, 2);
    const centers = Array.from({ length: spec.tabs.count }, (_, i) => ((i + 0.5) * L) / spec.tabs.count);
    const run0 = contourRuns(tp)[0]!;
    const sFirst = arcOf(run0[0]!.x, run0[0]!.z);
    const sSecond = arcOf(run0[1]!.x, run0[1]!.z);
    // Travel distance from the loop start (path[0], s = 0 ≡ L).
    const travelOf = (s: number): number => {
      const d = sSecond >= sFirst ? s : L - s;
      return ((d % L) + L) % L;
    };
    const env = (s: number): number => {
      const d = travelOf(s);
      let y = d <= rampLen + 1e-9 ? feedPlane + (0 - feedPlane) * (d / rampLen) : 0;
      for (const c of centers) {
        const lo = c - spec.tabs.width / 2;
        const hi = c + spec.tabs.width / 2;
        if (d < lo - 1e-12 || d > hi + 1e-12) continue;
        const local =
          d <= lo + tabRamp
            ? (tabTop * (d - lo)) / tabRamp
            : d < hi - tabRamp
              ? tabTop
              : tabTop * (1 - (d - (hi - tabRamp)) / tabRamp);
        y = Math.max(y, local);
      }
      return y;
    };

    for (let i = 1; i < run0.length; i++) {
      const a = run0[i - 1]!;
      const b = run0[i]!;
      const s0 = arcOf(a.x, a.z);
      const s1 = arcOf(b.x, b.z);
      for (const t of [0.25, 0.5, 0.75]) {
        const chordY = a.y + (b.y - a.y) * t;
        const sT = s0 + (s1 - s0) * t;
        expect(chordY - env(sT)).toBeLessThanOrEqual(1e-6);
      }
    }
  });
});

describe('generateDrillToolpath', () => {
  it('plunges to stockTop − depth at each hole in the XZ plane', () => {
    const holes = [
      { x: 10, z: -5, depth: 15 },
      { x: 30, z: 5, depth: 7 },
    ];
    const tp = generateDrillToolpath(holes, tool, { ...params, stockTop: 2, stockBottom: -20 });
    const plunges = tp.cuttingMoves;
    expect(plunges).toHaveLength(2);
    expect(plunges[0]!.y).toBeCloseTo(2 - 15, 6);
    expect(plunges[1]!.y).toBeCloseTo(2 - 7, 6);
    for (let i = 0; i < 2; i++) {
      expect(plunges[i]!.x).toBeCloseTo(holes[i]!.x, 6);
      expect(plunges[i]!.z).toBeCloseTo(holes[i]!.z, 6);
      expect(plunges[i]!.feedRate).toBe(params.plungeRate);
    }
  });

  it('still accepts the legacy y spelling for hole position', () => {
    const tp = generateDrillToolpath([{ x: 4, y: 6, depth: 5 }], tool, params);
    expect(tp.cuttingMoves[0]!.z).toBeCloseTo(6, 6);
    expect(tp.cuttingMoves[0]!.y).toBeCloseTo(params.stockTop - 5, 6);
  });

  it('drops to the R plane at min(2, safeZAboveStock) before plunging', () => {
    // Default margin (5) → the classic 2 mm approach clearance.
    const normal = generateDrillToolpath([{ x: 0, z: 0, depth: 3 }], tool, { ...params, stockTop: 10 });
    // A tight margin (1) is honored instead of dipping below the traverse
    // plane the user asked for.
    const tight = generateDrillToolpath(
      [{ x: 0, z: 0, depth: 3 }],
      tool,
      { ...params, stockTop: 10, safeZAboveStock: 1 },
    );
    const yBeforePlunge = (tp: Toolpath) => tp.points[tp.points.indexOf(tp.cuttingMoves[0]!) - 1]!.y;
    expect(yBeforePlunge(normal)).toBeCloseTo(12, 6);
    expect(yBeforePlunge(tight)).toBeCloseTo(11, 6);
    // The traverse itself sits at stockTop + margin.
    expect(tight.points[0]!.y).toBeCloseTo(11, 6);
  });
});

describe('generateFaceToolpath', () => {
  const faceBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 10, z: 20 } };

  it('removes the full depth in ceil(depth/doc) levels', () => {
    const tp = generateFaceToolpath(faceBounds, tool, {
      ...params,
      depthOfCut: 3,
      stockTop: 10,
      stockBottom: 0,
    });
    const levels = [...new Set(tp.cuttingMoves.map((p) => p.y.toFixed(3)))].map(Number).sort((a, b) => b - a);
    expect(levels).toHaveLength(Math.ceil(10 / 3));
    expect(levels).toEqual([7, 4, 1, 0]);
  });

  it('respects the 0.75·d stepover and covers to the last row', () => {
    const tp = generateFaceToolpath(faceBounds, tool, {
      ...params,
      depthOfCut: 10,
      stockTop: 10,
      stockBottom: 0,
    });
    const rows = [...new Set(tp.cuttingMoves.map((p) => p.z.toFixed(3)))].map(Number).sort((a, b) => a - b);
    const sover = Math.min(params.stepover, tool.diameter * 0.75);
    expect(rows[0]!).toBeCloseTo(0, 6);
    expect(rows[rows.length - 1]!).toBeCloseTo(20, 6); // final row clamp
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]! - rows[i - 1]!).toBeLessThanOrEqual(sover + 1e-6);
    }
    // Rows overshoot the stock edges in u by the tool diameter.
    const us = tp.cuttingMoves.map((p) => p.x);
    expect(Math.min(...us)).toBeCloseTo(-tool.diameter, 6);
    expect(Math.max(...us)).toBeCloseTo(40 + tool.diameter, 6);
    assertPlungeFeeds(tp, params.plungeRate);
  });
});

describe('generatePocketToolpath — offset strategy (contour-parallel rings)', () => {
  const boxBody = createBox(50, 10, 30); // silhouette 50 × 30 centred on the origin
  const boxBounds = { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } };
  const base = { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 }; // one level at y = 0

  const boxOffset = (extra: Partial<CAMParameters> = {}): Toolpath =>
    generatePocketToolpath(
      boxBounds, tool, { ...base, pocketStrategy: 'offset', ...extra }, { body: boxBody },
    );

  it('clears with rings: wall ring CCW, core rings CW (climb under M3)', () => {
    const tp = boxOffset();
    const loops = closedLoops(tp);
    // Cleared region 44 × 24 (r = 3 inset); stepover clamps to 0.4·d = 2.4.
    // Ring k insets the region by k·2.4: the v half-height 12 − 2.4k stays
    // positive through k = 4 and k = 5 collapses the polygon to a line
    // (offsetPolygon returns null) — exactly five rings, ≈ floor(12/2.4)+1.
    expect(loops).toHaveLength(5);
    // Corrected convention (pass #34 review): climb keeps the material on
    // the RIGHT. Ring 0 hugs the wall (material OUTSIDE the loop) → CCW
    // puts it on the right — matching the CCW helix entry. Every deeper ring
    // engages the uncleared core INSIDE the loop → CW.
    const areas = loops.map((l) => l.area);
    for (let k = 0; k < 5; k++) {
      expect(Math.sign(areas[k]!), `ring ${k} winding`).toBe(k === 0 ? 1 : -1);
    }
    expect(areas[0]!).toBeCloseTo(44 * 24, 6);
    expect(areas[1]!).toBeCloseTo(-39.2 * 19.2, 6);
    // Ring starts are the inset corner vertices (−22 + 2.4k, −12 + 2.4k):
    // reverseLoop keeps the start vertex, so every ring starts at the offset
    // image of the silhouette's first vertex.
    for (let k = 0; k < 5; k++) {
      expect(loops[k]!.start.u).toBeCloseTo(-22 + 2.4 * k, 6);
      expect(loops[k]!.start.v).toBeCloseTo(-12 + 2.4 * k, 6);
      // Self-intersection guard: every emitted ring is a simple polygon.
      expect(loopSelfIntersects(loopPolygon(loops[k]!.loop)), `ring ${k} self-intersects`).toBe(false);
    }
  });

  it('links ring-to-ring with cut moves — one cutting run per level', () => {
    const tp = boxOffset();
    // The region is convex and island-free, so every ring transition links:
    // the whole level is one cut run between the entry (safe + feed plane)
    // and the level-end retract — three rapids in total.
    expect(contourRuns(tp)).toHaveLength(1);
    expect(tp.rapidMoves).toHaveLength(3);
    assertPlungeFeeds(tp, params.plungeRate);
    // Retracts that start below safe stay vertical (entry ramp + level end).
    const safe = base.stockTop + 5;
    for (let i = 1; i < tp.points.length; i++) {
      const prev = tp.points[i - 1]!;
      const p = tp.points[i]!;
      if (p.rapid && prev.y < safe - 1e-6) {
        expect(Math.abs(p.x - prev.x)).toBeLessThan(1e-9);
        expect(Math.abs(p.z - prev.z)).toBeLessThan(1e-9);
        expect(p.y).toBeGreaterThan(prev.y);
      }
    }
  });

  it('ring bands cover ≥ 95% of the cleared region', () => {
    const tp = boxOffset();
    const loops = closedLoops(tp);
    const regionArea = 44 * 24;
    const sover = 2.4;
    // Each ring sweeps a band of ≈ perimeter × stepover.
    const band = loops.reduce((s, l) => s + l.per * sover, 0);
    expect(band).toBeGreaterThanOrEqual(0.95 * regionArea);
    // Mitered corners overlap their neighbouring bands (Σ per × sover
    // overshoots the true union by ~11% here); anything near twice the
    // region area would mean rings outside the region.
    expect(band).toBeLessThanOrEqual(1.2 * regionArea);
  });

  it('L-shaped (concave) pocket clears with rings — no raster fallback, ≥95% coverage', () => {
    // Asymmetric L (80×80 minus a 30×30 corner notch). The legacy
    // offsetPolygon ring family truncated on this exact shape at 53.8% swept
    // coverage (pass #34 review) and fell back to the raster; the clipper
    // ring family handles the concave outline directly, so the offset
    // strategy must now produce ring loops (not the raster) and sweep
    // essentially the whole reachable region.
    const lBody = createExtrude({
      profile: [
        { x: -40, y: 0, z: -40 }, { x: 40, y: 0, z: -40 }, { x: 40, y: 0, z: 40 },
        { x: -10, y: 0, z: 40 }, { x: -10, y: 0, z: 10 }, { x: -40, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const lBounds = { min: { x: -40, y: 0, z: -40 }, max: { x: 40, y: 10, z: 40 } };
    const offsetTp = generatePocketToolpath(
      lBounds, tool, { ...base, pocketStrategy: 'offset' }, { body: lBody },
    );
    const rasterTp = generatePocketToolpath(
      lBounds, tool, { ...base }, { body: lBody },
    );
    // Rings, not the raster fallback.
    expect(closedLoops(offsetTp).length).toBeGreaterThanOrEqual(5);
    expect(offsetTp.points).not.toEqual(rasterTp.points);

    // Ring family coverage: every reachable sample point of the L (inside
    // the footprint AND ≥ r from its boundary — the disc centre can never
    // honour closer points) lies within r+0.15 of a cut SEGMENT, ≥95% of
    // the time. The old ring family scored 53.8% here.
    const lPoly: Point2[] = [
      { u: -40, v: -40 }, { u: 40, v: -40 }, { u: 40, v: 40 },
      { u: -10, v: 40 }, { u: -10, v: 10 }, { u: -40, v: 10 },
    ];
    const distToLBoundary = (u: number, v: number): number => {
      let best = Infinity;
      for (let i = 0; i < lPoly.length; i++) {
        best = Math.min(best, distToSegment({ u, v }, lPoly[i]!, lPoly[(i + 1) % lPoly.length]!));
      }
      return best;
    };
    const moves = offsetTp.points;
    const segClear = (u: number, v: number): boolean => {
      for (let i = 1; i < moves.length; i++) {
        const a = moves[i - 1]!;
        const b = moves[i]!;
        if (b.rapid) continue;
        if (distToSegment({ u, v }, { u: a.x, v: a.z }, { u: b.x, v: b.z }) <= 3 + 0.15) return true;
      }
      return false;
    };
    let covered = 0;
    let total = 0;
    for (let u = -39; u <= 39; u += 1.5) {
      for (let v = -39; v <= 39; v += 1.5) {
        if (!pointInPolygon({ u, v }, lPoly)) continue;
        if (distToLBoundary(u, v) < 3) continue; // not reachable at disc centre level
        total++;
        if (segClear(u, v)) covered++;
      }
    }
    expect(total).toBeGreaterThan(1000);
    expect(covered / total).toBeGreaterThanOrEqual(0.95);
  });

  it('clears island silhouettes with rings: wall ring CCW, island rings CW, no gouging (tube)', () => {
    // The legacy ring family refused islands; the clipper one cuts the
    // annulus directly: depth 0 = the wall ring (CCW, material outside) plus
    // the grown-island ring (CW, island material inside); deeper depths erode
    // the annulus to CW outer + CW island rings. Every cutting point must
    // also keep ≥ r from both the wall and the island (anti-gouge).
    const tube = createTube(15, 6, 20, 32);
    const small = { ...tool, diameter: 3, fluteLength: 12 };
    const tubeBounds = { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } };
    const tubeBase = { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0 };
    const off = generatePocketToolpath(
      tubeBounds, small, { ...tubeBase, pocketStrategy: 'offset' }, { body: tube },
    );
    const raster = generatePocketToolpath(tubeBounds, small, tubeBase, { body: tube });
    expect(off.cuttingMoves.length).toBeGreaterThan(0);
    expect(off.points).not.toEqual(raster.points); // rings, not the fallback

    const loops = closedLoops(off);
    expect(loops.length).toBeGreaterThanOrEqual(6); // 3 depths × (outer + island)
    const meanR = (l: DetectedLoop): number =>
      l.loop.reduce((s, p) => s + Math.hypot(p.x, p.z), 0) / l.loop.length;
    // Depth-0 wall ring: mean radius ≈ 15−1.5 = 13.5, CCW (positive area).
    const wall = loops.find((l) => Math.abs(meanR(l) - 13.5) < 0.1);
    expect(wall).toBeDefined();
    expect(wall!.area).toBeGreaterThan(0);
    // Every other loop (island rings ≈ 7.4 and deeper annulus rings ≈
    // 12.2/10.9/9.8/8.6) runs CW — negative signed area.
    for (const l of loops) {
      if (l === wall) continue;
      expect(l.area, `loop at mean radius ${meanR(l).toFixed(2)} must be CW`).toBeLessThan(0);
    }

    // Anti-gouge: every cutting point keeps ≥ r−0.03 from the silhouette's
    // outer wall and island boundary (raster stays within r+0.05 too).
    const sil = topSilhouette(tube)!;
    for (const p of off.cuttingMoves) {
      const dWall = Math.min(
        ...sil.outer.points.map((_, i) =>
          distToSegment({ u: p.x, v: p.z }, sil.outer.points[i]!, sil.outer.points[(i + 1) % sil.outer.points.length]!)),
      );
      const island = sil.islands[0]!.points;
      const dIsland = Math.min(
        ...island.map((_, i) =>
          distToSegment({ u: p.x, v: p.z }, island[i]!, island[(i + 1) % island.length]!)),
      );
      expect(dWall).toBeGreaterThanOrEqual(1.5 - 0.03);
      expect(dIsland).toBeGreaterThanOrEqual(1.5 - 0.03);
    }
    assertPlungeFeeds(off, params.plungeRate);
  });

  it('keeps the tool-too-large empty path when the cutter cannot fit', () => {
    // A 30×5 slot with a ⌀6 cutter: the 3 mm erosion empties the region, so
    // the legacy "tool too large" empty toolpath must survive the clipper
    // port. (The old symmetric-L case relied on offsetPolygon's centroid
    // guard rejecting a LEGITIMATE 40 mm L — the clipper erosion cuts that
    // one correctly now, so the regression needs a genuinely-too-large tool.)
    const slotBody = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 5 }, { x: 0, y: 0, z: 5 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 5 } },
      tool, { ...base, pocketStrategy: 'offset' }, { body: slotBody },
    );
    expect(tp.points).toEqual([]);
    // The same slot with a tool that fits is machined (sanity that the empty
    // path above is about fit, not a broken generator).
    const fits = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 5 } },
      { ...tool, diameter: 3, fluteLength: 12 }, { ...base, pocketStrategy: 'offset' }, { body: slotBody },
    );
    expect(fits.cuttingMoves.length).toBeGreaterThan(0);
  });
});

describe('generatePocketToolpath — helical entry', () => {
  // Roomy rectangle: cleared region [3,47] × [3,27] (44 × 24) fits a swept
  // disc of radius up to 12, so the helix placement succeeds. doc 3 → levels
  // [7, 4, 1, 0]; the first feed plane is stockTop + 1 = 11.
  const helixBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 0, z: 30 } };
  const spec = { ...params, depthOfCut: 3, stockTop: 10, stockBottom: 0, helixEntry: true };
  const r = tool.diameter / 2;
  const region: Point2[] = [{ u: 3, v: 3 }, { u: 47, v: 3 }, { u: 47, v: 27 }, { u: 3, v: 27 }];

  it('first entry descends along a helix and finishes with a flat true-up circle', () => {
    const tp = generatePocketToolpath(helixBounds, tool, spec);
    const helix = recoverHelixEntry(tp, 7);
    // ≥ 1 revolution of ≥ 20 polyline segments descending from the feed
    // plane, y monotone non-increasing, reaching the level exactly.
    expect(helix.revs).toBeGreaterThanOrEqual(1);
    expect(helix.descent.length).toBeGreaterThanOrEqual(20 * helix.revs);
    expect(sweptAngle([helix.preRun, ...helix.descent], helix.center))
      .toBeGreaterThanOrEqual(2 * Math.PI * helix.revs - 1e-3);
    expect(helix.preRun.y).toBeCloseTo(11, 6); // feed plane above the stock
    for (let i = 1; i < helix.descent.length; i++) {
      expect(helix.descent[i]!.y).toBeLessThanOrEqual(helix.descent[i - 1]!.y + 1e-12);
    }
    expect(helix.descent[helix.descent.length - 1]!.y).toBeCloseTo(7, 9);
    // Helix radius within the planned envelope [0.05r, 0.9r].
    expect(helix.radius).toBeGreaterThan(0.05 * r);
    expect(helix.radius).toBeLessThanOrEqual(0.9 * r + 1e-9);
    // One full flat revolution at the level follows (Fusion-style true-up).
    expect(helix.flat.length).toBeGreaterThanOrEqual(20);
    for (const p of helix.flat) expect(p.y).toBeCloseTo(7, 9);
    expect(sweptAngle([helix.descent[helix.descent.length - 1]!, ...helix.flat], helix.center))
      .toBeGreaterThanOrEqual(2 * Math.PI - 1e-3);
    // The true-up exit continues straight into the first row — no retract:
    // the next cut lands on the row start (u = 3, first row v ≈ 3).
    const runStart = tp.points.findIndex((p) => !p.rapid);
    const after = tp.points[runStart + helix.descent.length + helix.flat.length]!;
    expect(after.y).toBeCloseTo(7, 9);
    expect(after.x).toBeCloseTo(3, 6);
    expect(after.z).toBeGreaterThanOrEqual(3);
    expect(after.z).toBeLessThanOrEqual(3.01);
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('the swept entry disc stays inside the cleared region', () => {
    const tp = generatePocketToolpath(helixBounds, tool, spec);
    const helix = recoverHelixEntry(tp, 7);
    const R = r + helix.radius;
    // Disc-safety reconstruction: 16 samples on the swept-disc circle all
    // fall inside the cleared region.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      expect(pointInPolygon({ u: helix.center.u + Math.cos(a) * R, v: helix.center.v + Math.sin(a) * R }, region)).toBe(true);
    }
    // Exact for the axis-aligned region: the disc is inside iff its axis
    // extremes clear the four walls.
    expect(helix.center.u - R).toBeGreaterThanOrEqual(3 - 1e-6);
    expect(helix.center.u + R).toBeLessThanOrEqual(47 + 1e-6);
    expect(helix.center.v - R).toBeGreaterThanOrEqual(3 - 1e-6);
    expect(helix.center.v + R).toBeLessThanOrEqual(27 + 1e-6);
  });

  it('offset strategy enters through the helix, then cuts the wall ring CW', () => {
    const body = createBox(50, 10, 30);
    const tp = generatePocketToolpath(
      { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } },
      tool,
      { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0, pocketStrategy: 'offset', helixEntry: true },
      { body },
    );
    const helix = recoverHelixEntry(tp, 0);
    expect(helix.revs).toBeGreaterThanOrEqual(1);
    expect(helix.descent.length).toBeGreaterThanOrEqual(20 * helix.revs);
    expect(helix.flat.length).toBeGreaterThanOrEqual(20);
    // Swept disc inside the 44 × 24 cleared region.
    const R = r + helix.radius;
    expect(helix.center.u - R).toBeGreaterThanOrEqual(-22 - 1e-6);
    expect(helix.center.u + R).toBeLessThanOrEqual(22 + 1e-6);
    expect(helix.center.v - R).toBeGreaterThanOrEqual(-12 - 1e-6);
    expect(helix.center.v + R).toBeLessThanOrEqual(12 + 1e-6);
    // The wall ring still runs first (CCW — climb on the wall side) with its
    // usual start vertex.
    const wall = closedLoops(tp).find((l) => Math.abs(l.area - 44 * 24) < 1e-6);
    expect(wall).toBeDefined();
    expect(wall!.start.u).toBeCloseTo(-22, 6);
    expect(wall!.start.v).toBeCloseTo(-12, 6);
  });

  it('offset strategy helixes into an ISLAND annulus too (multi-candidate nominal)', () => {
    // The tube pocket: the legacy nominal (ringPaths[1] = the grown-island
    // ring start) marches from the island boundary straight across the
    // island toward the outer centroid — every candidate disc overlaps the
    // island, helixRadiusAt stays null and the entry silently degraded to
    // the linear ramp. The nominal is now searched over the seed ring's
    // quartile starts plus each component's max-inscribed-circle centre, so
    // the annulus gets a true helix in the free gap.
    const tube = createTube(15, 6, 20, 32);
    const small = { ...tool, diameter: 3, fluteLength: 12 };
    const tubeSpec = {
      ...params, depthOfCut: 2, stockTop: 20, stockBottom: 0,
      pocketStrategy: 'offset' as const, helixEntry: true,
    };
    const bounds = { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } };
    const tp = generatePocketToolpath(bounds, small, tubeSpec, { body: tube });
    const helix = recoverHelixEntry(tp, 18);
    expect(helix.revs).toBeGreaterThanOrEqual(1);
    expect(helix.descent.length).toBeGreaterThanOrEqual(20 * helix.revs);
    expect(helix.flat.length).toBeGreaterThanOrEqual(20);
    for (const p of helix.flat) expect(p.y).toBeCloseTo(18, 9);
    // The swept disc (radius r + ρ) fits the annular cleared region exactly:
    // outer 15 − 1.5 = 13.5, island grown 6 + 1.5 = 7.5.
    const R = 1.5 + helix.radius;
    const cd = Math.hypot(helix.center.u, helix.center.v);
    expect(cd - R).toBeGreaterThanOrEqual(7.5 - 1e-6);
    expect(cd + R).toBeLessThanOrEqual(13.5 + 1e-6);
    assertPlungeFeeds(tp, params.plungeRate);
    // Deterministic: a second run plans the identical points.
    const again = generatePocketToolpath(bounds, small, tubeSpec, { body: tube });
    expect(again.points).toEqual(tp.points);
  });

  it('falls back to the legacy linear ramp when the disc cannot fit (narrow slot)', () => {
    const body = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 8 }, { x: 0, y: 0, z: 8 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 8 } };
    // Cleared region only 2 mm tall — no disc of radius ≥ 3.15 fits.
    const slotBase = { ...params, depthOfCut: 2, stockTop: 10, stockBottom: 0 };
    const helix = generatePocketToolpath(bounds, tool, { ...slotBase, helixEntry: true }, { body });
    const legacy = generatePocketToolpath(bounds, tool, slotBase, { body });
    expect(helix.points).toEqual(legacy.points);
    // …and the legacy first cut is the diagonal ramp descent.
    const i = helix.points.findIndex((p) => !p.rapid);
    const a = helix.points[i - 1]!;
    const b = helix.points[i]!;
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(1);
    expect(b.y).toBeLessThan(a.y);
  });

  it('falls back when the descent would need more than three revolutions', () => {
    // 20×14 pocket → region 14×8 → best disc radius 4 → ρ = 1 → pitch
    // 2π·tan15° ≈ 1.68 mm/rev; the 11 mm first-level descent needs 7 revs.
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 0, z: 14 } };
    const capBase = { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 };
    const helix = generatePocketToolpath(bounds, tool, { ...capBase, helixEntry: true });
    const legacy = generatePocketToolpath(bounds, tool, capBase);
    expect(helix.points).toEqual(legacy.points);
  });
});

describe('generatePocketToolpath — wall finish pass', () => {
  it('raster: after clearing, adds a CCW boundary loop and CW island loops', () => {
    const tube = createTube(15, 6, 20, 32);
    const small = { ...tool, diameter: 3, fluteLength: 12 };
    const tp = generatePocketToolpath(
      { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } },
      small,
      { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0, wallFinishPass: true },
      { body: tube },
    );
    const loops = closedLoops(tp);
    // Raster rows never close; only the finish loops appear. Outer wall loop
    // at radius 15 − 1.5 = 13.5 (CCW: material outside the loop sits on the
    // right under climb), island loop at 6 + 1.5 = 7.5 (CW: material inside
    // the grown island sits on the right).
    const meanR = (l: DetectedLoop): number =>
      l.loop.reduce((s, p) => s + Math.hypot(p.x, p.z), 0) / l.loop.length;
    const wall = loops.filter((l) => Math.abs(meanR(l) - 13.5) < 0.1);
    const island = loops.filter((l) => Math.abs(meanR(l) - 7.5) < 0.1);
    expect(wall).toHaveLength(1); // one level
    expect(wall[0]!.area).toBeGreaterThan(0);
    expect(island).toHaveLength(1);
    expect(island[0]!.area).toBeLessThan(0);
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('offset: walks the wall ring twice per level (spring-pass semantics)', () => {
    const body = createBox(50, 10, 30);
    const tp = generatePocketToolpath(
      { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } },
      tool,
      { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0, pocketStrategy: 'offset', wallFinishPass: true },
      { body },
    );
    const loops = closedLoops(tp);
    // Five clearing rings + one finish re-cut of the wall ring.
    expect(loops).toHaveLength(6);
    const atWallStart = loops.filter(
      (l) => Math.abs(l.start.u + 22) < 1e-6 && Math.abs(l.start.v + 12) < 1e-6,
    );
    expect(atWallStart).toHaveLength(2);
    for (const l of atWallStart) expect(l.area).toBeGreaterThan(0); // both CCW
  });

  it('wallFinishPass:false equals the legacy output', () => {
    const body = createBox(50, 10, 30);
    const b = { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 };
    const bounds = { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } };
    const off = generatePocketToolpath(bounds, tool, { ...b, wallFinishPass: false }, { body });
    const plain = generatePocketToolpath(bounds, tool, b, { body });
    expect(off.points).toEqual(plain.points);
  });
});

describe('generateFaceToolpath — helical entry', () => {
  it('replaces the first-row ramp with a helix + true-up, then cuts the row', () => {
    const tp = generateFaceToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 10, z: 20 } },
      tool,
      { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0, helixEntry: true },
    );
    const helix = recoverHelixEntry(tp, 0);
    expect(helix.revs).toBeGreaterThanOrEqual(1);
    expect(helix.revs).toBeLessThanOrEqual(3); // the revolution cap
    expect(helix.descent.length).toBeGreaterThanOrEqual(20 * helix.revs);
    expect(sweptAngle([helix.preRun, ...helix.descent], helix.center))
      .toBeGreaterThanOrEqual(2 * Math.PI * helix.revs - 1e-3);
    expect(helix.flat.length).toBeGreaterThanOrEqual(20);
    for (const p of helix.flat) expect(p.y).toBeCloseTo(0, 9);
    // The true-up exit cuts back to the first row start (uMin = −6) and the
    // row itself follows without a retract.
    const runStart = tp.points.findIndex((p) => !p.rapid);
    const after = tp.points[runStart + helix.descent.length + helix.flat.length]!;
    expect(after.y).toBeCloseTo(0, 9);
    expect(after.x).toBeCloseTo(-tool.diameter, 6);
    expect(after.z).toBeCloseTo(0, 6);
    assertPlungeFeeds(tp, params.plungeRate);
  });
});

describe('new CAM parameters default to the legacy output', () => {
  it('explicit legacy values reproduce the defaults byte-for-byte', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 0, z: 10 } };
    const base = { ...params, depthOfCut: 2, stockTop: 10, stockBottom: 0 };
    const legacy = generatePocketToolpath(bounds, tool, base);
    const explicit = generatePocketToolpath(bounds, tool, {
      ...base,
      pocketStrategy: 'raster',
      helixEntry: false,
      wallFinishPass: false,
    });
    expect(explicit.points).toEqual(legacy.points);

    const faceBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 10, z: 20 } };
    const faceLegacy = generateFaceToolpath(faceBounds, tool, base);
    const faceExplicit = generateFaceToolpath(faceBounds, tool, { ...base, helixEntry: false });
    expect(faceExplicit.points).toEqual(faceLegacy.points);

    // Drill contract fields are type-only today: generation ignores them.
    const drillLegacy = generateDrillToolpath([{ x: 1, z: 1, depth: 2 }], tool, base);
    const drillExplicit = generateDrillToolpath(
      [{ x: 1, z: 1, depth: 2 }],
      tool,
      { ...base, drillCycle: 'simple', dwellSeconds: 2 },
    );
    expect(drillExplicit.points).toEqual(drillLegacy.points);
  });
});

// ---------------------------------------------------------------------------
// True arcs from analytic cylinder tags (P2b): the contour generator recovers
// G2/G3 geometry straight from Face.source cylinder tags instead of letting
// the post re-fit the discretized polyline. Bodies come from the tagged
// builder in arcSources.test.ts (brep primitives never tag — that is the
// production split the module exists for).
// ---------------------------------------------------------------------------

describe('generateContourToolpath — true arcs (analytic cylinder tags)', () => {
  // ⌀20 tagged boss, 55-gon wall → tool-centre circle r = 10 + 3 = 13.
  const boss = taggedCylinderBody(10, 20, 55);
  const spec = { ...params, depthOfCut: 20, stockTop: 20, stockBottom: 0 };

  /** Sweep (rad, positive) of one arcTo move, from its endpoints. */
  const arcSweepOf = (a: ToolpathPoint, b: ToolpathPoint): number => {
    const c = b.arcTo!.center;
    const a0 = Math.atan2(a.z - c.z, a.x - c.x);
    const a1 = Math.atan2(b.z - c.z, b.x - c.x);
    let d = b.arcTo!.ccw ? a1 - a0 : a0 - a1;
    d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return d;
  };

  it('full circle becomes three 120° arcs at the exact analytic radius', () => {
    const tp = generateContourToolpath(boss, tool, spec);
    const arcs: Array<[ToolpathPoint, ToolpathPoint]> = [];
    for (let i = 1; i < tp.points.length; i++) {
      if (tp.points[i]!.arcTo) arcs.push([tp.points[i - 1]!, tp.points[i]!]);
    }
    expect(arcs).toHaveLength(3);
    let total = 0;
    for (const [a, b] of arcs) {
      // True arcs do not survive on decimal luck: endpoints sit on the
      // analytic circle to float exactness (contrast the fitted path's
      // 4-decimal G-code constraint).
      const ca = b.arcTo!.center;
      const rStart = Math.hypot(a.x - ca.x, a.z - ca.z);
      const rEnd = Math.hypot(b.x - ca.x, b.z - ca.z);
      expect(Math.abs(rStart - 13)).toBeLessThan(1e-9);
      expect(Math.abs(rEnd - 13)).toBeLessThan(1e-9);
      expect(Math.abs(rStart - rEnd)).toBeLessThan(1e-9);
      expect(b.arcTo!.ccw).toBe(false); // climb outer loop runs CW
      const sweep = arcSweepOf(a, b);
      expect(sweep).toBeCloseTo((120 * Math.PI) / 180, 6);
      total += sweep;
    }
    expect(total).toBeCloseTo(2 * Math.PI, 6);
    // The layer collapsed: plunge + 3 arcs, nothing else.
    expect(tp.cuttingMoves).toHaveLength(4);
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('conventional flips the arc direction, not the geometry', () => {
    const tp = generateContourToolpath(boss, tool, { ...spec, direction: 'conventional' });
    const tagged = tp.points.filter((p) => p.arcTo);
    expect(tagged).toHaveLength(3);
    for (const p of tagged) expect(p.arcTo!.ccw).toBe(true); // CCW loop now
    expect(Math.hypot(tagged[0]!.x, tagged[0]!.z)).toBeCloseTo(13, 9);
  });

  it('tube: outer arcs at wall r + offset (G2 side), island arcs at r − offset (G3 side)', () => {
    const tube = taggedCylinderBody(15, 20, 48, { innerRadius: 6 });
    const tp = generateContourToolpath(tube, tool, spec);
    const arcs: Array<[ToolpathPoint, ToolpathPoint]> = [];
    for (let i = 1; i < tp.points.length; i++) {
      if (tp.points[i]!.arcTo) arcs.push([tp.points[i - 1]!, tp.points[i]!]);
    }
    expect(arcs).toHaveLength(6); // 3 outer + 3 island
    const radiusOf = (ab: [ToolpathPoint, ToolpathPoint]): number =>
      Math.hypot(ab[0]!.x - ab[1]!.arcTo!.center.x, ab[0]!.z - ab[1]!.arcTo!.center.z);
    const outer = arcs.filter((ab) => radiusOf(ab) > 10);
    const island = arcs.filter((ab) => radiusOf(ab) < 10);
    expect(outer).toHaveLength(3);
    expect(island).toHaveLength(3);
    for (const ab of outer) {
      expect(radiusOf(ab)).toBeCloseTo(15 + 3, 9);
      expect(ab[1]!.arcTo!.ccw).toBe(false); // climb outer = CW
    }
    for (const ab of island) {
      expect(radiusOf(ab)).toBeCloseTo(6 - 3, 9);
      expect(ab[1]!.arcTo!.ccw).toBe(true); // climb island = CCW
    }
  });

  it('tabs split the arcs: no arc spans a lift, flat stretches stay arcs', () => {
    const tp = generateContourToolpath(boss, tool, {
      ...spec, depthOfCut: 10, tabs: { count: 2, height: 2, width: 6 },
    });
    expect(tp.cuttingMoves.length).toBeGreaterThan(4); // tab flanks survive
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (b.arcTo) {
        expect(Math.abs(b.y - a.y), 'an arc must never span a height change').toBeLessThanOrEqual(1e-9);
        expect(Math.hypot(b.x - b.arcTo!.center.x, b.z - b.arcTo!.center.z)).toBeCloseTo(13, 9);
      }
    }
    // Both levels ride arcs where flat (level 1 clears the tab top at 2.0).
    const arcsPerLevel = [10, 0].map((yLevel) =>
      tp.points.filter((p) => p.arcTo && Math.abs(p.y - yLevel) < 1e-9).length);
    expect(arcsPerLevel[0]).toBeGreaterThanOrEqual(3);
    expect(arcsPerLevel[1]).toBeGreaterThanOrEqual(2); // tab gaps eat some
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('ramp entry descends ON the circle with straight moves; the flat remainder is arcs', () => {
    const tp = generateContourToolpath(boss, tool, { ...spec, depthOfCut: 10, rampEntry: true });
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (b.rapid) continue;
      // Every cutting point rides the analytic circle…
      expect(Math.abs(Math.hypot(b.x, b.z) - 13)).toBeLessThan(1e-6);
      // …and descending moves (the ramp helix) are straight — the flat-only
      // G2/G3 contract cannot express them.
      if (Math.abs(b.y - a.y) > 1e-9) expect(b.arcTo).toBeUndefined();
    }
    expect(tp.points.filter((p) => p.arcTo).length).toBeGreaterThanOrEqual(3);
    assertPlungeFeeds(tp, params.plungeRate);
  });

  it('spring pass re-rides the circle: six arcs at the final depth', () => {
    const tp = generateContourToolpath(boss, tool, { ...spec, springPass: true });
    const tagged = tp.points.filter((p) => p.arcTo);
    expect(tagged).toHaveLength(6); // two revolutions × 3 arcs
  });

  it('untagged walls keep the pure polyline output (no arcTo anywhere)', () => {
    const plain = taggedCylinderBody(10, 20, 55, { tagWalls: false });
    const tp = generateContourToolpath(plain, tool, spec);
    expect(tp.points.some((p) => p.arcTo)).toBe(false);
    expect(tp.cuttingMoves.length).toBeGreaterThan(30); // the 55-gon polyline
  });
});
