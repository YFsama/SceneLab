import { describe, it, expect } from 'vitest';
import {
  generatePocketToolpath,
  generateContourToolpath,
  generateDrillToolpath,
  generateFaceToolpath,
} from './toolpath';
import { estimateMachiningTime } from './gcode';
import { createBox, createCylinder, createTube } from '../geometry/brep';
import type { ToolDefinition, CAMParameters, Toolpath, ToolpathPoint } from './types';

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

describe('generatePocketToolpath', () => {
  const pocketBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 0, z: 10 } };

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
