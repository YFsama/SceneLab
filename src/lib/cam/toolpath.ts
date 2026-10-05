import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import type { SolidBody, Vec3 } from '../geometry/types';
import {
  topSilhouette,
  offsetPolygon,
  scanlineIntervals,
  subtractIntervals,
  pointInPolygon,
  type Point2,
} from './silhouette';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/**
 * Axis convention: every point is stored in SCENE space with y = height above
 * the table (machine Z). Generators plan in the body's XZ plane — (u, v) =
 * (body x, body z) — and emit {x: u, y: stockTop − depth, z: v}, so the plunge
 * axis is always y and renderers never remap. The G-code post-processor maps
 * machine X = x, Y = z, Z = y.
 */
class MoveList {
  readonly points: ToolpathPoint[] = [];
  // Explicit field assignment (not a constructor parameter property) — the
  // project compiles with erasableSyntaxOnly.
  private readonly params: CAMParameters;
  constructor(params: CAMParameters) {
    this.params = params;
  }

  /** G0 rapid positioning move. */
  rapid(p: { x: number; y: number; z: number }): void {
    this.points.push({ ...p, rapid: true });
  }

  /** G1 cut at the operation feed rate (or a per-move override). */
  cut(p: { x: number; y: number; z: number; feedRate?: number }): void {
    this.points.push({ ...p, rapid: false });
  }

  /**
   * G1 plunge — a depth-entering move that always carries the plunge feed
   * rate, so vertical entries never run at the (faster) cut feed.
   */
  plunge(p: { x: number; y: number; z: number }): void {
    this.points.push({ ...p, rapid: false, feedRate: this.params.plungeRate });
  }

  get rapidMoves(): ToolpathPoint[] {
    return this.points.filter((m) => m.rapid);
  }
  get cuttingMoves(): ToolpathPoint[] {
    return this.points.filter((m) => !m.rapid);
  }
}

/**
 * Traverse clearance above the stock top (mm) — CAMSetup.safeZAboveStock as
 * carried by the operation params. Defaults to the setup default (5); a
 * non-finite or non-positive value falls back too (a 0 clearance traverse
 * would scrape the estimated surface).
 */
export function safeMargin(params: CAMParameters): number {
  const z = params.safeZAboveStock;
  return typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : 5;
}

/** Safe traverse height above the stock. */
function safeY(params: CAMParameters): number {
  return params.stockTop + safeMargin(params);
}

/** Cut levels from stockTop down to stockBottom, one depthOfCut at a time. */
export function depthLevels(params: CAMParameters): number[] {
  const total = params.stockTop - params.stockBottom;
  if (total <= 0) return [];
  const doc = Math.max(params.depthOfCut, 0.01);
  const n = Math.max(1, Math.ceil(total / doc - 1e-9));
  const levels: number[] = [];
  for (let i = 1; i <= n; i++) levels.push(params.stockTop - Math.min(i * doc, total));
  return levels;
}

/** Row positions from vMin to vMax at ≤ stepover, always ending ON vMax. */
function rowPositions(vMin: number, vMax: number, stepover: number): number[] {
  const rows: number[] = [];
  if (vMax <= vMin + 1e-9) return vMin <= vMax ? [vMin] : [];
  for (let v = vMin; v <= vMax + 1e-9; v += stepover) rows.push(Math.min(v, vMax));
  if (rows.length === 0 || rows[rows.length - 1]! < vMax - 1e-9) rows.push(vMax);
  return rows.filter((v, i) => i === 0 || Math.abs(v - rows[i - 1]!) > 1e-6);
}

/**
 * Linear ramp entry: descend `descend` over the longest of 2·tool diameter or
 * a 15° ramp along the first row, instead of plunging straight down. Returns
 * the u advanced past the ramp (row end when the row is shorter than the
 * ideal ramp length).
 */
function rampLength(tool: ToolDefinition, descend: number, rowLength: number): number {
  const ideal = Math.max(2 * tool.diameter, descend / Math.tan((15 * Math.PI) / 180));
  return Math.min(ideal, Math.max(rowLength, 0));
}

export interface PocketOptions {
  /** Clip the raster to this body's top-view silhouette instead of raw bounds. */
  body?: SolidBody;
  /** Finish stock left on walls (mm); defaults to params.allowance. */
  allowance?: number;
  /**
   * Link consecutive raster rows with a cut move at cut depth instead of
   * retract→rapid→plunge (default true). Both row endpoints sit inside the
   * inset region, so the swept disc clears the walls; the link is skipped
   * (full retract detour) when the straight chord leaves the region — e.g.
   * crossing an island or a strong concavity.
   */
  linkRows?: boolean;
}

/** Generate a pocket toolpath: zigzag raster cleared level by level. */
export function generatePocketToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
  options: PocketOptions = {},
): Toolpath {
  const m = new MoveList(params);
  const r = tool.diameter / 2;
  const allowance = options.allowance ?? params.allowance ?? 0;
  const sover = Math.max(0.1, Math.min(params.stepover, tool.diameter * 0.4));
  const safe = safeY(params);

  // Raster region: the silhouette inset by the cutter radius (+ allowance),
  // with islands grown by the same amount so the tool stays clear of them.
  let outer: Point2[] | null = null;
  let islands: Point2[][] = [];
  if (options.body) {
    const sil = topSilhouette(options.body);
    if (sil) {
      outer = offsetPolygon(sil.outer.points, -(r + allowance));
      islands = sil.islands
        .map((l) => offsetPolygon(l.points, r + allowance))
        .filter((p): p is Point2[] => p !== null);
    }
  }
  if (!outer || outer.length < 3) {
    if (options.body) {
      // The tool does NOT fit the silhouette (inset failed or degenerated).
      // Falling back to the bounding-box raster would mill the empty regions
      // of an L/C-shaped part — return an EMPTY toolpath instead; the panel
      // shows the op with no time and the user can pick a smaller tool.
      return {
        id: genId('tp'),
        name: `Pocket ${bounds.min.x.toFixed(0)},${bounds.min.z.toFixed(0)} (tool too large)`,
        operation: 'pocket',
        tool,
        params,
        points: [],
        rapidMoves: [],
        cuttingMoves: [],
      };
    }
    const inset = r + allowance;
    let u0 = bounds.min.x + inset;
    let u1 = bounds.max.x - inset;
    let v0 = bounds.min.z + inset;
    let v1 = bounds.max.z - inset;
    if (u1 < u0) u0 = u1 = (bounds.min.x + bounds.max.x) / 2;
    if (v1 < v0) v0 = v1 = (bounds.min.z + bounds.max.z) / 2;
    // Degenerate axes are padded to 4 µm so a scanline row still falls
    // strictly inside the polygon (rows are inset 1 µm from the extremes).
    const pad = 4e-6;
    if (u1 - u0 < 1e-9 && v1 - v0 < 1e-9) {
      // Region smaller than the tool: single point.
      outer = [{ u: u0, v: v0 }, { u: u0 + pad, v: v0 }, { u: u0, v: v0 + pad }];
    } else if (v1 - v0 < 1e-9) {
      outer = [
        { u: u0, v: v0 },
        { u: u1, v: v0 },
        { u: u1, v: v0 + pad },
        { u: u0, v: v0 + pad },
      ];
    } else {
      outer = [
        { u: u0, v: v0 },
        { u: u1, v: v0 },
        { u: u1, v: v1 },
        { u: u0, v: v1 },
      ];
    }
  }

  const vMin = Math.min(...outer.map((p) => p.v));
  const vMax = Math.max(...outer.map((p) => p.v));
  // Inset rows by 1 µm: a scanline exactly on an apex vertex of the polygon
  // finds no crossings, which would drop the clamped first/last rows.
  const rows = rowPositions(vMin + 1e-6, vMax - 1e-6, sover);
  const levels = depthLevels(params);
  const linkRows = options.linkRows !== false;

  // Axis-aligned bounding boxes of the (already cutter-grown) islands, for the
  // exact link rejection below.
  const islandBoxes = islands.map((poly) => {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of poly) {
      minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
    }
    return { minU, maxU, minV, maxV };
  });

  /** True when segment a→b intersects the axis-aligned box (slab clip): a
   * chord grazing the box's boundary counts as intersecting — conservative. */
  const segmentHitsBox = (
    a: Point2,
    b: Point2,
    box: { minU: number; maxU: number; minV: number; maxV: number },
  ): boolean => {
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, d: number, lo: number, hi: number): boolean => {
      if (Math.abs(d) < 1e-12) return p >= lo && p <= hi; // parallel slab
      let tn = (lo - p) / d;
      let tf = (hi - p) / d;
      if (tn > tf) { const tmp = tn; tn = tf; tf = tmp; }
      t0 = Math.max(t0, tn);
      t1 = Math.min(t1, tf);
      return t0 <= t1;
    };
    return clip(a.u, b.u - a.u, box.minU, box.maxU) && clip(a.v, b.v - a.v, box.minV, box.maxV);
  };

  /** True when the straight chord a→b stays inside the raster region (outer
   * minus islands). Islands are rejected EXACTLY: every island's AABB is
   * tested against the chord segment, so a narrow island parked at the chord's
   * start (before the first quarter-sample) can no longer slip through — the
   * old 3-point sample (t=.25/.5/.75) gouged exactly there when a row's
   * intervals alternate direction across a narrow slot. The outer boundary is
   * still only sampled at the quarter/mid points: a strongly concave outline
   * can push a chord outside between samples, so this stays a conservative
   * guard — anything doubtful falls back to the retract detour. */
  const canLink = (a: Point2, b: Point2): boolean => {
    for (const box of islandBoxes) if (segmentHitsBox(a, b, box)) return false;
    for (const t of [0.25, 0.5, 0.75]) {
      const p = { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t };
      if (!pointInPolygon(p, outer)) return false;
    }
    return true;
  };

  let forward = true;
  for (let li = 0; li < levels.length; li++) {
    const yLevel = levels[li]!;
    const yPrev = li === 0 ? params.stockTop : levels[li - 1]!;
    // Rapid descent stops 1 mm above the previously cut surface; the very
    // first entry of the program ramps instead of plunging.
    const feedPlane = li === 0 ? params.stockTop + 1 : yPrev + 1;
    let firstEntry = li === 0;
    // Where the cutter stands between passes at THIS level (the zigzag
    // alternates direction, so it is each interval's far end). Null before
    // the first entry and after each level-end retract.
    let rowEnd: Point2 | null = null;

    for (const v of rows) {
      const base = scanlineIntervals(outer, v);
      const blocked = islands.flatMap((poly) => scanlineIntervals(poly, v));
      const intervals = subtractIntervals(base, blocked);

      for (const [ua, ub] of intervals) {
        const uA = forward ? ua : ub;
        const uB = forward ? ub : ua;
        // How far along the row the ENTRY moves already cut (the first-entry
        // ramp may have covered part of it).
        let cutTo = uA;

        if (linkRows && rowEnd && canLink(rowEnd, { u: uA, v })) {
          // Row link: cut straight to the next row's start at the same level.
          // No retract, no plunge — the saved rapid detour is where the
          // estimated-time drop comes from.
          m.cut({ x: uA, y: yLevel, z: v });
        } else {
          // Full entry: retract VERTICALLY from the previous row end (never
          // a diagonal rapid below safe height), traverse at safe, drop to
          // the feed plane, then enter.
          if (rowEnd) m.rapid({ x: rowEnd.u, y: safe, z: rowEnd.v });
          m.rapid({ x: uA, y: safe, z: v });
          if (firstEntry) {
            // Rapid to the FEED PLANE, not the stock surface — a G0 touching
            // the exact estimated surface crashes when the estimate is a hair
            // high; the ramp below starts from here.
            m.rapid({ x: uA, y: feedPlane, z: v });
            const ramp = rampLength(tool, yPrev - yLevel, Math.abs(uB - uA));
            if (ramp > 1e-6) {
              const dir = Math.sign(uB - uA) || 1;
              const uRamp = uA + dir * ramp;
              m.cut({ x: uRamp, y: yLevel, z: v });
              cutTo = uRamp;
            } else {
              m.plunge({ x: uA, y: yLevel, z: v });
            }
            firstEntry = false;
          } else {
            m.rapid({ x: uA, y: feedPlane, z: v });
            m.plunge({ x: uA, y: yLevel, z: v });
          }
        }
        if (Math.abs(uB - cutTo) > 1e-6) m.cut({ x: uB, y: yLevel, z: v });
        rowEnd = { u: uB, v };
        forward = !forward;
      }
    }
    // Level done — retract from wherever the cutter finished.
    if (rowEnd) m.rapid({ x: rowEnd.u, y: safe, z: rowEnd.v });
  }

  return {
    id: genId('tp'),
    name: `Pocket ${bounds.min.x.toFixed(0)},${bounds.min.z.toFixed(0)}`,
    operation: 'pocket',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

export interface ContourOptions {
  /** Finish stock left on the wall (mm); defaults to params.allowance. */
  allowance?: number;
}

/** Generate a contour toolpath around a body's top-view silhouette. */
export function generateContourToolpath(
  body: SolidBody,
  tool: ToolDefinition,
  params: CAMParameters,
  options: ContourOptions = {},
): Toolpath {
  const m = new MoveList(params);
  const safe = safeY(params);

  const sil = topSilhouette(body);
  const empty = {
    id: genId('tp'),
    name: `Contour ${body.name}`,
    operation: 'contour' as const,
    tool,
    params,
    points: [],
    rapidMoves: [],
    cuttingMoves: [],
  };
  if (!sil) return empty;

  // Cutter compensation: outside the outer loop, inside the islands.
  const offset = tool.diameter / 2 + (options.allowance ?? params.allowance ?? 0);
  const paths: Point2[][] = [];
  const outerPath = offsetPolygon(sil.outer.points, offset);
  if (outerPath) paths.push(outerPath);
  for (const island of sil.islands) {
    const p = offsetPolygon(island.points, -offset);
    if (p) paths.push(p); // null ⇒ tool cannot fit the hole; skip it
  }
  if (paths.length === 0) return empty;

  const levels = depthLevels(params);
  for (let li = 0; li < levels.length; li++) {
    const yLevel = levels[li]!;
    const yPrev = li === 0 ? params.stockTop : levels[li - 1]!;
    const feedPlane = li === 0 ? params.stockTop + 1 : yPrev + 1;
    for (const path of paths) {
      const start = path[0]!;
      m.rapid({ x: start.u, y: safe, z: start.v });
      m.rapid({ x: start.u, y: feedPlane, z: start.v });
      m.plunge({ x: start.u, y: yLevel, z: start.v });
      for (let i = 1; i < path.length; i++) {
        const pt = path[i]!;
        m.cut({ x: pt.u, y: yLevel, z: pt.v });
      }
      m.cut({ x: start.u, y: yLevel, z: start.v }); // close the loop
      m.rapid({ x: start.u, y: safe, z: start.v });
    }
  }

  return {
    id: genId('tp'),
    name: `Contour ${body.name}`,
    operation: 'contour',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

/**
 * A drilling target. Plan coordinates are (x, z) — the silhouette plane. The
 * legacy `y` spelling is still accepted so old call sites keep compiling.
 */
export interface DrillHole {
  x: number;
  z?: number;
  /** Legacy alias for z (scene-y era call sites). */
  y?: number;
  /** Hole depth measured down from the stock top. */
  depth: number;
}

/** Generate drill toolpath for a list of hole positions. */
export function generateDrillToolpath(
  holes: DrillHole[],
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList(params);
  const safe = safeY(params);
  // Pre-plunge clearance (the drill R plane): the fixed 2 mm approach, never
  // higher than the traverse margin so a tight safeZAboveStock is honored.
  const retract = params.stockTop + Math.min(2, safeMargin(params));

  for (const hole of holes) {
    const v = hole.z ?? hole.y ?? 0;
    // Position at safe height, drop to the retract plane, plunge, retract.
    m.rapid({ x: hole.x, y: safe, z: v });
    m.rapid({ x: hole.x, y: retract, z: v });
    // Depth is measured down from the stock surface, not absolute Z.
    m.plunge({ x: hole.x, y: params.stockTop - hole.depth, z: v });
    m.rapid({ x: hole.x, y: safe, z: v });
  }

  return {
    id: genId('tp'),
    name: `Drill ${holes.length} holes`,
    operation: 'drill',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

/** Generate face milling toolpath: full-width zigzag, level by level. */
export function generateFaceToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList(params);
  const safe = safeY(params);
  const sover = Math.max(0.1, Math.min(params.stepover, tool.diameter * 0.75));

  // Overshoot the stock edges by the tool diameter so the face is fully cut.
  const uMin = bounds.min.x - tool.diameter;
  const uMax = bounds.max.x + tool.diameter;
  const rows = rowPositions(bounds.min.z, bounds.max.z, sover);
  const levels = depthLevels(params);

  let forward = true;
  for (let li = 0; li < levels.length; li++) {
    const yLevel = levels[li]!;
    const yPrev = li === 0 ? params.stockTop : levels[li - 1]!;
    const feedPlane = li === 0 ? params.stockTop + 1 : yPrev + 1;
    let firstEntry = li === 0;

    for (const v of rows) {
      const uA = forward ? uMin : uMax;
      const uB = forward ? uMax : uMin;
      m.rapid({ x: uA, y: safe, z: v });

      if (firstEntry) {
        // Feed plane on the first entry too (never rapid onto the surface).
        m.rapid({ x: uA, y: feedPlane, z: v });
        const ramp = rampLength(tool, yPrev - yLevel, Math.abs(uB - uA));
        const uRamp = uA + Math.sign(uB - uA) * ramp;
        m.cut({ x: uRamp, y: yLevel, z: v });
        m.cut({ x: uB, y: yLevel, z: v });
        firstEntry = false;
      } else {
        m.rapid({ x: uA, y: feedPlane, z: v });
        m.plunge({ x: uA, y: yLevel, z: v });
        m.cut({ x: uB, y: yLevel, z: v });
      }
      m.rapid({ x: uB, y: safe, z: v });
      forward = !forward;
    }
  }

  return {
    id: genId('tp'),
    name: 'Face Mill',
    operation: 'face',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}
