import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import type { SolidBody, Vec3 } from '../geometry/types';
import {
  topSilhouette,
  offsetPolygon,
  scanlineIntervals,
  subtractIntervals,
  pointInPolygon,
  polygonArea,
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

/**
 * True when the closed segments a→b and c→d share at least one point — the
 * classic four-orientation test with the collinear/touching cases included,
 * so boundary grazing counts as an intersection (conservative for guards).
 */
function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
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

/**
 * Simple-polygon check for one offset ring: every NON-adjacent edge pair is
 * tested (O(n²) — ring vertex counts are small). Adjacent edges always share
 * their common vertex, which is not a self-intersection; anything else,
 * including a mere touch, is. offsetPolygon's miter offsets can self-intersect
 * slightly at sharp concave corners (documented there), and a crossed ring
 * would gouge walls, so this guards every ring before it is emitted.
 */
function ringSelfIntersects(pts: Point2[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing pair shares vertex 0
      if (segmentsIntersect(pts[i]!, pts[(i + 1) % n]!, pts[j]!, pts[(j + 1) % n]!)) {
        return true;
      }
    }
  }
  return false;
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

/** Polyline segments per helix revolution (≥ 20 keeps the chord error small). */
const HELIX_SEGMENTS = 24;

/** True when a (CCW-normalised) polygon has no reflex vertex — every
 * consecutive edge cross product keeps the same sign. Concave clearing
 * regions make the offset-ring strategy truncate early, so callers use this
 * to gate the ring family and fall back to the raster. */
function polygonIsConvex(pts: Point2[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const cross = (b.u - a.u) * (c.v - b.v) - (b.v - a.v) * (c.u - b.u);
    if (Math.abs(cross) > 1e-12) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

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

  /**
   * Contour-parallel ring family (pocketStrategy 'offset'). ring_k insets the
   * cleared region by a further k·stepover — always offset from ring 0, never
   * iteratively, so miter error cannot accumulate. The sequence stops at the
   * first ring that offsetPolygon rejects (null ⇒ degenerate), that
   * self-intersects, or that shrinks below ~a sixteenth of the tool disc.
   * Built only for island-free, CONVEX clearing regions: on concave outlines
   * the offsetPolygon centroid-based null guard truncates the ring family
   * early and the pocket centre would stay uncleared (measured 53.8% area
   * coverage on an L-shape, pass #34 review) — those fall back to the raster,
   * which always covers, exactly like island silhouettes do.
   */
  const ringPaths: Point2[][] = [];
  if (params.pocketStrategy === 'offset' && islands.length === 0 && polygonIsConvex(outer)) {
    for (let k = 0; ; k++) {
      const ring = offsetPolygon(outer, -k * sover); // k = 0 returns a copy
      if (!ring || ring.length < 3) break;
      if (ringSelfIntersects(ring)) break; // deeper rings can only be worse
      if (Math.abs(polygonArea(ring)) < (Math.PI * r * r) / 16) break;
      // Climb under M3 keeps the material on the RIGHT (see the contour
      // comment). Ring 0 hugs the pocket wall with material OUTSIDE the loop
      // → CCW puts it on the right — the same direction as the helix entry,
      // so the entry and the first ring agree. Every deeper ring engages the
      // uncleared core INSIDE the loop → CW. reverseLoop keeps the start
      // vertex stable either way.
      ringPaths.push(
        k === 0 || polygonArea(ring) < 0 ? ring : reverseLoop(ring),
      );
    }
  }
  const useOffset = ringPaths.length > 0;

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

    if (useOffset) {
      // Contour-parallel clearing: wall ring first, then inward ring by ring.
      for (const path of ringPaths) {
        if (firstEntry) {
          firstEntry = false;
          const start = path[0]!;
          let helixEnd: Point2 | null = null;
          if (params.helixEntry === true) {
            // The wall ring's start sits ON the boundary where no swept disc
            // fits; the second ring's start (one stepover in) is the nominal
            // helix centre when that ring exists.
            const nominal = ringPaths.length > 1 ? ringPaths[1]![0]! : start;
            const plan = planHelixEntry(nominal, outer, [], r);
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
      // Wall finish pass: the wall ring once more, CCW (climb on the wall
      // side — material outside the loop sits on the right when CCW). Re-
      // walking ring 0 is intended — spring-pass semantics, the same idea as
      // Fusion/Mastercam finish passes.
      if (params.wallFinishPass === true) {
        rowEnd = cutLoop(ringPaths[0]!, yLevel, feedPlane, rowEnd);
      }
    } else {
      // Where the cutter stands between passes at THIS level (the zigzag
      // alternates direction, so it is each interval's far end).
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

          // Helical first entry: the validated disc sweeps the descent, the
          // flat true-up circle levels the floor, and the exit links to the
          // row start (cut when the chord stays inside, else the detour).
          let helixed = false;
          if (firstEntry && params.helixEntry === true) {
            const plan = planHelixEntry({ u: uA, v }, outer, islands, r);
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
      // Wall finish pass (raster): after clearing the level, one extra loop
      // along the wall-side boundary — the cleared-region boundary itself,
      // CCW (material outside the loop ⇒ climb keeps it on the right) — plus
      // one loop around every grown island, CW (material inside the loop ⇒
      // climb keeps it on the right). Islands the tool cannot fit were
      // already dropped from `islands`.
      if (params.wallFinishPass === true) {
        const wallLoop = polygonArea(outer) > 0 ? [...outer] : reverseLoop(outer);
        rowEnd = cutLoop(wallLoop, yLevel, feedPlane, rowEnd);
        for (const island of islands) {
          const islandLoop = polygonArea(island) > 0 ? reverseLoop(island) : island;
          rowEnd = cutLoop(islandLoop, yLevel, feedPlane, rowEnd);
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
): void {
  const cutAt = (s: number, y: number): void => {
    const p = s >= L - 1e-9 ? path[0]! : loopPointAt(path, arcs, L, s);
    m.cut({ x: p.u, y, z: p.v });
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
    cutAt(s, y);
    prevS = s;
    prevY = y;
  };
  for (const s of stops) emitTo(s);
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

  // Cut direction under an M3 spindle: climb milling keeps the material on
  // the RIGHT of the travel direction (chip-thickness simulation, pass #34
  // review — the zero-to-max entry happens with material on the LEFT, which
  // is conventional; also matches the easy_cam convention quoted in
  // docs/cnc-algorithms.md). The tool runs OUTSIDE the part on the outer
  // loop, so the enclosed material sits on the right when the loop is CW;
  // island loops have the material OUTSIDE, so climb keeps them CCW
  // (exactly what offsetPolygon returns: every silhouette loop is
  // normalised CCW). 'conventional' flips both windings; the start vertex is
  // preserved either way so the entry point never moves. (Pass #33 shipped
  // this inverted — corrected here, see CHANGELOG 0.28.0.)
  const conventional = params.direction === 'conventional';
  const orient = (loop: Point2[], island: boolean): Point2[] =>
    island === conventional ? reverseLoop(loop) : loop;

  const paths: Point2[][] = [];
  const outerPath = offsetPolygon(sil.outer.points, offset);
  if (outerPath) paths.push(orient(outerPath, false));
  for (const island of sil.islands) {
    const p = offsetPolygon(island.points, -offset);
    if (p) paths.push(orient(p, true)); // null ⇒ tool cannot fit the hole; skip it
  }
  if (paths.length === 0) return empty;

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

    for (const path of paths) {
      const start = path[0]!;
      const arcs = loopArcs(path);
      const L = loopLength(path, arcs);

      // Height profile along the loop: flat at yLevel, except levels below
      // the tab top ride the tabs (y ∈ [yLevel, tabTop], cut feed throughout).
      const profile =
        tabs !== null && yLevel < tabTop
          ? makeTabProfile(L, yLevel, tabTop, tabs)
          : { yAt: (): number => yLevel, breaks: [] as number[] };
      const yAt = profile.yAt;

      m.rapid({ x: start.u, y: safe, z: start.v });
      m.rapid({ x: start.u, y: feedPlane, z: start.v });

      let cutFrom = 0;
      if (params.rampEntry === true && li === 0) {
        // Ramp the first-level entry: descend along the path, following its
        // vertices so the move never chords across the offset loop (a chord
        // of a convex section would gouge the wall by its sagitta), lifted
        // over any tab in the way.
        const ramp = rampLength(tool, yPrev - yLevel, L);
        if (ramp > 1e-6) {
          const descent = (s: number): number => feedPlane + (yLevel - feedPlane) * (s / ramp);
          cutProfiledSpan(
            m, path, arcs, L, 0, ramp,
            (s: number): number => Math.max(descent(s), yAt(s)),
            // The mid-ramp stop guarantees the descent is visible as (≥2)
            // strictly-descending cut moves even on long featureless edges.
            spanStops(path, arcs, 0, ramp, profile.breaks, [ramp / 2]),
          );
          cutFrom = ramp;
        } else {
          m.plunge({ x: start.u, y: Math.min(yAt(0), feedPlane), z: start.v });
        }
      } else {
        // Legacy vertical entry; the plunge target rides a tab when the loop
        // start happens to sit on one (min keeps a degenerate tab-above-feed-
        // plane spec from plunging upward).
        m.plunge({ x: start.u, y: Math.min(yAt(0), feedPlane), z: start.v });
      }

      // One full revolution from wherever the entry left the tool, closing
      // back onto the start point.
      if (cutFrom < L - 1e-9) {
        cutProfiledSpan(
          m, path, arcs, L, cutFrom, L, yAt,
          spanStops(path, arcs, cutFrom, L, profile.breaks),
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
        );
      }
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
