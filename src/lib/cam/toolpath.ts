import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import type { SolidBody, Vec3 } from '../geometry/types';
import {
  topSilhouette,
  scanlineIntervals,
  subtractIntervals,
  pointInPolygon,
  polygonArea,
  type Point2,
} from './silhouette';
import { offsetRegion, type RegionComponent } from './offsetRegion';
import { planAdaptiveClearing, type AdaptiveClearingPlan } from './trochoid';
import { planCirclesFromBodies, matchArcRuns, type ArcRun } from './arcSources';

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
  cut(p: { x: number; y: number; z: number; feedRate?: number; arcTo?: ToolpathPoint['arcTo'] }): void {
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

/** Vertex-average centroid — a search target for placement, not the exact area centroid. */
function polygonCentroid(pts: Point2[]): Point2 {
  let cu = 0;
  let cv = 0;
  for (const p of pts) {
    cu += p.u;
    cv += p.v;
  }
  return { u: cu / pts.length, v: cv / pts.length };
}

/** Squared distance from point p to segment a→b in the u/v plane. */
function distPointSegmentSq(p: Point2, a: Point2, b: Point2): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  const t = lenSq < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
  const eu = p.u - (a.u + t * du);
  const ev = p.v - (a.v + t * dv);
  return eu * eu + ev * ev;
}

/** Exact containment radius: the distance from `center` to the nearest
 * boundary edge of the clearing region (outer polygon + grown islands). The
 * disc(center, d) fits the region iff d ≤ this — no sampling, so narrow wall
 * spikes between sample angles can no longer slip through (pass #34 review
 * P2: a 0.4 mm fjord at 37.5° passed the old 24+4-sample circle check while
 * actually overlapping the wall). */
function distanceToRegionBoundary(center: Point2, region: Point2[], islands: Point2[][]): number {
  let bestSq = Infinity;
  const scan = (poly: Point2[]): void => {
    for (let i = 0; i < poly.length; i++) {
      bestSq = Math.min(bestSq, distPointSegmentSq(center, poly[i]!, poly[(i + 1) % poly.length]!));
    }
  };
  scan(region);
  for (const isl of islands) scan(isl);
  return Math.sqrt(bestSq);
}

/** Largest helix radius ρ at `center` whose swept disc (radius r + ρ) fits
 * the region; null once ρ would drop below 0.05·r (the helix does not fit at
 * this centre). */
function helixRadiusAt(center: Point2, region: Point2[], islands: Point2[][], r: number): number | null {
  if (!pointInPolygon(center, region)) return null;
  for (const isl of islands) if (pointInPolygon(center, isl)) return null;
  const clearance = distanceToRegionBoundary(center, region, islands) - r;
  const rho = Math.min(0.9 * r, clearance);
  return rho >= 0.05 * r ? rho : null;
}

/**
 * Safe helix-entry placement. The helix sweeps a full disc of radius r + ρ
 * around its centre, so that disc must sit entirely inside the clearing
 * region (inside the outer inset, outside the grown islands). The nominal
 * entry point sits ON the region boundary (a scanline edge, a ring vertex),
 * where no positive-radius disc ever fits, so candidate centres march from
 * the nominal point toward the region centroid; the candidate with the
 * LARGEST ρ wins (earlier candidates break ties) — a tiny ρ near the wall
 * would need so many revolutions that the cap below rejects it anyway.
 */
function planHelixEntry(
  nominal: Point2,
  region: Point2[],
  islands: Point2[][],
  r: number,
): { center: Point2; radius: number } | null {
  const centroid = polygonCentroid(region);
  const total = Math.hypot(centroid.u - nominal.u, centroid.v - nominal.v);
  const step = Math.max(0.2 * r, 1e-9);
  const steps = Math.max(1, Math.ceil(total / step - 1e-9));
  let best: { center: Point2; radius: number } | null = null;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const c = {
      u: nominal.u + (centroid.u - nominal.u) * f,
      v: nominal.v + (centroid.v - nominal.v) * f,
    };
    const rho = helixRadiusAt(c, region, islands, r);
    if (rho !== null && (best === null || rho > best.radius + 1e-9)) {
      best = { center: c, radius: rho };
    }
  }
  return best;
}

/** Helix revolutions for a descent at radius ρ (pitch = 2πρ·tan15°). Capped
 * at 3: a longer descent needs such a tight pitch that the legacy linear
 * ramp is the better entry → null tells the caller to fall back. */
function helixRevolutions(descend: number, rho: number): number | null {
  const pitch = 2 * Math.PI * rho * Math.tan((15 * Math.PI) / 180);
  if (!(pitch > 1e-9)) return null;
  const revs = Math.ceil(descend / pitch - 1e-9);
  return revs >= 1 && revs <= 3 ? revs : null;
}

/**
 * Approximate max-inscribed-circle centre of one region component: a fixed
 * 24×24 grid over the component's bbox, maximising the exact containment
 * radius (distanceToRegionBoundary) among inside samples. The grid is fine
 * relative to tool-scale annuli (a 6 mm gap spans ~5 cells), deterministic
 * (lexicographic i/j scan, strict > keeps the first maximum), and cheap
 * (~600 samples × boundary edges). Returns null when no grid sample falls
 * strictly inside the component.
 */
function maxInscribedCenter(reg: RegionComponent): Point2 | null {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of reg.outer) {
    minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
    minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
  }
  if (!(maxU > minU) || !(maxV > minV)) return null;
  const N = 24;
  let best: Point2 | null = null;
  let bestD = -1;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const c = { u: minU + ((maxU - minU) * i) / N, v: minV + ((maxV - minV) * j) / N };
      if (!pointInPolygon(c, reg.outer)) continue;
      if (reg.holes.some((h) => pointInPolygon(c, h))) continue;
      const d = distanceToRegionBoundary(c, reg.outer, reg.holes);
      if (d > bestD + 1e-12) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

/** Polyline segments per helix revolution (≥ 20 keeps the chord error small). */
const HELIX_SEGMENTS = 24;

/**
 * Emit the helical entry: `revs` revolutions of polyline cut moves descending
 * uniformly from feedPlane to yLevel, then one full flat revolution AT
 * yLevel (Fusion-style true-up) so the floor under the entry is level. The
 * tool ends at the helix start point (centre + ρ on the +u axis) at yLevel —
 * the descent moves carry xy travel, so they run at the cut feed like the
 * legacy linear ramp, not the plunge feed.
 */
function emitHelixEntry(
  m: MoveList,
  plan: { center: Point2; radius: number },
  feedPlane: number,
  yLevel: number,
  revs: number,
): void {
  const total = revs * HELIX_SEGMENTS;
  for (let i = 1; i <= total; i++) {
    const a = (i / HELIX_SEGMENTS) * 2 * Math.PI;
    m.cut({
      x: plan.center.u + Math.cos(a) * plan.radius,
      y: feedPlane + ((yLevel - feedPlane) * i) / total,
      z: plan.center.v + Math.sin(a) * plan.radius,
    });
  }
  for (let i = 1; i <= HELIX_SEGMENTS; i++) {
    const a = (i / HELIX_SEGMENTS) * 2 * Math.PI;
    m.cut({
      x: plan.center.u + Math.cos(a) * plan.radius,
      y: yLevel,
      z: plan.center.v + Math.sin(a) * plan.radius,
    });
  }
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

  // The top-view silhouette, computed once: it drives both the cleared-region
  // erosion and the island keep-out boxes below. Cleared region(s) = the
  // silhouette eroded by the cutter radius (+ allowance) with islands grown
  // by the same amount, computed as ONE region offset (clipper-backed)
  // instead of per-loop miter insets. Three behavioural upgrades over the
  // legacy offsetPolygon pass:
  // - concave wall corners erode to rounded fillets (the geometrically exact
  //   cutter-centre locus; the miter version claimed sharp corners it could
  //   not reach and could self-intersect into them);
  // - an island grown into a wall merges with it — the region stays correct
  //   where the old independent offsets could overlap each other;
  // - a concave region whose erosion SPLITS (e.g. a slot island dividing the
  //   pocket) comes back as several components, each machined below (the old
  //   code silently milled only the single miter ring).
  // An empty erosion still means the tool does not fit anywhere — the legacy
  // "tool too large" empty toolpath.
  const sil = options.body ? topSilhouette(options.body) : null;
  let regions: RegionComponent[] = [];
  if (sil) {
    regions = offsetRegion(
      sil.outer.points,
      sil.islands.map((l) => l.points),
      -(r + allowance),
    );
  }
  if (regions.length === 0) {
    if (options.body) {
      // The tool does NOT fit the silhouette (erosion empty or degenerated).
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
    let outer: Point2[];
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
    regions = [{ outer, holes: [] }];
  }

  const regionRows = regions.map((reg) => {
    // Inset rows by 1 µm: a scanline exactly on an apex vertex of the polygon
    // finds no crossings, which would drop the clamped first/last rows.
    const vMin = Math.min(...reg.outer.map((p) => p.v));
    const vMax = Math.max(...reg.outer.map((p) => p.v));
    return rowPositions(vMin + 1e-6, vMax - 1e-6, sover);
  });
  const levels = depthLevels(params);
  const linkRows = options.linkRows !== false;

  // Axis-aligned keep-out boxes of the islands grown by r+allowance. These
  // are deliberately derived from the RAW silhouette islands (bbox expanded
  // by the growth — exact for a disc dilation) and NOT from the region
  // components: an island grown into the wall merges with the region
  // boundary (or splits the region in two) and stops appearing as a
  // component hole, but links must still never cross it.
  const islandBoxes = sil
    ? sil.islands.map((isl) => {
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const p of isl.points) {
          minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
          minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
        }
        return {
          minU: minU - r - allowance, maxU: maxU + r + allowance,
          minV: minV - r - allowance, maxV: maxV + r + allowance,
        };
      })
    : [];

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

  /** True when the straight chord a→b stays inside ONE cleared component
   * (its outer minus islands). Islands are rejected EXACTLY: every island's
   * grown AABB is tested against the chord segment, so a narrow island
   * parked at the chord's start (before the first quarter-sample) can no
   * longer slip through — the old 3-point sample (t=.25/.5/.75) gouged
   * exactly there when a row's intervals alternate direction across a narrow
   * slot. All three samples must fall inside the SAME component: components
   * are separated by material the tool cannot clear (an island grown
   * through, or a neck narrower than the cutter), so an inter-component
   * chord ploughs exactly that — reject it and take the retract detour.
   * Within one component the outer boundary is still only sampled at the
   * quarter/mid points: a strongly concave outline can push a chord outside
   * between samples, so this stays a conservative guard; anything doubtful
   * falls back to the retract detour. */
  const canLink = (a: Point2, b: Point2): boolean => {
    for (const box of islandBoxes) if (segmentHitsBox(a, b, box)) return false;
    const samples = [0.25, 0.5, 0.75].map((t) => ({
      u: a.u + (b.u - a.u) * t,
      v: a.v + (b.v - a.v) * t,
    }));
    return regions.some(
      (reg) =>
        samples.every(
          (p) =>
            pointInPolygon(p, reg.outer) &&
            !reg.holes.some((h) => pointInPolygon(p, h)),
        ),
    );
  };

  /**
   * Contour-parallel ring family (pocketStrategy 'offset'), clipper-backed so
   * it now covers CONCAVE outlines and ISLANDS (the legacy offsetPolygon ring
   * family was gated to island-free convex regions — its centroid-inradius
   * guard truncated concave shapes at 53.8% swept coverage, pass #34 review).
   * Ring depth k = the level-0 cleared region eroded by a further k·stepover
   * — always offset from the base region, never iteratively, so offset error
   * cannot accumulate. Each depth yields one RegionComponent per connected
   * piece; every component contributes its outer ring AND one ring per hole
   * (the grown-island boundary — those are cutting loops too). The family
   * stops at the first depth that erodes to nothing; a component whose net
   * area collapses under ~a sixteenth of the tool disc is dropped as dust at
   * that depth (its remaining core is smaller than the cutter's meaningful
   * sweep — the same truncation the single-ring era applied to the family).
   *
   * Winding (climb under M3 keeps the material on the RIGHT of travel):
   * - depth-0 outer rings hug the pocket wall with material OUTSIDE the
   *   loop → CCW puts it on the right — the same direction as the helix
   *   entry, so the entry and the wall ring agree;
   * - deeper outer rings engage the uncleared core INSIDE the loop → CW;
   * - hole rings (grown islands) always carry the island material INSIDE
   *   the loop → CW at every depth.
   * reverseLoop keeps the start vertex stable in either direction.
   * Within a depth the loops are ordered nearest-neighbour from wherever the
   * tool finished the previous loop (depths themselves stay ordered — an
   * outer ring must not full-slot into a core a shallower ring has not
   * cleared yet); the depth-0 loops keep their natural order so the wall
   * ring always leads.
   */
  const ringPaths: Point2[][] = [];
  let ringFinishCount = 0; // depth-0 loops (wall + island rings) for wallFinishPass
  if (params.pocketStrategy === 'offset') {
    // Where the tool stands between loops (a closed loop ends on its start).
    let pos: Point2 | null = null;
    for (let k = 0; ; k++) {
      const slice =
        k === 0
          ? regions // delta≈0: offsetRegion would return the region verbatim — skip the call
          : regions.flatMap((reg) => offsetRegion(reg.outer, reg.holes, -k * sover));
      const loops: Point2[][] = [];
      let kept = 0;
      for (const comp of slice) {
        const net =
          Math.abs(polygonArea(comp.outer)) -
          comp.holes.reduce((s, h) => s + Math.abs(polygonArea(h)), 0);
        if (net < (Math.PI * r * r) / 16) continue; // dust at this depth
        loops.push(k === 0 ? comp.outer : reverseLoop(comp.outer));
        for (const hole of comp.holes) loops.push(hole); // already CW
        kept++;
      }
      if (kept === 0) break; // deeper rings can only be smaller
      // Nearest-neighbour ordering of this depth's loops (greedy from the
      // previous loop's end) reduces retract detours between components.
      if (pos !== null) {
        const remaining = [...loops];
        const ordered: Point2[][] = [];
        while (remaining.length > 0) {
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = Math.hypot(remaining[i]![0]!.u - pos!.u, remaining[i]![0]!.v - pos!.v);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          const next = remaining.splice(best, 1)[0]!;
          ordered.push(next);
          pos = next[0]!;
        }
        loops.length = 0;
        loops.push(...ordered);
      } else {
        pos = loops[loops.length - 1]![0]!;
      }
      if (k === 0) ringFinishCount = loops.length;
      ringPaths.push(...loops);
    }
  }
  const useOffset = ringPaths.length > 0;

  /**
   * Adaptive (trochoidal) clearing plan (pocketStrategy 'adaptive'): the
   * reference walks — medial trochoid chain first, direct crescent rings
   * outward, wall ring last — are computed ONCE because the 2D clearing
   * domain is identical at every depth level; each level re-walks them.
   * The empty-region semantics are shared with the strategies above (the
   * tool-too-large early return already happened), so an empty plan here
   * would mean "no ring at all fits" — impossible for a non-empty region —
   * and the raster fallback below stands as the defensive net.
   */
  const adaptivePlan: AdaptiveClearingPlan | null =
    params.pocketStrategy === 'adaptive'
      ? planAdaptiveClearing(regions, {
          toolDiameter: tool.diameter,
          stepoverCap: params.stepover,
          engagementDeg: params.adaptiveEngagementDeg,
        })
      : null;
  const useAdaptive = adaptivePlan !== null && adaptivePlan.paths.length > 0;

  /**
   * Cut one full closed loop at yLevel, entering from wherever the tool
   * stands: a straight cut link when the chord stays inside the region
   * (everything between already-cleared passes), otherwise the standard
   * retract→traverse→feed-plane→plunge detour. Returns the loop's start.
   */
  const cutLoop = (path: Point2[], yLevel: number, feedPlane: number, from: Point2 | null): Point2 => {
    const start = path[0]!;
    if (from !== null && linkRows && canLink(from, start)) {
      m.cut({ x: start.u, y: yLevel, z: start.v });
    } else {
      if (from !== null) m.rapid({ x: from.u, y: safe, z: from.v });
      m.rapid({ x: start.u, y: safe, z: start.v });
      m.rapid({ x: start.u, y: feedPlane, z: start.v });
      m.plunge({ x: start.u, y: yLevel, z: start.v });
    }
    const arcs = loopArcs(path);
    const L = loopLength(path, arcs);
    cutProfiledSpan(m, path, arcs, L, 0, L, () => yLevel, spanStops(path, arcs, 0, L, []));
    return start;
  };

  let forward = true;
  for (let li = 0; li < levels.length; li++) {
    const yLevel = levels[li]!;
    const yPrev = li === 0 ? params.stockTop : levels[li - 1]!;
    // Rapid descent stops 1 mm above the previously cut surface; the very
    // first entry of the program ramps instead of plunging.
    const feedPlane = li === 0 ? params.stockTop + 1 : yPrev + 1;
    let firstEntry = li === 0;
    // Where the cutter stands between passes at THIS level. Null before
    // the first entry and after each level-end retract.
    let rowEnd: Point2 | null = null;

    if (adaptivePlan !== null && useAdaptive) {
      /**
       * One adaptive walk path: linked cut when the chord guard accepts it
       * (everything between consecutive reference walks is already swept),
       * otherwise the standard retract→traverse→feed-plane→plunge detour.
       * Path points ride at yLevel; the planner guarantees every point and
       * chord inside the tool-centre domain (see cam/trochoid.ts).
       */
      /**
       * Helical descent along an entry orbit (≤32 revolutions — deep
       * adaptive levels routinely need more than the legacy 3 at the small
       * orbit radius; a straight ramp cannot follow an orbit chain).
       */
      const emitOrbitEntry = (eo: { center: Point2; radius: number }): Point2 => {
        const pitch = 2 * Math.PI * eo.radius * Math.tan((15 * Math.PI) / 180);
        const revs = pitch > 1e-9
          ? Math.min(32, Math.max(1, Math.ceil((feedPlane - yLevel) / pitch - 1e-9)))
          : 1;
        const hs: Point2 = { u: eo.center.u + eo.radius, v: eo.center.v };
        m.rapid({ x: hs.u, y: safe, z: hs.v });
        m.rapid({ x: hs.u, y: feedPlane, z: hs.v });
        emitHelixEntry(m, eo, feedPlane, yLevel, revs);
        return hs;
      };

      const cutAdaptivePath = (path: Point2[], pi: number): Point2 => {
        const start = path[0]!;
        // Finish (depth-0 wall-side) paths never take links: the last corner
        // hand-off chord would cross the still-uncut corner wedge left for
        // the finish pass itself (measured ~38° equivalent vs the budget's
        // 36°); the finish entry takes the retract detour instead.
        const isFinish = pi >= adaptivePlan.finishFrom;
        const linkDist =
          rowEnd !== null ? Math.hypot(start.u - rowEnd.u, start.v - rowEnd.v) : Infinity;
        if (
          rowEnd !== null && linkRows && !isFinish && canLink(rowEnd, start) &&
          linkDist <= adaptivePlan.linkMax
        ) {
          m.cut({ x: start.u, y: yLevel, z: start.v });
        } else {
          if (rowEnd !== null) m.rapid({ x: rowEnd.u, y: safe, z: rowEnd.v });
          // A virgin entry (a component's first chain — split lobes, the
          // medial remnant) must not plunge straight into uncut material:
          // descend along the path's own first orbit instead (doc §1.4
          // re-entry rule). NOTE: this intentionally overrides the legacy
          // params.helixEntry / rampEntry switches — a vertical or linear
          // ramp entry into a virgin core is a full-slot engagement by
          // definition, so the orbit helix is the safe direction regardless
          // of how those legacy entries are set. Only the first level:
          // deeper levels plunge through air above already-cleared ground.
          const eo = adaptivePlan.pathEntries[pi] ?? null;
          if (li === 0 && eo !== null) {
            const hs = emitOrbitEntry(eo);
            m.cut({ x: start.u, y: yLevel, z: start.v });
            void hs;
          } else {
            m.rapid({ x: start.u, y: safe, z: start.v });
            m.rapid({ x: start.u, y: feedPlane, z: start.v });
            m.plunge({ x: start.u, y: yLevel, z: start.v });
          }
        }
        for (let i = 1; i < path.length; i++) {
          const p = path[i]!;
          m.cut({ x: p.u, y: yLevel, z: p.v });
        }
        return path[path.length - 1]!;
      };

      for (let pi = 0; pi < adaptivePlan.paths.length; pi++) {
        const path = adaptivePlan.paths[pi]!;
        if (firstEntry) {
          firstEntry = false;
          const start = path[0]!;
          if (params.helixEntry === true) {
            // Helix placement ladder (same shape as the offset branch): the
            // first walk's start, then the chain's entry-orbit centre (it
            // sits at the erosion boundary where room = the erosion depth),
            // then every component's max-inscribed centre. Falls through to
            // cutAdaptivePath's own orbit descent when no ≤3-rev plan exists.
            let helix: { center: Point2; radius: number } | null = null;
            const seeds: Point2[] = [start];
            if (adaptivePlan.entryOrbit) seeds.push(adaptivePlan.entryOrbit.center);
            for (const cand of seeds) {
              const reg = regions.find((rg) => pointInPolygon(cand, rg.outer)) ?? regions[0]!;
              helix = planHelixEntry(cand, reg.outer, reg.holes, r);
              if (helix !== null) break;
            }
            if (helix === null) {
              for (const reg of regions) {
                const c = maxInscribedCenter(reg);
                if (!c) continue;
                helix = planHelixEntry(c, reg.outer, reg.holes, r);
                if (helix !== null) break;
              }
            }
            const revs = helix !== null ? helixRevolutions(feedPlane - yLevel, helix.radius) : null;
            if (helix !== null && revs !== null) {
              const hs: Point2 = { u: helix.center.u + helix.radius, v: helix.center.v };
              m.rapid({ x: hs.u, y: safe, z: hs.v });
              m.rapid({ x: hs.u, y: feedPlane, z: hs.v });
              emitHelixEntry(m, helix, feedPlane, yLevel, revs);
              rowEnd = hs;
            }
          }
          rowEnd = cutAdaptivePath(path, pi);
        } else {
          rowEnd = cutAdaptivePath(path, pi);
        }
      }
      // Wall finish pass: re-walk the depth-0 (wall-side) loops — spring-pass
      // semantics, the same idea as the offset strategy's finish.
      if (params.wallFinishPass === true) {
        for (let pi = adaptivePlan.finishFrom; pi < adaptivePlan.paths.length; pi++) {
          rowEnd = cutAdaptivePath(adaptivePlan.paths[pi]!, pi);
        }
      }
    } else if (useOffset) {
      // Contour-parallel clearing: wall ring first, then inward ring by ring.
      for (const path of ringPaths) {
        if (firstEntry) {
          firstEntry = false;
          const start = path[0]!;
          let helixEnd: Point2 | null = null;
          if (params.helixEntry === true) {
            // The nominal helix seed is searched over deterministic
            // candidates: the seed ring's quartile starts (the historical
            // nominal is quartile 0), then every component's grid-sampled
            // max-inscribed-circle centre. With islands, the second loop's
            // start sits ON the grown island — every march candidate toward
            // the outer centroid crosses the island and the whole seed
            // family fails; the inscribed centre of the annular free gap is
            // what recovers a placeable swept disc. First candidate whose
            // plan is non-null wins; when they all fail, the linear ramp
            // fallback below stands (unchanged semantics).
            const seedRing = ringPaths.length > 1 ? ringPaths[1]! : path;
            let plan: { center: Point2; radius: number } | null = null;
            for (const q of [0, 0.25, 0.5, 0.75]) {
              const cand = seedRing[Math.min(seedRing.length - 1, Math.floor(q * seedRing.length))]!;
              const reg = regions.find((rg) => pointInPolygon(cand, rg.outer)) ?? regions[0]!;
              plan = planHelixEntry(cand, reg.outer, reg.holes, r);
              if (plan !== null) break;
            }
            if (plan === null) {
              for (const reg of regions) {
                const c = maxInscribedCenter(reg);
                if (!c) continue;
                plan = planHelixEntry(c, reg.outer, reg.holes, r);
                if (plan !== null) break;
              }
            }
            const revs = plan !== null ? helixRevolutions(feedPlane - yLevel, plan.radius) : null;
            if (plan !== null && revs !== null) {
              const hs: Point2 = { u: plan.center.u + plan.radius, v: plan.center.v };
              m.rapid({ x: hs.u, y: safe, z: hs.v });
              m.rapid({ x: hs.u, y: feedPlane, z: hs.v });
              emitHelixEntry(m, plan, feedPlane, yLevel, revs);
              helixEnd = hs;
            }
          }
          if (helixEnd !== null) {
            rowEnd = cutLoop(path, yLevel, feedPlane, helixEnd);
          } else {
            m.rapid({ x: start.u, y: safe, z: start.v });
            m.rapid({ x: start.u, y: feedPlane, z: start.v });
            const arcs = loopArcs(path);
            const L = loopLength(path, arcs);
            const ramp = rampLength(tool, yPrev - yLevel, L);
            if (ramp > 1e-6) {
              // Ramp along the ring itself, following its vertices — a chord
              // of the wall-hugging ring would cut the corner into the wall.
              const descent = (s: number): number => feedPlane + ((yLevel - feedPlane) * s) / ramp;
              cutProfiledSpan(
                m, path, arcs, L, 0, ramp, descent,
                spanStops(path, arcs, 0, ramp, [], [ramp / 2]),
              );
              if (ramp < L - 1e-9) {
                cutProfiledSpan(
                  m, path, arcs, L, ramp, L, () => yLevel,
                  spanStops(path, arcs, ramp, L, []),
                );
              }
            } else {
              m.plunge({ x: start.u, y: yLevel, z: start.v });
              cutProfiledSpan(
                m, path, arcs, L, 0, L, () => yLevel,
                spanStops(path, arcs, 0, L, []),
              );
            }
            rowEnd = start;
          }
        } else {
          rowEnd = cutLoop(path, yLevel, feedPlane, rowEnd);
        }
      }
      // Wall finish pass: the depth-0 loops once more — the wall ring CCW
      // (climb on the wall side — material outside the loop sits on the right
      // when CCW) and every grown-island ring CW (material inside the loop ⇒
      // climb keeps it on the right). Re-walking them is intended —
      // spring-pass semantics, the same idea as Fusion/Mastercam finish
      // passes, and the exact ring set the raster finish uses.
      if (params.wallFinishPass === true) {
        for (const path of ringPaths.slice(0, ringFinishCount)) {
          rowEnd = cutLoop(path, yLevel, feedPlane, rowEnd);
        }
      }
    } else {
      // Where the cutter stands between passes at THIS level (the zigzag
      // alternates direction, so it is each interval's far end). One raster
      // sweep per cleared component; the entry/link state flows across them.
      for (let ri = 0; ri < regions.length; ri++) {
        const region = regions[ri]!;
        for (const v of regionRows[ri]!) {
          const base = scanlineIntervals(region.outer, v);
          const blocked = region.holes.flatMap((poly) => scanlineIntervals(poly, v));
          const intervals = subtractIntervals(base, blocked);

          for (const [ua, ub] of intervals) {
            const uA = forward ? ua : ub;
            const uB = forward ? ub : ua;
            // How far along the row the ENTRY moves already cut (the first-entry
            // ramp may have covered part of it).
            let cutTo = uA;

            // Helical first entry: the validated disc sweeps the descent, the
            // flat true-up circle levels the floor, and the exit links to the
            // row start (cut when the chord stays inside, else the detour).
            let helixed = false;
            if (firstEntry && params.helixEntry === true) {
              const plan = planHelixEntry({ u: uA, v }, region.outer, region.holes, r);
              const revs = plan !== null ? helixRevolutions(feedPlane - yLevel, plan.radius) : null;
              if (plan !== null && revs !== null) {
                const hs: Point2 = { u: plan.center.u + plan.radius, v: plan.center.v };
                m.rapid({ x: hs.u, y: safe, z: hs.v });
                m.rapid({ x: hs.u, y: feedPlane, z: hs.v });
                emitHelixEntry(m, plan, feedPlane, yLevel, revs);
                if (linkRows && canLink(hs, { u: uA, v })) {
                  m.cut({ x: uA, y: yLevel, z: v });
                } else {
                  m.rapid({ x: hs.u, y: safe, z: hs.v });
                  m.rapid({ x: uA, y: safe, z: v });
                  m.rapid({ x: uA, y: feedPlane, z: v });
                  m.plunge({ x: uA, y: yLevel, z: v });
                }
                // The row itself is still uncut (the helix disc swept a circle
                // off the row), so cutTo stays at uA.
                helixed = true;
                firstEntry = false;
              }
            }

            if (!helixed) {
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
            }
            if (Math.abs(uB - cutTo) > 1e-6) m.cut({ x: uB, y: yLevel, z: v });
            rowEnd = { u: uB, v };
            forward = !forward;
          }
        }
      }
      // Wall finish pass (raster): after clearing the level, one extra loop
      // along the wall-side boundary of every component — the cleared-region
      // boundary itself, CCW (material outside the loop ⇒ climb keeps it on
      // the right) — plus one loop around every grown island, CW (material
      // inside the loop ⇒ climb keeps it on the right). Islands the tool
      // cannot fit never made it into the region.
      if (params.wallFinishPass === true) {
        for (const region of regions) {
          const wallLoop = polygonArea(region.outer) > 0 ? [...region.outer] : reverseLoop(region.outer);
          rowEnd = cutLoop(wallLoop, yLevel, feedPlane, rowEnd);
          for (const island of region.holes) {
            const islandLoop = polygonArea(island) > 0 ? reverseLoop(island) : island;
            rowEnd = cutLoop(islandLoop, yLevel, feedPlane, rowEnd);
          }
        }
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

/** Contour holding tabs after validation (see CAMParameters.tabs). */
interface ContourTabs {
  count: number;
  height: number;
  width: number;
}

/**
 * Validate the tab spec. A count below 1 or a non-positive height/width (also
 * any non-finite value) silently disables tabs — the loop is cut through at
 * full depth, exactly the legacy behaviour.
 */
function validTabs(tabs: CAMParameters['tabs']): ContourTabs | null {
  if (!tabs) return null;
  const { count, height, width } = tabs;
  if (!Number.isFinite(count) || !Number.isFinite(height) || !Number.isFinite(width)) return null;
  if (count < 1 || height <= 0 || width <= 0) return null;
  return { count, height, width };
}

/**
 * Reverse a closed loop's winding while keeping its start vertex, so the
 * rapid/plunge entry point of a loop does not move when the cut direction
 * flips.
 */
function reverseLoop(points: Point2[]): Point2[] {
  return [points[0]!, ...points.slice(1).reverse()];
}

/** Cumulative arc length at each vertex of a closed loop (vertex 0 → 0). */
function loopArcs(path: Point2[]): number[] {
  const s = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    s.push(s[i - 1]! + Math.hypot(b.u - a.u, b.v - a.v));
  }
  return s;
}

/** Total arc length of a closed loop, closing edge included. */
function loopLength(path: Point2[], arcs: number[]): number {
  const a = path[path.length - 1]!;
  const b = path[0]!;
  return arcs[arcs.length - 1]! + Math.hypot(b.u - a.u, b.v - a.v);
}

/** Point at arc length s ∈ [0, L] along the closed loop. */
function loopPointAt(path: Point2[], arcs: number[], L: number, s: number): Point2 {
  if (s >= L - 1e-9) return path[0]!;
  let lo = 0;
  let hi = arcs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arcs[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = path[lo]!;
  const b = path[lo + 1 < path.length ? lo + 1 : 0]!;
  const segLen = lo + 1 < arcs.length ? arcs[lo + 1]! - arcs[lo]! : L - arcs[lo]!;
  if (segLen <= 1e-12) return a;
  const f = (s - arcs[lo]!) / segLen;
  return { u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f };
}

/**
 * Tab height profile along one closed loop for one cut level. Centres sit at
 * (i + ½)·L/count by arc length; each tab spans `width` with linear ramps of
 * min(width·0.4, 2 mm) at both ends and a flat top at `tabTop` (height above
 * the FINAL level, so shallower levels simply ride higher). `breaks` are the
 * arc positions where the profile kinks.
 *
 * The height is the UPPER ENVELOPE of all tabs. With the ½-spacing centre
 * offset, an interval can only cross the loop seam when width > L/count —
 * i.e. exactly when neighbours overlap — and taking the max merges them
 * instead of letting one tab's ramp dip below another's top (which would mill
 * into the tab). The seam-crossing itself is handled by wrapping the signed
 * arc distance to [−L/2, L/2).
 */
function makeTabProfile(
  L: number,
  yLevel: number,
  tabTop: number,
  tabs: ContourTabs,
): { yAt: (s: number) => number; breaks: number[] } {
  const spacing = L / tabs.count;
  const half = tabs.width / 2;
  const ramp = Math.min(tabs.width * 0.4, 2);
  const lift = tabTop - yLevel;
  const wrapHalf = (d: number): number => ((d + L / 2) % L + L) % L - L / 2;
  const yAt = (s: number): number => {
    let y = yLevel;
    for (let i = 0; i < tabs.count; i++) {
      const x = Math.abs(wrapHalf(s - (i + 0.5) * spacing));
      if (x < half) y = Math.max(y, yLevel + lift * Math.min(1, (half - x) / ramp));
    }
    return y;
  };
  const raw: number[] = [];
  for (let i = 0; i < tabs.count; i++) {
    const c = (i + 0.5) * spacing;
    for (const b of [c - half, c - half + ramp, c + half - ramp, c + half]) {
      const wrapped = ((b % L) + L) % L;
      if (wrapped > 1e-9 && wrapped < L - 1e-9) raw.push(wrapped);
    }
  }
  raw.sort((a, b) => a - b);
  return { yAt, breaks: raw.filter((s, i) => i === 0 || s - raw[i - 1]! > 1e-7) };
}

/**
 * Cut along the loop from arc `fromS` to `toS` following the height profile
 * `yOf`. Cut points are emitted at the given stops (loop vertices, profile
 * kinks, optional extras) and at `toS`; between stops the profile is verified
 * linear and bisected where it bends, so the emitted polyline never deviates
 * from an upper-envelope profile (overlapping tabs, or a ramp entry crossing
 * a tab flank). The tool is assumed to already stand at (fromS, yOf(fromS));
 * only positions strictly inside (fromS, toS] are emitted.
 *
 * True-arc spans (contour only; empty default keeps the legacy polyline
 * behaviour for every other caller): positions inside a span are generated
 * ON the analytic circle, vertex stops strictly inside a span are dropped
 * while the profile is flat (they would only slice the arc into chords), and
 * a flat move fully inside one span is tagged `arcTo` for the post. Where
 * the profile MOVES (ramp descent, tab flank) the stops stay so the straight
 * chords remain vertex-short — a linear interpolation along a descending arc
 * is a helical move the flat-only G2/G3 contract cannot express, so it
 * degrades to on-circle polyline points by design.
 */
function cutProfiledSpan(
  m: MoveList,
  path: Point2[],
  arcs: number[],
  L: number,
  fromS: number,
  toS: number,
  yOf: (s: number) => number,
  stops: number[],
  spans: ArcSpan[] = [],
): void {
  const posAt = (s: number): Point2 => arcSpanPointAt(spans, s) ?? loopPointAt(path, arcs, L, s);
  /** The span fully containing the move [a, b], if any. */
  const spanOver = (a: number, b: number): ArcSpan | undefined =>
    b > a + 1e-9 ? spans.find((sp) => a >= sp.s0 - 1e-7 && b <= sp.s1 + 1e-7) : undefined;
  const cutAt = (s: number, y: number, arc?: ArcSpan): void => {
    const p = posAt(s);
    if (arc) {
      m.cut({ x: p.u, y, z: p.v, arcTo: { center: { x: arc.cu, y, z: arc.cv }, ccw: arc.ccw } });
    } else {
      m.cut({ x: p.u, y, z: p.v });
    }
  };
  let prevS = fromS;
  let prevY = yOf(fromS);
  const emitTo = (s: number): void => {
    const y = yOf(s);
    if (s - prevS > 1e-9) {
      const mid = (prevS + s) / 2;
      if (Math.abs(yOf(mid) - (prevY + y) / 2) > 1e-9) {
        emitTo(mid); // hidden bend in the first half…
        // …and the second half needs the same check: the profile can bend
        // again in (mid, s) (ramp descent crossing a tab flank), so re-run
        // THIS segment against the updated prevS/prevY instead of closing it
        // with an unverified chord (review pass #33: one-sided bisection let
        // such chords ride ~0.08 mm above the envelope).
        return emitTo(s);
      }
    }
    // Arc tag only on verified-flat moves (see the doc comment): emitTo has
    // just proven the profile linear over [prevS, s], so equal endpoint
    // heights make it constant.
    cutAt(s, y, Math.abs(y - prevY) <= 1e-9 ? spanOver(prevS, s) : undefined);
    prevS = s;
    prevY = y;
  };
  // Span ends become stops so every arc lands exactly on its boundary point;
  // interior stops are dropped later while flat (the walk below). Adjacent
  // spans share a boundary s, so dedupe after the sort (the 1e-7 rule of
  // spanStops — a duplicate would emit a zero-length cut move).
  const allStops = [...stops];
  if (spans.length > 0) {
    for (const sp of spans) {
      for (const b of [sp.s0, sp.s1]) {
        if (b > fromS + 1e-9 && b < toS - 1e-9) allStops.push(b);
      }
    }
    allStops.sort((a, b) => a - b);
    for (let i = allStops.length - 1; i > 0; i--) {
      if (allStops[i]! - allStops[i - 1]! <= 1e-7) allStops.splice(i, 1);
    }
  }
  for (const s of allStops) {
    if (
      spans.length > 0 &&
      s > prevS + 1e-9 &&
      Math.abs(yOf(s) - prevY) <= 1e-9 &&
      s < (spanOver(prevS, s)?.s1 ?? -Infinity) - 1e-7
    ) {
      continue; // interior of a flat true-arc span — chord-fodder, skip
    }
    emitTo(s);
  }
  emitTo(toS);
}

/** Sorted arc positions strictly inside (fromS, toS) needing a cut point:
 * loop vertices, profile kinks (tab edges) and optional extras. */
function spanStops(
  path: Point2[],
  arcs: number[],
  fromS: number,
  toS: number,
  breaks: number[],
  extras: number[] = [],
): number[] {
  const out: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const s = arcs[i]!;
    if (s > fromS + 1e-9 && s < toS - 1e-9) out.push(s);
  }
  for (const s of [...breaks, ...extras]) {
    if (s > fromS + 1e-9 && s < toS - 1e-9) out.push(s);
  }
  out.sort((a, b) => a - b);
  return out.filter((s, i) => i === 0 || s - out[i - 1]! > 1e-7);
}

/**
 * One true-arc replacement interval of a contour loop, in the loop's
 * arc-length parameterization: the polyline over (s0, s1] IS the analytic
 * circle (center (cu, cv), radius r) travelled in the `ccw` direction, with
 * `th0`/`sweep` mapping arc length to angle. Ground truth comes from the
 * matched cylinder face tag (see arcSources), so points snapped by
 * arcSpanPointAt carry the tag's exact radius — no re-fit, no tolerance
 * budget spent.
 */
interface ArcSpan {
  s0: number;
  s1: number;
  cu: number;
  cv: number;
  r: number;
  ccw: boolean;
  /** Start angle (rad, atan2 convention in the (u, v) plane). */
  th0: number;
  /** Angular width of this span (rad, positive). */
  sweep: number;
}

/** Sweep cap for true-arc spans — the same 120° ceiling fitArcs applies to
 * fitted arcs, keeping every emitted G2/G3 away from the full-circle regime
 * where near-coincident endpoints are ambiguous for controllers (GRBL). */
const ARC_SPAN_MAX_SWEEP = (120 * Math.PI) / 180;

/** Directed angular step from angle a to b in the given direction, in [0, 2π). */
function directedAngle(a: number, b: number, ccw: boolean): number {
  let d = ccw ? b - a : a - b;
  d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return d;
}

/**
 * Build the true-arc span plan of one oriented loop from its matched runs.
 * Each run becomes an interval of the loop's arc-length axis, then:
 * - a run wrapping the loop seam splits at L (the emission machinery never
 *   wraps mid-span, and the seam vertex is a shared, exactly-on-circle
 *   point);
 * - every interval is clipped at the profile `breaks` (tab edges — an arc
 *   must never span a height lift, and the tab's own widths keep their
 *   exact positions along the path);
 * - every surviving piece is split into ≤120° sub-spans (a full circle
 *   becomes 3 arcs), aligning with the post-processor's sweep cap.
 * Degenerate pieces (no length or no sweep) are dropped — the polyline
 * fallback covers them.
 */
function planLoopArcSpans(
  path: Point2[],
  arcs: number[],
  L: number,
  breaks: number[],
  runs: ArcRun[],
): ArcSpan[] {
  const n = path.length;
  if (n < 2 || runs.length === 0) return [];
  /** Raw interval of one run piece: [s0, s1] with its start angle and sweep. */
  const pieces: Array<{ s0: number; s1: number; th0: number; sweep: number; run: ArcRun }> = [];
  for (const run of runs) {
    const c = run.circle;
    const th = (i: number): number => {
      const p = path[i % n]!;
      return Math.atan2(p.v - c.cv, p.u - c.cu);
    };
    const from = run.from;
    const to = run.to;
    if (from === 0 && to === n - 1) {
      // Full ring anchored at the loop start (the all-on case): one interval
      // over the whole loop, closing edge included. th(to) is th(from) so
      // the directed difference would read 0 — force the full 2π turn.
      pieces.push({ s0: arcs[from]!, s1: L, th0: th(from), sweep: 2 * Math.PI, run });
    } else if (to < n) {
      const sweep = directedAngle(th(from), th(to), run.ccw);
      pieces.push({ s0: arcs[from]!, s1: arcs[to]!, th0: th(from), sweep, run });
    } else {
      // Wraps the seam: two pieces joined at L (the seam vertex is a shared,
      // exactly-on-circle point).
      const sweepA = directedAngle(th(from), th(n - 1), run.ccw);
      const sweepB = directedAngle(th(0), th(to), run.ccw);
      pieces.push({ s0: arcs[from]!, s1: L, th0: th(from), sweep: sweepA, run });
      pieces.push({ s0: 0, s1: arcs[to - n]!, th0: th(0), sweep: sweepB, run });
    }
  }

  const spans: ArcSpan[] = [];
  for (const p of pieces) {
    if (!(p.sweep > 1e-9) || p.s1 - p.s0 <= 1e-9) continue;
    // Split positions: span ends, tab breaks inside, and the equal 120° cuts.
    const cuts = [p.s0, p.s1];
    for (const b of breaks) {
      if (b > p.s0 + 1e-7 && b < p.s1 - 1e-7) cuts.push(b);
    }
    const k = Math.ceil(p.sweep / ARC_SPAN_MAX_SWEEP - 1e-9);
    for (let i = 1; i < k; i++) cuts.push(p.s0 + ((p.s1 - p.s0) * i) / k);
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const s0 = cuts[i - 1]!;
      const s1 = cuts[i]!;
      if (s1 - s0 <= 1e-9) continue;
      const f0 = (s0 - p.s0) / (p.s1 - p.s0);
      const f1 = (s1 - p.s0) / (p.s1 - p.s0);
      const sweep = p.sweep * (f1 - f0);
      if (sweep <= 1e-9) continue;
      spans.push({
        s0, s1,
        cu: p.run.circle.cu, cv: p.run.circle.cv, r: p.run.circle.r,
        ccw: p.run.ccw,
        th0: p.th0 + (p.run.ccw ? 1 : -1) * p.sweep * f0,
        sweep,
      });
    }
  }
  return spans;
}

/**
 * Position on the loop at arc length s, true-arc aware: inside a span the
 * point is generated ON the analytic circle (angle interpolated by arc
 * length — exact at span ends, where every emitted point of consequence
 * sits); outside, null tells the caller to use the polyline interpolation.
 */
function arcSpanPointAt(spans: ArcSpan[], s: number): Point2 | null {
  for (const sp of spans) {
    if (s >= sp.s0 - 1e-7 && s <= sp.s1 + 1e-7) {
      const f = Math.min(1, Math.max(0, (s - sp.s0) / (sp.s1 - sp.s0)));
      const th = sp.th0 + (sp.ccw ? 1 : -1) * sp.sweep * f;
      return { u: sp.cu + sp.r * Math.cos(th), v: sp.cv + sp.r * Math.sin(th) };
    }
  }
  return null;
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

  const offset = tool.diameter / 2 + (options.allowance ?? params.allowance ?? 0);

  // Cut direction under an M3 spindle: climb milling keeps the material on
  // the RIGHT of the travel direction (chip-thickness simulation, pass #34
  // review — the zero-to-max entry happens with material on the LEFT, which
  // is conventional; also matches the easy_cam convention quoted in
  // docs/cnc-algorithms.md). The tool runs OUTSIDE the part on the outer
  // loop, so the enclosed material sits on the right when the loop is CW;
  // island loops have the material OUTSIDE, so climb keeps them CCW
  // (every loop fed to orient() below arrives CCW: silhouette loops are
  // normalised CCW, and the eroded island holes are reversed back to CCW
  // before orient). 'conventional' flips both windings; the start vertex is
  // preserved either way so the entry point never moves. (Pass #33 shipped
  // this inverted — corrected here, see CHANGELOG 0.28.0.)
  const conventional = params.direction === 'conventional';
  const orient = (loop: Point2[], island: boolean): Point2[] =>
    island === conventional ? reverseLoop(loop) : loop;

  // Cutter compensation: outside the outer loop, inside the islands. Computed
  // as ONE region offset (clipper-backed) with default ROUND joins — for a
  // disc cutter the round join is the geometrically exact offset: sweeping
  // the cutter around a convex corner traces exactly a quarter(+) circle of
  // radius r+allowance, which the G-code arc filter posts as G2/G3. (The
  // legacy miter join overshot every corner by up to r·(√2−1)·… — claimed
  // sharp corners the round tool never cut, and its 3.5·delta cap could
  // extend the pass past the rim on obtuse angles.) arcTolerance 0.005
  // (¼ of the library default) keeps each join polyline's chords within the
  // 0.01 mm budget the arc fitter needs to re-merge the corner into ONE
  // G2/G3. Region semantics also make the degenerate cases honest — an
  // island too small for the tool is swallowed by the region (no path,
  // exactly the legacy null-skip), and an island grown into the nearby outer
  // wall merges with it so the emitted path wraps around the island instead
  // of the two independent legacy loops crossing each other over the wall.
  const comps = offsetRegion(
    sil.outer.points,
    sil.islands.map((l) => l.points),
    offset,
    { arcTolerance: 0.005 },
  );
  const paths: Point2[][] = [];
  const pathIsland: boolean[] = [];
  for (const comp of comps) {
    paths.push(orient(comp.outer, false));
    pathIsland.push(false);
    for (const hole of comp.holes) {
      // Eroded island loop (CW from offsetRegion → CCW to match the legacy
      // orient() input winding, start vertex preserved). Holes narrower than
      // a sixteenth of the tool disc are sub-tool debris — skip them, the
      // same threshold the pocket ring family uses for dust.
      if (-polygonArea(hole) < (Math.PI * (tool.diameter / 2) ** 2) / 16) continue;
      paths.push(orient(reverseLoop(hole), true));
      pathIsland.push(true);
    }
  }
  if (paths.length === 0) return empty;

  // True-arc recovery (P2b): analytic vertical-cylinder wall tags are the
  // ground truth the discretized silhouette approximates. Candidate circles
  // are the tags adjusted to the TOOL-CENTRE locus of each oriented loop —
  // outer loops run outside the wall (r + offset), island loops inside the
  // hole (r − offset) — so a matched run can be replaced by an arc on
  // exactly that circle and the emitted radius is the analytic r ± offset,
  // not a re-fit. Matching tolerance: the 20 µm floor widened by the worst
  // offset overshoot the loop's own vertex density can produce on a circular
  // run (the historical miter bound offset·(1/cos(π/n) − 1), exact for a
  // full n-gon circle — with round joins the offset vertices sit ON the
  // true circle and only the join chords deviate, by the 5 µm arcTolerance
  // above, so this stays a conservative ceiling) plus 10 µm slack for the
  // clipper quantization and tag fit. Bodies without cylinder tags (brep
  // primitives, imported meshes) match nothing and keep the pure polyline
  // output byte-for-byte.
  const wallCircles = planCirclesFromBodies([body]);
  const loopRuns: ArcRun[][] = paths.map((path, i) => {
    if (wallCircles.length === 0) return [];
    const candidates = wallCircles
      .map((c) => ({ cu: c.cu, cv: c.cv, r: pathIsland[i] ? c.r - offset : c.r + offset }))
      .filter((c) => c.r > 1e-6);
    if (candidates.length === 0) return [];
    const tol = Math.max(0.02, offset * (1 / Math.cos(Math.PI / Math.max(path.length, 8)) - 1) + 0.01);
    return matchArcRuns(path, candidates, tol);
  });

  const levels = depthLevels(params);
  const tabs = validTabs(params.tabs);
  // Tabs are measured above the FINAL cut level; only levels below the tab
  // top need to lift (deeper than the final level cannot exist).
  const tabTop = tabs
    ? (levels.length > 0 ? levels[levels.length - 1]! : params.stockBottom) + tabs.height
    : Number.NEGATIVE_INFINITY;

  for (let li = 0; li < levels.length; li++) {
    const yLevel = levels[li]!;
    const yPrev = li === 0 ? params.stockTop : levels[li - 1]!;
    const feedPlane = li === 0 ? params.stockTop + 1 : yPrev + 1;

    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi]!;
      const arcs = loopArcs(path);
      const L = loopLength(path, arcs);

      // Height profile along the loop: flat at yLevel, except levels below
      // the tab top ride the tabs (y ∈ [yLevel, tabTop], cut feed throughout).
      const profile =
        tabs !== null && yLevel < tabTop
          ? makeTabProfile(L, yLevel, tabTop, tabs)
          : { yAt: (): number => yLevel, breaks: [] as number[] };
      const yAt = profile.yAt;

      // True-arc spans for THIS level: matched runs clipped at the tab
      // breaks of this level's profile and split into ≤120° pieces.
      const spans = planLoopArcSpans(path, arcs, L, profile.breaks, loopRuns[pi]!);
      // Loop start snapped onto the analytic circle when a span covers s=0 —
      // the plunge, the arc endpoints and the retract all agree exactly.
      const startP = arcSpanPointAt(spans, 0) ?? path[0]!;

      m.rapid({ x: startP.u, y: safe, z: startP.v });
      m.rapid({ x: startP.u, y: feedPlane, z: startP.v });

      let cutFrom = 0;
      if (params.rampEntry === true && li === 0) {
        // Ramp the first-level entry: descend along the path, following its
        // vertices so the move never chords across the offset loop (a chord
        // of a convex section would gouge the wall by its sagitta), lifted
        // over any tab in the way. Inside a true-arc span the ramp vertices
        // stay ON the circle (straight helical chords between neighbours —
        // the flat-only G2/G3 contract cannot express a descending arc).
        const ramp = rampLength(tool, yPrev - yLevel, L);
        if (ramp > 1e-6) {
          const descent = (s: number): number => feedPlane + (yLevel - feedPlane) * (s / ramp);
          cutProfiledSpan(
            m, path, arcs, L, 0, ramp,
            (s: number): number => Math.max(descent(s), yAt(s)),
            // The mid-ramp stop guarantees the descent is visible as (≥2)
            // strictly-descending cut moves even on long featureless edges.
            spanStops(path, arcs, 0, ramp, profile.breaks, [ramp / 2]),
            spans,
          );
          cutFrom = ramp;
        } else {
          m.plunge({ x: startP.u, y: Math.min(yAt(0), feedPlane), z: startP.v });
        }
      } else {
        // Legacy vertical entry; the plunge target rides a tab when the loop
        // start happens to sit on one (min keeps a degenerate tab-above-feed-
        // plane spec from plunging upward).
        m.plunge({ x: startP.u, y: Math.min(yAt(0), feedPlane), z: startP.v });
      }

      // One full revolution from wherever the entry left the tool, closing
      // back onto the start point.
      if (cutFrom < L - 1e-9) {
        cutProfiledSpan(
          m, path, arcs, L, cutFrom, L, yAt,
          spanStops(path, arcs, cutFrom, L, profile.breaks),
          spans,
        );
      }
      // Spring pass: one extra revolution at the final depth with no retract
      // — it re-rides the tabs at the same heights, which is exactly what 3D
      // ramps-on-tabs protect the cutter from. It also re-cuts the whole loop
      // including any first-level ramp wedge.
      if (params.springPass === true && li === levels.length - 1) {
        cutProfiledSpan(
          m, path, arcs, L, 0, L, yAt,
          spanStops(path, arcs, 0, L, profile.breaks),
          spans,
        );
      } else if (cutFrom > 1e-9 && li === levels.length - 1) {
        // Single-level ramp entry leaves the entry wedge [0, ramp] above
        // yLevel: deeper levels would clean it on their full revolution, but
        // with no deeper level (and no spring pass) the part would stay
        // attached to the stock — the failure mode tabs exist to prevent.
        // The main revolution just closed at s = L ≡ 0, so this continues in
        // position; a degenerate ramp == L degrades to one full extra loop.
        cutProfiledSpan(
          m, path, arcs, L, 0, cutFrom, yAt,
          spanStops(path, arcs, 0, cutFrom, profile.breaks),
          spans,
        );
      }
      m.rapid({ x: startP.u, y: safe, z: startP.v });
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
  const r = tool.diameter / 2;
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

      if (firstEntry && params.helixEntry === true) {
        // Helical first entry over the swept face rectangle (tool overshoot
        // included — the validation region is the whole area the pass covers).
        // The true-up exit cuts straight back to the row start and on through
        // the row: any chord here rides on stock that is about to be faced.
        const region: Point2[] = [
          { u: uMin, v: bounds.min.z },
          { u: uMax, v: bounds.min.z },
          { u: uMax, v: bounds.max.z },
          { u: uMin, v: bounds.max.z },
        ];
        const plan = planHelixEntry({ u: uA, v }, region, [], r);
        const revs = plan !== null ? helixRevolutions(feedPlane - yLevel, plan.radius) : null;
        if (plan !== null && revs !== null) {
          const hs: Point2 = { u: plan.center.u + plan.radius, v: plan.center.v };
          m.rapid({ x: hs.u, y: safe, z: hs.v });
          m.rapid({ x: hs.u, y: feedPlane, z: hs.v });
          emitHelixEntry(m, plan, feedPlane, yLevel, revs);
          m.cut({ x: uA, y: yLevel, z: v });
          m.cut({ x: uB, y: yLevel, z: v });
          firstEntry = false;
          m.rapid({ x: uB, y: safe, z: v });
          forward = !forward;
          continue;
        }
      }

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
