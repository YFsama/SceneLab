import { describe, it, expect, beforeAll } from 'vitest';
import { generatePocketToolpath } from './toolpath';
import { planAdaptiveClearing } from './trochoid';
import { fitArcs } from './arcFit';
import { offsetRegion, type RegionComponent } from './offsetRegion';
import { createBox, createTube, createExtrude } from '../geometry/brep';
import { booleanOpManifold, warmUpBooleanEngine } from '../geometry/booleanManifold';
import { translateBody } from '../geometry/operations';
import { topSilhouette, pointInPolygon, type Point2 } from './silhouette';
import type { SolidBody } from '../geometry/types';
import type { ToolDefinition, CAMParameters, Toolpath } from './types';

/**
 * Adaptive (trochoidal) clearing golden samples. The three measured
 * invariants (per docs/cnc-algorithms.md §1.5 "测试策略"):
 *
 * - NO GOUGE: the swept cutter disc never leaves the machinable pocket. Two
 *   complementary checks: every cutting point/segment-sample keeps ≥ r − 0.03
 *   from the silhouette's outer wall and island boundaries (the 0.03 covers
 *   clipper's arcTolerance chords), and the grid estimator below flags any
 *   swept cell that lies outside the material by more than a boundary fringe.
 * - ENGAGEMENT: for every constant-depth cut move, the newly-swept material
 *   area per mm of travel ("ae_eq", the FreeCAD cutAreaPerDist criterion)
 *   mapped through the doc's crescent equivalence φ = 2·asin(ae/D). The max
 *   over all moves must stay ≤ target × 1.2.
 * - ARC RATIO: after fitArcs, G2/G3 moves must dominate (> 60% of cutting
 *   moves) — trochoid orbits are circles, so the wide-zone chains carry it.
 */

const tool6: ToolDefinition = {
  id: 'em-6mm', name: '6mm Endmill', diameter: 6, flutes: 2, type: 'endmill',
  fluteLength: 20, overallLength: 50, material: 'carbide',
};
const tool3: ToolDefinition = {
  id: 'em-3mm', name: '3mm Endmill', diameter: 3, flutes: 2, type: 'endmill',
  fluteLength: 12, overallLength: 50, material: 'carbide',
};

/**
 * CCW union outline of two equal circles (a dumbbell): the left circle's
 * major arc from the upper intersection point around the left side, closed
 * by the right circle's major arc. c < R (circles overlap; the neck width
 * is 2√(R²−c²)).
 */
function dumbbellProfile(c: number, R: number, seg: number): Array<{ x: number; y: number; z: number }> {
  const y = Math.sqrt(R * R - c * c);
  const a0 = Math.atan2(y, c);
  const pts: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((2 * Math.PI - 2 * a0) * i) / seg;
    pts.push({ x: -c + R * Math.cos(a), y: 0, z: R * Math.sin(a) });
  }
  const b0 = Math.atan2(-y, -c);
  for (let i = 0; i <= seg; i++) {
    const a = b0 + ((2 * Math.PI - 2 * a0) * i) / seg;
    pts.push({ x: c + R * Math.cos(a), y: 0, z: R * Math.sin(a) });
  }
  return pts;
}

const base: CAMParameters = {
  feedRate: 1000, plungeRate: 500, spindleSpeed: 10000,
  depthOfCut: 10, stepover: 3, stockTop: 10, stockBottom: 0,
  pocketStrategy: 'adaptive', helixEntry: true,
};

function distToSegment(p: Point2, a: Point2, b: Point2): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
  return Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv));
}

function distToLoop(p: Point2, loop: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    best = Math.min(best, distToSegment(p, loop[i]!, loop[(i + 1) % loop.length]!));
  }
  return best;
}

/** Min distance from any cutting position (points + segment quarter
 * samples) to the pocket walls — the anti-gouge margin. */
function minWallMargin(tp: Toolpath, sil: NonNullable<ReturnType<typeof topSilhouette>>): number {
  let worst = Infinity;
  const loops = [sil.outer.points, ...sil.islands.map((i) => i.points)];
  const check = (p: Point2): void => {
    for (const loop of loops) worst = Math.min(worst, distToLoop(p, loop));
  };
  for (let i = 1; i < tp.points.length; i++) {
    const a = tp.points[i - 1]!;
    const b = tp.points[i]!;
    if (b.rapid) continue;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      check({ u: a.x + (b.x - a.x) * t, v: a.z + (b.z - a.z) * t });
    }
  }
  return worst;
}

interface SweepReport {
  /** Max engagement over all constant-depth cut moves (degrees). */
  maxEngagementDeg: number;
  /** Swept / reachable material cells (the coverage sanity). */
  coverage: number;
  /** Swept cells outside the material beyond the boundary fringe — must be 0. */
  gougeCells: number;
  cuttingMoves: number;
  /** Vertical plunges whose disc lands in virgin material (fresh cells above
   * grid noise) — bare full-engagement entries (P1-1). Must be 0 except in
   * the documented narrow-zone fallback. */
  barePlunges: number;
  /** Debug: the highest-engagement flat moves (worst first). */
  worst: Array<{ i: number; ax: number; az: number; ay: number; bx: number; bz: number; ae: number; len: number }>;
}

/** Engagement is scored per sliding window of cutting travel — one full
 * revolution of the tool centre around its FLOOR orbit radius
 * (2π·max(0.5 mm, 0.15·D), the doc §1.6 orbit floor). FreeCAD's
 * cutAreaPerDist criterion is sampled at path steps of the same scale; a
 * per-polyline-segment reading conflates bite DIRECTION with bite DEPTH (a
 * move crossing the swept front perpendicular claims its whole chord width
 * even when the radial bite is one stepover deep), so the chip load is
 * integrated over one revolution instead. */

/**
 * Grid swept-disc estimator: rasterize the pocket material at `res`, walk
 * the toolpath in emission order stamping cutter discs (constant-depth cut
 * moves only — descent entries are covered by the dedicated helix asserts),
 * and measure newly-claimed material area per revolution-window of
 * travel. Non-material cells swept beyond a 0.25 mm boundary fringe are
 * gouges; material cells no disc can reach (sharp outer corners, computed
 * from the eroded tool-centre domain) are excluded from the coverage
 * denominator.
 */
function sweepToolpath(
  tp: Toolpath,
  sil: NonNullable<ReturnType<typeof topSilhouette>>,
  diameter: number,
  res = 0.2,
): SweepReport {
  const r = diameter / 2;
  const windowMm = 2 * Math.PI * Math.max(0.5, 0.15 * diameter);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of sil.outer.points) {
    minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
    minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
  }
  const pad = r + 1;
  minU -= pad; maxU += pad; minV -= pad; maxV += pad;
  const nx = Math.ceil((maxU - minU) / res) + 1;
  const ny = Math.ceil((maxV - minV) / res) + 1;
  const cell = (i: number, j: number): Point2 => ({ u: minU + i * res, v: minV + j * res });
  const idx = (i: number, j: number): number => j * nx + i;

  // Material mask + reachability (via the tool-centre domain, the same
  // offsetRegion the generator uses).
  const domains: RegionComponent[] = offsetRegion(
    sil.outer.points, sil.islands.map((l) => l.points), -r,
  );
  const distToDomain = (p: Point2): number => {
    let best = Infinity;
    for (const comp of domains) {
      let d: number;
      if (pointInPolygon(p, comp.outer) && !comp.holes.some((h) => pointInPolygon(p, h))) {
        d = 0;
      } else {
        let e = distToLoop(p, comp.outer);
        for (const h of comp.holes) e = Math.min(e, distToLoop(p, h));
        d = e;
      }
      best = Math.min(best, d);
    }
    return best;
  };

  const material = new Uint8Array(nx * ny); // 1 = pocket material
  const reachable = new Uint8Array(nx * ny); // material a disc centre can sweep
  let reachableTotal = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = cell(i, j);
      if (!pointInPolygon(p, sil.outer.points)) continue;
      if (sil.islands.some((isl) => pointInPolygon(p, isl.points))) continue;
      material[idx(i, j)] = 1;
      if (distToDomain(p) <= r - 0.05) {
        reachable[idx(i, j)] = 1;
        reachableTotal++;
      }
    }
  }

  const swept = new Uint8Array(nx * ny); // claimed by a cutting disc
  const outside = new Uint8Array(nx * ny); // claimed while off-material
  const nr = Math.ceil(r / res);
  let cuttingMoves = 0;
  let maxEngagement = 0;
  let barePlunges = 0;
  const worst: Array<{ i: number; ax: number; az: number; ay: number; bx: number; bz: number; ae: number; len: number }> = [];
  // Flat-cut segments on the travel axis for the windowed score.
  const flatSegs: Array<{ end: number; fresh: number; i: number; ax: number; az: number; ay: number; bx: number; bz: number; len: number }> = [];
  let travel = 0;

  const stampDisc = (cx: number, cv: number, tally: { fresh: number }): void => {
    const i0 = Math.round((cx - minU) / res);
    const j0 = Math.round((cv - minV) / res);
    for (let dj = -nr; dj <= nr; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= ny) continue;
      const diMax = Math.floor(Math.sqrt(Math.max(0, nr * nr - dj * dj)));
      for (let di = -diMax; di <= diMax; di++) {
        const i = i0 + di;
        if (i < 0 || i >= nx) continue;
        const k = idx(i, j);
        if (swept[k]) continue;
        // Exact disc test on the cell centre (the integer ring is just a BBox).
        if (Math.hypot(minU + i * res - cx, minV + j * res - cv) > r) continue;
        swept[k] = 1;
        if (material[k]) tally.fresh++;
        else outside[k] = 1;
      }
    }
  };

  for (let i = 1; i < tp.points.length; i++) {
    const a = tp.points[i - 1]!;
    const b = tp.points[i]!;
    if (b.rapid) continue;
    cuttingMoves++;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const depthMove = Math.abs(b.y - a.y) > 1e-9;
    const verticalPlunge = len <= 1e-9 && depthMove;
    // Sample the plunge-centre cell BEFORE this move's own stamps claim it.
    let plungeCentreVirgin = false;
    if (verticalPlunge) {
      const ci = Math.min(nx - 1, Math.max(0, Math.round((b.x - minU) / res)));
      const cj = Math.min(ny - 1, Math.max(0, Math.round((b.z - minV) / res)));
      const k = idx(ci, cj);
      plungeCentreVirgin = material[k] === 1 && swept[k] === 0;
    }
    const tally = { fresh: 0 };
    const stamps = Math.max(1, Math.ceil(len / (res * 0.5)));
    for (let s = 0; s <= stamps; s++) {
      const t = s / stamps;
      stampDisc(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, tally);
    }
    if (!depthMove && len > 1e-9) {
      travel += len;
      flatSegs.push({ end: travel, fresh: tally.fresh * res * res, i, ax: a.x, az: a.z, ay: a.y, bx: b.x, bz: b.z, len });
    } else if (verticalPlunge && plungeCentreVirgin) {
      // A VERTICAL plunge whose disc CENTRE lands in material no earlier move
      // has swept — the P1-1 re-entry failure (the reviewer's probe: the tool
      // fully in virgin). A non-virgin detour plunge lands its centre inside
      // the already-swept band; its disc may still poke one ≤ae crescent
      // into the uncut side, the same bite every walk move takes, so the
      // centre test — not the disc's fresh count — is the honest criterion.
      barePlunges++;
    }
  }

  // Windowed engagement: fresh material per revolution-window of travel,
  // mapped through the doc's crescent equivalence φ = 2·asin(ae_eq/D).
  for (let w = 0; w < flatSegs.length; w++) {
    const end = flatSegs[w]!.end;
    const winLo = end - windowMm;
    let freshW = 0;
    for (let j = w; j >= 0; j--) {
      const seg = flatSegs[j]!;
      const start = seg.end - seg.len;
      if (start >= winLo) {
        freshW += seg.fresh; // fully inside the window
      } else {
        freshW += seg.fresh * Math.max(0, (seg.end - winLo) / Math.max(seg.len, 1e-9));
        break; // everything older is outside
      }
    }
    const aeEq = Math.min(freshW / windowMm, diameter);
    const deg = (2 * Math.asin(aeEq / diameter) * 180) / Math.PI;
    maxEngagement = Math.max(maxEngagement, deg);
    worst.push({ i: flatSegs[w]!.i, ax: flatSegs[w]!.ax, az: flatSegs[w]!.az, ay: flatSegs[w]!.ay, bx: flatSegs[w]!.bx, bz: flatSegs[w]!.bz, ae: aeEq, len: flatSegs[w]!.len });
    worst.sort((x, y) => y.ae - x.ae);
    if (worst.length > 6) worst.length = 6;
  }

  let sweptReachable = 0;
  for (let k = 0; k < swept.length; k++) {
    if (swept[k] && reachable[k]) sweptReachable++;
  }
  let gougeCells = 0;
  const loops = [sil.outer.points, ...sil.islands.map((i) => i.points)];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = idx(i, j);
      if (!outside[k]) continue;
      const p = cell(i, j);
      let near = false;
      for (const loop of loops) {
        if (distToLoop(p, loop) <= 0.25) {
          near = true;
          break;
        }
      }
      if (!near) gougeCells++;
    }
  }

  return {
    maxEngagementDeg: maxEngagement,
    coverage: reachableTotal > 0 ? sweptReachable / reachableTotal : 0,
    gougeCells,
    cuttingMoves,
    barePlunges,
    worst,
  };
}

/**
 * G2/G3 share of cutting moves after the post's arc filter. The flat-only
 * G2/G3 contract (arcFit never spans a height change) makes helical ENTRY
 * descents structurally straight; the trochoid-orbits criterion is about
 * the CLEARING path, so the ratio is asserted on flat cutting moves (the
 * overall share including entries is reported alongside for honesty).
 */
function arcMoveRatio(tp: Toolpath): { flat: number; overall: number } {
  const items = fitArcs(tp.points, 0.01);
  let arcs = 0;
  let flatMoves = 0;
  let cutMoves = 0;
  for (let i = 1; i < items.length; i++) {
    const it = items[i]!;
    const prev = items[i - 1] as { y: number };
    if ('sweep' in it) {
      arcs++;
      flatMoves++;
      cutMoves++;
    } else if (!it.rapid) {
      cutMoves++;
      if (Math.abs(it.y - prev.y) <= 1e-9) flatMoves++;
    }
  }
  return {
    flat: flatMoves > 0 ? arcs / flatMoves : 0,
    overall: cutMoves > 0 ? arcs / cutMoves : 0,
  };
}

/** Depth-only cut moves must carry the plunge feed (D4 regression guard). */
function assertPlungeFeeds(tp: Toolpath, plungeRate: number): void {
  for (let i = 1; i < tp.points.length; i++) {
    const prev = tp.points[i - 1]!;
    const p = tp.points[i]!;
    if (p.rapid) continue;
    const xyMove = Math.abs(p.x - prev.x) > 1e-9 || Math.abs(p.z - prev.z) > 1e-9;
    const yMove = Math.abs(p.y - prev.y) > 1e-9;
    if (yMove && !xyMove) expect(p.feedRate).toBe(plungeRate);
  }
}

/** Rapids starting below the safe plane must be straight up. */
function assertVerticalRetracts(tp: Toolpath, safe: number): void {
  for (let i = 1; i < tp.points.length; i++) {
    const prev = tp.points[i - 1]!;
    const p = tp.points[i]!;
    if (p.rapid && prev.y < safe - 1e-6) {
      expect(Math.abs(p.x - prev.x)).toBeLessThan(1e-9);
      expect(Math.abs(p.z - prev.z)).toBeLessThan(1e-9);
      expect(p.y).toBeGreaterThan(prev.y);
    }
  }
}

/** Shared golden-sample assertions; logs the report numbers. */
function assertGolden(
  name: string,
  tp: Toolpath,
  sil: NonNullable<ReturnType<typeof topSilhouette>>,
  diameter: number,
  opts: {
    engagementLimitDeg?: number;
    requireArcRatio?: boolean;
    allowBarePlunge?: boolean;
    /** Floor for the overall (entries included) arc share — tiny domains
     * where helical entries legitimately dominate the move count set it
     * lower. Default 0.4. */
    overallArcFloor?: number;
    /** Anti-gouge slack (mm) over the r−0.03 convention. The dumbbell's
     * waist reflex corners erode to radius-|delta| arcs, where clipper's
     * own documented budget stacks (0.02 offset tolerance + 0.02 chord
     * sagitta of the emitted ring polyline) — 0.045 keeps the assert within
     * the library's promise. Default 0.03. */
    marginSlack?: number;
  } = {},
): SweepReport {
  const r = diameter / 2;
  expect(tp.cuttingMoves.length, `${name}: empty toolpath`).toBeGreaterThan(0);
  const margin = minWallMargin(tp, sil);
  const sweep = sweepToolpath(tp, sil, diameter);
  const ratio = arcMoveRatio(tp);
  const limit = opts.engagementLimitDeg ?? 30 * 1.2;
  console.log(
    `[adaptive:${name}] cutMoves=${sweep.cuttingMoves} arcFlat=${(ratio.flat * 100).toFixed(1)}% ` +
    `arcAll=${(ratio.overall * 100).toFixed(1)}% ` +
    `maxEngage=${sweep.maxEngagementDeg.toFixed(1)}° minMargin=${margin.toFixed(3)} ` +
    `coverage=${(sweep.coverage * 100).toFixed(1)}% gougeCells=${sweep.gougeCells} ` +
    `barePlunges=${sweep.barePlunges}`,
  );
  console.log(
    `[adaptive:${name}] worst moves: ` +
    sweep.worst.map((w) =>
      `#${w.i} (${w.ax.toFixed(1)},${w.az.toFixed(1)},y${w.ay.toFixed(1)})->(${w.bx.toFixed(1)},${w.bz.toFixed(1)}) ae=${w.ae.toFixed(2)} len=${w.len.toFixed(2)}`,
    ).join(' | '),
  );
  expect(margin, `${name}: gouge margin`).toBeGreaterThanOrEqual(r - (opts.marginSlack ?? 0.03));
  expect(sweep.gougeCells, `${name}: swept outside the material`).toBe(0);
  expect(sweep.maxEngagementDeg, `${name}: engagement`).toBeLessThanOrEqual(limit);
  expect(sweep.coverage, `${name}: coverage`).toBeGreaterThanOrEqual(0.985);
  // No vertical plunge may land in virgin material: every virgin entry must
  // descend helically (the P1-1 re-entry invariant). The narrow-slot
  // fallback (④) is the documented exemption.
  if (opts.allowBarePlunge !== true) {
    expect(sweep.barePlunges, `${name}: bare virgin plunge`).toBe(0);
  }
  if (opts.requireArcRatio !== false) {
    expect(ratio.flat, `${name}: flat arc move ratio`).toBeGreaterThan(0.6);
    // Entries drag the overall share (descending arcs are outside the
    // flat-only G2/G3 contract); the clearing path itself must still
    // dominate the whole program.
    expect(ratio.overall, `${name}: overall arc share`).toBeGreaterThan(opts.overallArcFloor ?? 0.4);
  }
  assertPlungeFeeds(tp, base.plungeRate);
  assertVerticalRetracts(tp, base.stockTop + 5);
  return sweep;
}

/** Golden sample runner: generate twice (determinism) and measure. */
function golden(
  name: string,
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  tool: ToolDefinition,
  spec: Partial<CAMParameters>,
  body: SolidBody,
  opts: {
    engagementLimitDeg?: number;
    requireArcRatio?: boolean;
    allowBarePlunge?: boolean;
    overallArcFloor?: number;
    marginSlack?: number;
  } = {},
): { tp: Toolpath; sweep: SweepReport } {
  const params: CAMParameters = { ...base, ...spec };
  const tp = generatePocketToolpath(bounds, tool, params, { body });
  const again = generatePocketToolpath(bounds, tool, params, { body });
  expect(again.points, `${name}: not deterministic`).toEqual(tp.points);
  const sil = topSilhouette(body);
  expect(sil).not.toBeNull();
  const sweep = assertGolden(name, tp, sil!, tool.diameter, opts);
  return { tp, sweep };
}

describe('planAdaptiveClearing — planner units', () => {
  const rect: RegionComponent[] = [
    { outer: [{ u: 0, v: 0 }, { u: 44, v: 0 }, { u: 44, v: 24 }, { u: 0, v: 24 }], holes: [] },
  ];

  it('derives the radial step from the engagement angle — tighter angle, more depth walks', () => {
    const tight = planAdaptiveClearing(rect, { toolDiameter: 6, stepoverCap: 3, engagementDeg: 20 });
    const normal = planAdaptiveClearing(rect, { toolDiameter: 6, stepoverCap: 3, engagementDeg: 30 });
    const loose = planAdaptiveClearing(rect, { toolDiameter: 6, stepoverCap: 3, engagementDeg: 40 });
    expect(normal.stats.depths).toBeGreaterThan(0);
    expect(tight.stats.depths).toBeGreaterThan(normal.stats.depths);
    expect(loose.stats.depths).toBeLessThan(normal.stats.depths);
    // The default 30° plan on the 44×24 domain: ae = 6·sin15° ≈ 1.553 → the
    // deepest erosion is k=7 (24/2/1.553 = 7.7), and the wide-core zone
    // (d ≥ r) chains while the rim walks direct crescents.
    expect(normal.stats.chainedRings).toBeGreaterThanOrEqual(5);
    expect(normal.stats.directRings).toBeGreaterThanOrEqual(1);
    expect(normal.entryOrbit).not.toBeNull();
    expect(normal.stats.orbits).toBeGreaterThan(50);
  });

  it('honors the user stepover cap', () => {
    const capped = planAdaptiveClearing(rect, { toolDiameter: 6, stepoverCap: 0.6, engagementDeg: 30 });
    const normal = planAdaptiveClearing(rect, { toolDiameter: 6, stepoverCap: 3, engagementDeg: 30 });
    expect(capped.stats.depths).toBeGreaterThan(normal.stats.depths);
  });

  it('has no entry orbit when no honest orbit fits (narrow slot domain)', () => {
    const slot: RegionComponent[] = [
      { outer: [{ u: 0, v: 0 }, { u: 30, v: 0 }, { u: 30, v: 1.5 }, { u: 0, v: 1.5 }], holes: [] },
    ];
    const plan = planAdaptiveClearing(slot, { toolDiameter: 6, stepoverCap: 3 });
    expect(plan.paths.length).toBeGreaterThan(0); // the honest direct wall walk
    expect(plan.stats.orbits).toBe(0);
    expect(plan.entryOrbit).toBeNull();
  });

  it('returns an empty plan for empty regions', () => {
    const plan = planAdaptiveClearing([], { toolDiameter: 6, stepoverCap: 3 });
    expect(plan.paths).toEqual([]);
    expect(plan.stats.depths).toBe(0);
  });
});

describe('generatePocketToolpath — adaptive golden samples', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine(); // the island sample pockets a boolean body
  });

  it('① rectangular pocket: trochoid chains + offset bands, helix entry', () => {
    const body = createBox(50, 10, 30);
    const { tp } = golden(
      'rect', { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } },
      tool6, {}, body,
    );
    // The helix entry descends along a circle before any flat cut: ≥ 20
    // descending points with xy motion, y monotone non-increasing.
    const firstCut = tp.points.findIndex((p) => !p.rapid);
    let descent = 0;
    for (let i = firstCut; i < tp.points.length; i++) {
      const p = tp.points[i]!;
      const prev = tp.points[i - 1]!;
      if (p.rapid) break;
      if (p.y >= prev.y - 1e-12) break;
      descent++;
    }
    expect(descent).toBeGreaterThanOrEqual(20);
    // Adaptive differs from both legacy strategies (no silent fallthrough).
    const raster = generatePocketToolpath(
      { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } },
      tool6, { ...base, pocketStrategy: 'raster', helixEntry: false }, { body },
    );
    expect(tp.points).not.toEqual(raster.points);
  });

  it('② L-shaped pocket: concave corner clears without an engagement spike', () => {
    const body = createExtrude({
      profile: [
        { x: -40, y: 0, z: -40 }, { x: 40, y: 0, z: -40 }, { x: 40, y: 0, z: 40 },
        { x: -10, y: 0, z: 40 }, { x: -10, y: 0, z: 10 }, { x: -40, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    golden(
      'L', { min: { x: -40, y: 0, z: -40 }, max: { x: 40, y: 10, z: 40 } },
      tool6, {}, body,
    );
  });

  it('③ tube annulus: both walls respected, orbits carry the arcs', () => {
    const body = createTube(15, 6, 20, 32);
    golden(
      'tube', { min: { x: -15, y: 0, z: -15 }, max: { x: 15, y: 20, z: 15 } },
      tool3, { stockTop: 20 }, body,
    );
  });

  it('④ narrow slot (width < 2×D): honest direct slot pass — no trochoid fits', () => {
    // Doc §1.4 narrow-zone rule: when the cleared width cannot host an
    // orbit, the walk degenerates to a direct (full-slot) pass whose width
    // is bounded by the zone itself. Arc ratio is exempt here by design.
    const body = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 7.5 }, { x: 0, y: 0, z: 7.5 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const { tp, sweep } = golden(
      'slot', { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 7.5 } },
      tool6, { helixEntry: false }, body,
      // Engagement exemption (doc §1.4 narrow-zone rule): the slot's
      // cleared width (1.5 mm) cannot host any orbit, so the first pass is
      // an honest full-width slot — its reading is bounded by the zone
      // itself, not by the engagement budget. The same fallback makes the
      // single vertical entry plunge honest (no orbit to helix on).
      { requireArcRatio: false, engagementLimitDeg: 180, allowBarePlunge: true },
    );
    // The slot is narrower than the tool-domain needs for any orbit: the
    // plan walks the wall ring(s) directly.
    expect(sweep.coverage).toBeGreaterThanOrEqual(0.99);
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
  });

  it('⑤ island pocket: grown-island rings and corner nibbles stay honest', () => {
    const plate = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 60, y: 0, z: 0 }, { x: 60, y: 0, z: 40 }, { x: 0, y: 0, z: 40 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const island = translateBody(
      createExtrude({
        profile: [
          { x: 24, y: 0, z: 16 }, { x: 36, y: 0, z: 16 }, { x: 36, y: 0, z: 24 }, { x: 24, y: 0, z: 24 },
        ],
        direction: { x: 0, y: 1, z: 0 }, distance: 12, symmetric: false,
      }),
      { x: 0, y: -1, z: 0 },
    );
    const body = booleanOpManifold(plate, island, 'difference');
    expect(body).not.toBeNull();
    golden(
      'island', { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 10, z: 40 } },
      tool6, {}, body!,
    );
  });

  it('⑥ dumbbell domain: dust-skipped deepest layers keep BOTH lobes virgin — helical re-entry (P1-1)', () => {
    // Two ⌀22.4 lobes on a ~10 mm neck: the deepest SURVIVING erosions are
    // dust (two sub-mm slivers the filter drops), so the first walked depth
    // sits ~1 mm shallower with two separated lobes. Before the P1-1 fix
    // the dust layers consumed the virgin flag and became lineage
    // ancestors, leaving the second lobe's first chain to plunge straight
    // into virgin material.
    const c = 10;
    const R = 11.2;
    const body = createExtrude({
      // 160 segments keeps every eroded ring's chord sagitta within the arc
      // fitter's 0.01 tolerance (a coarse polygon would post the curved
      // direct walks as lines and sink the arc-ratio criterion).
      profile: dumbbellProfile(c, R, 160),
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const bounds = { min: { x: -(c + R), y: 0, z: -R }, max: { x: c + R, y: 10, z: R } };
    // marginSlack 0.045: the waist's reflex corners erode to radius-3 arcs
    // where clipper's own budget stacks (0.02 offset + 0.02 chord sagitta).
    const { sweep } = golden('dumbbell', bounds, tool6, {}, body, { marginSlack: 0.045 });
    expect(sweep.barePlunges).toBe(0); // explicit red-green marker (also in assertGolden)
    // Planner ground truth: both lobes carry an entry orbit.
    const sil = topSilhouette(body)!;
    const regions = offsetRegion(sil.outer.points, sil.islands.map((l) => l.points), -3);
    const plan = planAdaptiveClearing(regions, { toolDiameter: 6, stepoverCap: 3 });
    expect(plan.stats.depths).toBeGreaterThan(plan.stats.chainedRings); // dust layers were skipped
    expect(plan.pathEntries.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(plan.stats.orbits).toBeGreaterThan(0);
    // Red-green evidence: at least two helical descents exist (one per
    // lobe) — ≥ 2·18 descending cut moves with xy travel.
    const t0 = performance.now();
    const tp = generatePocketToolpath(bounds, tool6, { ...base }, { body });
    const genMs = performance.now() - t0;
    let helicalDescents = 0;
    let runDesc = 0;
    for (let i = 1; i < tp.points.length; i++) {
      const a = tp.points[i - 1]!;
      const b = tp.points[i]!;
      if (b.rapid) {
        runDesc = 0;
        continue;
      }
      if (Math.abs(b.y - a.y) > 1e-9 && Math.hypot(b.x - a.x, b.z - a.z) > 1e-9) runDesc++;
      else {
        if (runDesc >= 12) helicalDescents++;
        runDesc = 0;
      }
    }
    if (runDesc >= 12) helicalDescents++;
    expect(helicalDescents).toBeGreaterThanOrEqual(2);
    console.log(`[adaptive:dumbbell] virginEntries=${plan.pathEntries.filter(Boolean).length} helicalDescents=${helicalDescents} gen=${genMs.toFixed(0)}ms`);
  });

  it('⑦ island-split domain (two separated 12×10 pockets): both sides re-enter helically (P1-1)', () => {
    // A full-height wall island splits the cleared domain into two separate
    // 12×10 pockets whose deepest surviving erosions are dust slivers — the
    // reviewer's second trigger shape.
    const plate = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 46, y: 0, z: 0 }, { x: 46, y: 0, z: 16 }, { x: 0, y: 0, z: 16 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    // A floating wall island (NOT a through slot — a through cut would
    // disconnect the body and the second piece would vanish from the
    // silhouette) spanning the full cleared height after the radius grow:
    // the cleared domain splits into two separate 12×10 pockets whose
    // deepest surviving erosions are dust slivers — the reviewer's second
    // trigger shape.
    const wall = translateBody(
      createExtrude({
        profile: [
          { x: 21, y: 0, z: 1 }, { x: 25, y: 0, z: 1 }, { x: 25, y: 0, z: 15 }, { x: 21, y: 0, z: 15 },
        ],
        direction: { x: 0, y: 1, z: 0 }, distance: 12, symmetric: false,
      }),
      { x: 0, y: -1, z: 0 },
    );
    const body = booleanOpManifold(plate, wall, 'difference');
    expect(body).not.toBeNull();
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 46, y: 10, z: 16 } };
    // Two 12×10 pockets make a tiny program where the two helical entries
    // legitimately dominate the overall move count — the flat-move arc
    // criterion still applies in full.
    const { sweep } = golden('dual', bounds, tool6, {}, body!, { overallArcFloor: 0.3 });
    expect(sweep.barePlunges).toBe(0);
    const sil = topSilhouette(body!)!;
    const regions = offsetRegion(sil.outer.points, sil.islands.map((l) => l.points), -3);
    const plan = planAdaptiveClearing(regions, { toolDiameter: 6, stepoverCap: 3 });
    expect(regions.length).toBe(2); // the wall really splits the domain
    expect(plan.pathEntries.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it('tool too large keeps the shared empty-toolpath semantics', () => {
    const body = createExtrude({
      profile: [
        { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 5 }, { x: 0, y: 0, z: 5 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 5 } },
      tool6, { ...base }, { body },
    );
    expect(tp.points).toEqual([]);
    expect(tp.name).toContain('tool too large');
  });

  it('descends level by level and regenerates identically at depth (5 levels)', () => {
    const body = createBox(50, 10, 30);
    const bounds = { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } };
    const tp = generatePocketToolpath(bounds, tool6, { ...base, depthOfCut: 2 }, { body });
    const levels = [...new Set(tp.cuttingMoves.map((p) => p.y.toFixed(3)))].map(Number).sort((a, b) => b - a);
    // The helix/orbit descents carry intermediate heights; assert the five
    // depth levels are all present among the flat cutting heights.
    for (const lv of [8, 6, 4, 2, 0]) {
      expect(levels.some((y) => Math.abs(y - lv) < 1e-6), `level ${lv} missing`).toBe(true);
    }
    const again = generatePocketToolpath(bounds, tool6, { ...base, depthOfCut: 2 }, { body });
    expect(again.points).toEqual(tp.points);
  });

  it('wallFinishPass re-walks the wall side gouge-free', () => {
    const body = createBox(50, 10, 30);
    const bounds = { min: { x: -25, y: 0, z: -15 }, max: { x: 25, y: 10, z: 15 } };
    const tp = generatePocketToolpath(
      bounds, tool6, { ...base, wallFinishPass: true }, { body },
    );
    const sil = topSilhouette(body)!;
    expect(minWallMargin(tp, sil)).toBeGreaterThanOrEqual(3 - 0.03);
    const plain = generatePocketToolpath(bounds, tool6, { ...base }, { body });
    expect(tp.cuttingMoves.length).toBeGreaterThan(plain.cuttingMoves.length);
  });

  it('typical body plans in well under 500 ms (L shape, 5 levels)', () => {
    const body = createExtrude({
      profile: [
        { x: -40, y: 0, z: -40 }, { x: 40, y: 0, z: -40 }, { x: 40, y: 0, z: 40 },
        { x: -10, y: 0, z: 40 }, { x: -10, y: 0, z: 10 }, { x: -40, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 }, distance: 10, symmetric: false,
    });
    const bounds = { min: { x: -40, y: 0, z: -40 }, max: { x: 40, y: 10, z: 40 } };
    const t0 = performance.now();
    const tp = generatePocketToolpath(bounds, tool6, { ...base, depthOfCut: 2 }, { body });
    const ms = performance.now() - t0;
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    console.log(`[adaptive:perf] L-shape 5 levels: ${ms.toFixed(0)} ms, ${tp.points.length} points`);
    expect(ms).toBeLessThan(500);
  });
});
