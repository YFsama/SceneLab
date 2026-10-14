import { describe, it, expect } from 'vitest';
import { generateEngraveToolpath, type EngravePoint } from './engrave';
// Compile-time proof the type is re-exported from the index too.
import type { EngravePoint as EngravePointFromIndex } from './index';
import { generateGCode, estimateMachiningTime } from './gcode';
import type { ToolDefinition, CAMParameters, Toolpath, ToolpathPoint } from './types';

const tool: ToolDefinition = {
  id: 'vbit-60deg',
  name: '60° V-Bit',
  diameter: 12,
  flutes: 2,
  type: 'vbit',
  fluteLength: 10,
  overallLength: 50,
  material: 'carbide',
  tipAngleDeg: 60,
  tipFlat: 0,
};

const params: CAMParameters = {
  feedRate: 800,
  plungeRate: 200,
  spindleSpeed: 18000,
  depthOfCut: 1,
  stepover: 1,
  stockTop: 5,
  stockBottom: 0,
};

/** A square-wave stroke: planar length 10+5+10+5+10 = 40 mm. */
const squareWave: EngravePoint[] = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 5 },
  { x: 20, z: 5 },
  { x: 20, z: 0 },
  { x: 30, z: 0 },
];
const squareWaveLength = 40;

/**
 * Cutting runs: each run is the plunge + cut points of one stroke at one
 * level, bounded by rapids — the same parse the contour tests use.
 */
function cuttingRuns(tp: Toolpath): ToolpathPoint[][] {
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

/** Planar (x, z) length travelled by one cutting run. */
function planarLength(run: ToolpathPoint[]): number {
  let s = 0;
  for (let i = 1; i < run.length; i++) {
    s += Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.z - run[i - 1]!.z);
  }
  return s;
}

/** Every depth-entering (machine-Z only, i.e. scene-y only) cut move must run
 * at the plunge feed — the MoveList plunge contract. */
function assertPlungeFeeds(tp: Toolpath, plungeRate: number): void {
  for (let i = 1; i < tp.points.length; i++) {
    const prev = tp.points[i - 1]!;
    const p = tp.points[i]!;
    if (p.rapid) continue;
    const xyMove = Math.abs(p.x - prev.x) > 1e-9 || Math.abs(p.z - prev.z) > 1e-9;
    const yMove = Math.abs(p.y - prev.y) > 1e-9;
    if (yMove && !xyMove) {
      expect(p.feedRate, `depth-only cut at index ${i} must carry the plunge feed`).toBe(plungeRate);
    }
  }
}

describe('generateEngraveToolpath', () => {
  it('steps the square wave down level by level, walking the full polyline each time', () => {
    // engraveDepth 3 / depthOfCut 1 → three levels at stockTop − {1, 2, 3}.
    const tp = generateEngraveToolpath([squareWave], tool, { ...params, engraveDepth: 3 });
    expect(tp.operation).toBe('engrave');
    expect(tp.name).toBe('Engrave');

    const runs = cuttingRuns(tp);
    expect(runs).toHaveLength(3); // one run per level (one stroke)

    // Levels parsed from the runs: first-appearance order, stockTop − k·doc.
    const levelYs = runs.map((r) => r[0]!.y);
    expect(levelYs).toEqual([4, 3, 2]);

    runs.forEach((run, li) => {
      // Run = plunge at the stroke start + one cut per remaining vertex.
      expect(run).toHaveLength(squareWave.length);
      // The plunge target and every cut sit exactly at the level height.
      for (const p of run) expect(p.y).toBeCloseTo(5 - (li + 1), 9);
      // The run reproduces the polyline, vertex for vertex, in order.
      expect(run.map((p) => [p.x, p.z])).toEqual(squareWave.map((p) => [p.x, p.z]));
      // …and covers the full planar length (no vertex dropped).
      expect(planarLength(run)).toBeCloseTo(squareWaveLength, 6);
    });

    // Retraction between levels: 3 approach rapids at safe + 3 end-of-stroke
    // retracts (stockTop 5 + default margin 5 = 10).
    const safeRapids = tp.rapidMoves.filter((p) => p.y === 10);
    expect(safeRapids).toHaveLength(6);
    // The deepest cut reaches stockTop − engraveDepth.
    expect(Math.min(...tp.cuttingMoves.map((p) => p.y))).toBeCloseTo(2, 9);
  });

  it('retracts after each level before the next one starts (rapid between cutting runs)', () => {
    const tp = generateEngraveToolpath([squareWave], tool, { ...params, engraveDepth: 3 });
    // Walk the points: after each cutting run's last point, the very next
    // point must be a rapid — never another cut continuing at depth.
    let inRun = false;
    let retractsAfterRuns = 0;
    for (const p of tp.points) {
      if (!p.rapid) {
        inRun = true;
      } else if (inRun) {
        inRun = false;
        retractsAfterRuns++;
      }
    }
    expect(retractsAfterRuns).toBe(3); // one retract terminating each level
  });

  it('defaults to a single pass at depthOfCut when engraveDepth is omitted', () => {
    const tp = generateEngraveToolpath([squareWave], tool, params);
    const runs = cuttingRuns(tp);
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]!.y).toBeCloseTo(5 - 1, 9); // stockTop − depthOfCut
  });

  it('clamps a shallower engraveDepth below depthOfCut to one level at that depth', () => {
    // engraveDepth 0.5 < depthOfCut 2 → a single level 0.5 below the top,
    // never a 2 mm-deep overcut (the min(doc, remaining) layer rule).
    const tp = generateEngraveToolpath([squareWave], tool, {
      ...params,
      depthOfCut: 2,
      engraveDepth: 0.5,
    });
    const runs = cuttingRuns(tp);
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]!.y).toBeCloseTo(4.5, 9);
    for (const p of tp.cuttingMoves) expect(p.y).toBeCloseTo(4.5, 9);
  });

  it('falls back to depthOfCut for an invalid engraveDepth, and to an empty path when neither is usable', () => {
    for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tp = generateEngraveToolpath([squareWave], tool, { ...params, engraveDepth: bad });
      expect(cuttingRuns(tp)).toHaveLength(1);
      expect(cuttingRuns(tp)[0]![0]!.y).toBeCloseTo(4, 9); // stockTop − doc
    }
    // No engraveDepth and a non-positive depthOfCut → nothing to cut.
    const empty = generateEngraveToolpath([squareWave], tool, { ...params, depthOfCut: 0 });
    expect(empty.points).toEqual([]);
    expect(empty.rapidMoves).toEqual([]);
    expect(empty.cuttingMoves).toEqual([]);
    expect(estimateMachiningTime(empty)).toBe(0); // the panel shows honest zero time
  });

  it('cuts each multi-stroke curve in the given order, independently entered and retracted', () => {
    const a: EngravePoint[] = [
      { x: 0, z: 0 },
      { x: 5, z: 0 },
    ];
    const b: EngravePoint[] = [
      { x: 2, z: 3 },
      { x: 2, z: 8 },
    ];
    const tp = generateEngraveToolpath([a, b], tool, { ...params, engraveDepth: 2 });
    const runs = cuttingRuns(tp);
    // Two levels × two strokes, curve order preserved inside every level.
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => [r[0]!.x, r[0]!.z])).toEqual([
      [0, 0], [2, 3], // level 1: stroke A then stroke B
      [0, 0], [2, 3], // level 2: same order
    ]);
    // Level heights descend level-major (outer loop levels, inner curves).
    expect(runs.map((r) => r[0]!.y)).toEqual([4, 4, 3, 3]);
    // Every run starts with its own plunge at the plunge feed.
    for (const run of runs) expect(run[0]!.feedRate).toBe(params.plungeRate);
    // Each run walks exactly its own stroke.
    expect(runs[0]!.map((p) => [p.x, p.z])).toEqual(a.map((p) => [p.x, p.z]));
    expect(runs[1]!.map((p) => [p.x, p.z])).toEqual(b.map((p) => [p.x, p.z]));
  });

  it('skips strokes shorter than two points and returns an empty path for no curves', () => {
    const tp = generateEngraveToolpath(
      [[{ x: 1, z: 1 }], squareWave, []],
      tool,
      params,
    );
    expect(cuttingRuns(tp)).toHaveLength(1); // only the square wave ran
    expect(tp.name).toBe('Engrave');

    const none = generateEngraveToolpath([], tool, params);
    expect(none.points).toEqual([]);
    expect(none.operation).toBe('engrave');
    expect(none.name).toBe('Engrave');
  });

  it('plunges at plungeRate and cuts at the operation feed rate (MoveList semantics)', () => {
    const tp = generateEngraveToolpath([squareWave], tool, { ...params, engraveDepth: 2 });
    assertPlungeFeeds(tp, params.plungeRate);
    for (const run of cuttingRuns(tp)) {
      // The run-opening plunge carries the plunge feed…
      expect(run[0]!.feedRate).toBe(params.plungeRate);
      // …and every planar cut after it carries no override, so the post runs
      // them at params.feedRate.
      for (const p of run.slice(1)) expect(p.feedRate).toBeUndefined();
    }
    // Rapids never carry a feed.
    for (const p of tp.rapidMoves) expect(p.feedRate).toBeUndefined();
  });

  it('honors safeZAboveStock for the traverse height', () => {
    const tp = generateEngraveToolpath([squareWave], tool, {
      ...params,
      safeZAboveStock: 7,
    });
    const ys = tp.rapidMoves.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(12, 9); // stockTop 5 + 7
    // The descent stops at the feed plane (stockTop + 1) before plunging.
    expect(ys).toContain(6);
  });

  it('posts through generateGCode as valid G1 motion (scene → machine X=x, Y=z, Z=y)', () => {
    const tp = generateEngraveToolpath([squareWave], tool, { ...params, engraveDepth: 3 });
    const g = generateGCode(tp);
    expect(g).toContain('Operation: engrave');

    // Motion lines in execution order, with their tool words.
    const motion = g
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(G0|G1|G2|G3) X\S+ Y\S+ Z\S+/.test(l));
    expect(motion.length).toBeGreaterThan(0);

    // The square wave's 90° corners deviate far beyond the 0.01 mm arc
    // tolerance, so every cut posts as G1 — the emitted G1 set must match the
    // cutting moves exactly, machine-mapped and 3-decimal formatted.
    const g1 = motion.filter((l) => l.startsWith('G1 '));
    const expected = tp.cuttingMoves.map(
      (p) => `G1 X${p.x.toFixed(3)} Y${p.z.toFixed(3)} Z${p.y.toFixed(3)}`,
    );
    expect(g1.map((l) => l.replace(/ F\d+(\.\d+)?$/, ''))).toEqual(expected);

    // The first cut is the level-1 plunge at the stroke start, posted with
    // the plunge feed (X=x, Y=z, Z=y mapping).
    expect(g).toContain(`G1 X0.000 Y0.000 Z4.000 F${params.plungeRate}`);
    expect(g).toContain(`F${params.feedRate}`); // …and the cut feed follows
  });

  it('is exported from the cam index alongside EngravePoint', async () => {
    const index = await import('./index');
    expect(typeof index.generateEngraveToolpath).toBe('function');
    const tp = index.generateEngraveToolpath([[{ x: 0, z: 0 }, { x: 1, z: 0 }]], tool, params);
    expect(tp.operation).toBe('engrave');
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    const point: EngravePointFromIndex = { x: 0, z: 0 }; // type is exported and usable
    expect(point).toEqual({ x: 0, z: 0 });
  });
});
