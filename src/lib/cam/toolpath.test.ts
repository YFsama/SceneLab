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
import type { ToolDefinition, CAMParameters, Toolpath, ToolpathPoint } from './types';
import { polygonArea, topSilhouette, offsetPolygon } from './silhouette';

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
    // ⌀3 cutter: the grown keep-out is u∈[22.5,26.1]. When a row splits into
    // [3·,22.5] and [26.1,·] the interval directions alternate, so the link
    // chord runs from one interval's far end (u=48.5) BACK ACROSS the slot —
    // the island sits in the first tenth of the chord where the t=.25/.5/.75
    // samples never look, and the cutter gouged straight through the wall
    // (pass-30 P3 T2).
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

    // Keep-out interior (grown island shrunk 0.01 so rows ENDING exactly on
    // its boundary — the legitimate scanline edge — do not count as entry).
    const box = { minU: 22.51, maxU: 26.09, minV: 0.51, maxV: 9.49 };
    const segEntersBox = (a: { x: number; z: number }, b: { x: number; z: number }): boolean => {
      let t0 = 0;
      let t1 = 1;
      const clip = (p: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-12) return p > lo && p < hi;
        let tn = (lo - p) / d;
        let tf = (hi - p) / d;
        if (tn > tf) { const tmp = tn; tn = tf; tf = tmp; }
        t0 = Math.max(t0, tn);
        t1 = Math.min(t1, tf);
        return t0 <= t1;
      };
      return clip(a.x, b.x - a.x, box.minU, box.maxU) && clip(a.z, b.z - a.z, box.minV, box.maxV);
    };
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (b.rapid) continue;
      if (a.y > 0.5 || b.y > 0.5) continue; // depth cuts only
      expect(
        segEntersBox(a, b),
        `gouging link (${a.x.toFixed(2)},${a.z.toFixed(2)}) → (${b.x.toFixed(2)},${b.z.toFixed(2)}) crosses the island keep-out`,
      ).toBe(false);
    }
    // The detour actually happens: crossing rows retract (the unlinked path
    // has strictly more rapids than the same pocket without the slot).
    const plain = generatePocketToolpath(pocketBounds, { ...tool, diameter: 3, fluteLength: 12 }, {
      ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0,
    });
    expect(tp.rapidMoves.length).toBeGreaterThan(plain.rapidMoves.length);
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
  // radius. With a true MITER offset the polygon EDGES sit exactly 3 mm off
  // the 32-gon's flats and the vertices overshoot slightly
  // (apothem'/cos(π/32) ≈ 18.015) — both directions safe for the wall.
  it('cylinder contour is a 32-gon offset by the cutter radius', () => {
    const body = createCylinder(15, 20, 32);
    const tp = generateContourToolpath(body, tool, {
      ...params,
      depthOfCut: 20,
      stockTop: 20,
      stockBottom: 0,
    });
    const offset = tool.diameter / 2;
    const distinct = new Set(tp.cuttingMoves.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`));
    expect(distinct.size).toBe(32);
    for (const p of tp.cuttingMoves) {
      expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(15 + offset - 0.01);
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(15 + offset + 0.02);
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
    // True miter: every offset EDGE lies exactly r outside a wall — the path
    // rectangle is (25+r) × (15+r) and the corners are mitered out to
    // r·√2 diagonally. (The old normalized-bisector version left the edges
    // only r·cos45° out — a 0.88 mm gouge into every wall this test used
    // to bless.)
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
  it('default/climb mills the outer loop CCW; conventional reverses it CW', () => {
    const body = createBox(50, 10, 30);
    const base = { ...params, depthOfCut: 10, stockTop: 10, stockBottom: 0 };
    const climb = generateContourToolpath(body, tool, base);
    const conv = generateContourToolpath(body, tool, { ...base, direction: 'conventional' });
    const aC = runArea(contourRuns(climb)[0]!);
    const aV = runArea(contourRuns(conv)[0]!);
    // M3 climb ⇔ material on the left of travel: outside the part that is a
    // CCW outer loop (positive shoelace area), mirrored for conventional.
    expect(aC).toBeGreaterThan(0);
    expect(aV).toBeLessThan(0);
    // Same offset rectangle either way: (50 + 2r) × (30 + 2r), same start.
    expect(Math.abs(aC)).toBeCloseTo(56 * 36, 1);
    expect(aC).toBeCloseTo(-aV, 6);
    expect(contourRuns(conv)[0]![0]!.x).toBeCloseTo(contourRuns(climb)[0]![0]!.x, 6);
    expect(contourRuns(conv)[0]![0]!.z).toBeCloseTo(contourRuns(climb)[0]![0]!.z, 6);
  });

  it('climb mills island loops CW; conventional CCW (tube through-hole)', () => {
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
    // Material lies OUTSIDE an island loop, so climb keeps it on the left by
    // running the loop clockwise (negative area).
    expect(classify(climb).outer).toBeGreaterThan(0);
    expect(classify(climb).island).toBeLessThan(0);
    expect(classify(conv).outer).toBeLessThan(0);
    expect(classify(conv).island).toBeGreaterThan(0);
  });
});

describe('generateContourToolpath — holding tabs', () => {
  // Box 50×10×30 → offset rectangle 56 × 36 (perimeter 184, 4 vertices);
  // levels [8,6,4,2,0] with depthOfCut 2, final level 0, tabTop = 0 + 3.
  const box = createBox(50, 10, 30);
  const base = { ...params, depthOfCut: 2, stockTop: 10, stockBottom: 0 };
  const tabs = { count: 2, height: 3, width: 6 };

  /** True when (x, z) lies on the 56 × 36 offset rectangle boundary. */
  const onOffsetRect = (x: number, z: number): boolean => {
    const onV = Math.abs(Math.abs(x) - 28) < 1e-6 && Math.abs(z) <= 18 + 1e-6;
    const onH = Math.abs(Math.abs(z) - 18) < 1e-6 && Math.abs(x) <= 28 + 1e-6;
    return onV || onH;
  };

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
    // …centred evenly by arc length (perimeter 184 → 92 apart)…
    const centers = spans.map(([s0, s1]) => (s0 + s1) / 2).sort((a, b) => a - b);
    expect(centers[1]! - centers[0]!).toBeCloseTo(92, 6);

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
    // sit half a spacing away from it); with count 3 / width 64 on the 184 mm
    // loop the tabs overlap and must merge into one continuous ride.
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
    expect(planarArc(p[0]!)).toBeCloseTo(184, 6); // one revolution = perimeter
    expect(planarArc(s[0]!)).toBeCloseTo(184, 6); // non-final level unchanged
    expect(planarArc(s[1]!)).toBeCloseTo(2 * 184, 6); // final level: two revolutions
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
  const onOffsetRect = (x: number, z: number): boolean => {
    const onV = Math.abs(Math.abs(x) - 28) < 1e-6 && Math.abs(z) <= 18 + 1e-6;
    const onH = Math.abs(Math.abs(z) - 18) < 1e-6 && Math.abs(x) <= 28 + 1e-6;
    return onV || onH;
  };

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
    // Classic structure: plunge + 3 vertex cuts + closure, one run.
    expect(contourRuns(tp)).toHaveLength(1);
    expect(tp.cuttingMoves).toHaveLength(5);
  });
});

describe('generateContourToolpath — review pass #33 regressions', () => {
  it('single-level ramp entry re-cuts the entry wedge at full depth', () => {
    // One depth level only: the ramp covers [0, rampLen] and the revolution
    // [rampLen, L], so without a closing re-cut of the entry span the part
    // would stay attached to the stock by the ramp wedge — the exact failure
    // mode holding tabs exist to prevent.
    const body = createBox(50, 10, 30); // offset loop = mitered rect ±28/±18, L = 184
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
    expect(covered).toBeGreaterThanOrEqual(184 - 1e-6);
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
    const rampLen = Math.min(Math.max(2 * tool.diameter, 10 / Math.tan((15 * Math.PI) / 180)), 184);
    expect(springCovered).toBeCloseTo(2 * 184 - rampLen, 6);
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

    // Offset loop for XY → arc-length mapping (mitered rect, straight edges:
    // consecutive emitted stops never straddle a corner, so arc-length lerp
    // between them is exact).
    const sil = topSilhouette(body);
    expect(sil).not.toBeNull();
    const path = offsetPolygon(sil!.outer.points, tool.diameter / 2);
    expect(path).not.toBeNull();
    const loop = path!;
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
    const feedPlane = spec.stockTop + 1;
    const rampLen = Math.min(Math.max(2 * tool.diameter, spec.stockTop / Math.tan((15 * Math.PI) / 180)), L);
    const tabTop = spec.tabs.height;
    const tabRamp = Math.min(spec.tabs.width * 0.4, 2);
    const centers = Array.from({ length: spec.tabs.count }, (_, i) => ((i + 0.5) * L) / spec.tabs.count);
    const env = (s: number): number => {
      let y = s <= rampLen + 1e-9 ? feedPlane + (0 - feedPlane) * (s / rampLen) : 0;
      for (const c of centers) {
        const lo = c - spec.tabs.width / 2;
        const hi = c + spec.tabs.width / 2;
        if (s < lo - 1e-12 || s > hi + 1e-12) continue;
        const local =
          s <= lo + tabRamp
            ? (tabTop * (s - lo)) / tabRamp
            : s < hi - tabRamp
              ? tabTop
              : tabTop * (1 - (s - (hi - tabRamp)) / tabRamp);
        y = Math.max(y, local);
      }
      return y;
    };

    const run = contourRuns(tp)[0]!;
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1]!;
      const b = run[i]!;
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
