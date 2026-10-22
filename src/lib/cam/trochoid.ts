import { offsetRegion, type RegionComponent } from './offsetRegion';
import { polygonArea, pointInPolygon, type Point2 } from './silhouette';

/**
 * Adaptive (trochoidal) pocket clearing — the v1 route from
 * docs/cnc-algorithms.md §1.5 ("offset reference paths + local trochoids"),
 * but grown from the MEDIAL side outward instead of traced outside-in:
 *
 * 1. The clearing region (the tool-centre domain: silhouette eroded by
 *    r + allowance, islands grown) is eroded in depth steps. The DEEPEST
 *    surviving erosion boundary is walked first as a chain of full circular
 *    trochoid orbits (orbit radius b, one orbit per `e` mm of advance along
 *    the reference ring). In the virgin core this is the only place where a
 *    plain ring walk would bury the tool full-width; orbits nibble it one
 *    shallow crescent per orbit instead.
 * 2. Every subsequent reference ring lies further OUTWARD, spaced
 *    aeRing + β(this) − β(next) (β = the orbit radius the walk at that depth
 *    uses, 0 when direct), where aeRing = D·sin(φ_target/2) is the radial
 *    step that maps to the target engagement angle under the doc's crescent
 *    equivalence (§1.1, model 1). The spacing pre-compensates each walk's
 *    outward reach — a direct ring's disc edge or a chain's outermost orbit
 *    swing — so EVERY walk advances the swept front by exactly aeRing: a
 *    parallel-offset engagement by construction, corners included (successive
 *    round-join erosions are concentric at corners, so the bands stay uniform
 *    width there; no corner spike).
 * 3. While the core is still wide (erosion depth ≥ r: at least one tool
 *    radius of material beyond the current band) the walks stay CHAINED —
 *    full circular trochoid orbits, one per aeRing of advance, which is the
 *    "wide zone trochoid" of the reference-path method. Inside the wide zone
 *    the chain's per-orbit bite replaces the crescent as the engagement
 *    unit, so the two never stack.
 * 4. The final walks (depth < r) ride direct crescents, and the very last
 *    one rides the domain boundary itself (the wall ring): its leftover
 *    crescent is < aeRing by the same spacing argument, and leaving the wall
 *    for last is the adaptive roughing/finish-order convention.
 *
 * Narrow zones (the last sliver of a pocket, a slot too narrow for an orbit:
 * domain width ≲ 2·(r + b_min)) degenerate honestly: no orbit fits, so the
 * walk passes straight through — full-slot milling whose width is bounded by
 * the zone itself (doc §1.4 narrow-zone rule).
 *
 * No-gouge guarantee, by construction: every emitted point and chord stays
 * inside the tool-centre domain. A point on the boundary of erode(X, d) sits
 * exactly d from ∂X, so an orbit of radius b there fits iff b ≤ d — no
 * per-point distance queries are needed. Ring edges are the clipper erosion
 * output itself; every remaining connector chord is verified against the
 * domain (quarter-sample containment, the same guard level as the raster
 * canLink) and split into retract-separated runs when it fails.
 */

export interface AdaptiveClearingOptions {
  /** Cutter diameter (mm). */
  toolDiameter: number;
  /** User stepover cap (mm) — CAMParameters.stepover. The engagement-derived
   * radial step never exceeds it. */
  stepoverCap: number;
  /** Target engagement angle in degrees: the cutter-circumference arc
   * engaged in uncut material per bite, mapped from the radial step via
   * φ = 2·asin(ae/D) (doc §1.1 model 1). Clamped to [5, 60]; default 30. */
  engagementDeg?: number;
}

export interface AdaptiveEntryOrbit {
  center: Point2;
  radius: number;
}

export interface AdaptiveClearingPlan {
  /** Ordered cut polylines in the (u, v) plan plane, medial-first (inside
   * out). Ring walks include their closing point; chains end on their last
   * orbit. Consume in order, linking or retracting between paths. */
  paths: Point2[][];
  /** Parallel to `paths`: the orbit a VIRGIN entry should descend along (the
   * path's own orbit 0) — set for chains that start in uncut material (the
   * first chain of every component: split lobes, split medial remnants).
   * Null elsewhere: those paths start inside already-swept bands and may
   * plunge plainly. The generator turns these into helical descents on the
   * first level only. */
  pathEntries: Array<AdaptiveEntryOrbit | null>;
  /** Index of the first wall-side (depth-0) loop in `paths` — the re-walk
   * set for CAMParameters.wallFinishPass. */
  finishFrom: number;
  /** The first chain's orbit 0 — the natural helix/ramp descent circle for
   * the level entry (the generator reuses it). Null when the first walk is
   * direct (narrow domains where no orbit fits). */
  entryOrbit: AdaptiveEntryOrbit | null;
  /** Keep-tool-down links between walks are only honest when the chord is
   * short: a long chord can cross still-uncut wedges (the containment guard
   * checks gouging, not swept state). 3·aeRing covers the adjacent-ring
   * corner hand-offs; anything longer takes the retract detour. */
  linkMax: number;
  /** Deterministic diagnostics for tests/telemetry. */
  stats: { depths: number; chainedRings: number; directRings: number; orbits: number };
}

/** Orbit room shave (mm): erosion polygons are chords of the true eroded
 * boundary (clipper arcTolerance 0.02), so an orbit sized at exactly b = d
 * could poke past the discretized boundary by that much. */
const ROOM_SHAVE = 0.05;
/** Orbit polyline chord sagitta (mm): below the arc fitter's 0.01 tolerance
 * so every full orbit re-fits to exactly three ≤120° G2/G3 moves. */
const ORBIT_SAGITTA = 0.008;
/** Doc §1.1 model-1 engagement cap on the radial step: ae ≤ 0.45·D keeps the
 * mapped angle ≤ 53° even for a 60° target, and the legacy raster clamp's
 * neighbourhood. */
const MAX_STEP_FACTOR = 0.45;
const MIN_STEP_FACTOR = 0.05;
/**
 * Successive erosions of a sharp (miter) corner jump corner-to-corner along
 * the diagonal, so a walk family spaced `ae` radially advances the swept
 * front by √2·ae at every convex corner — the one place the parallel-offset
 * engagement argument breaks. Scaled down (measured: the final wall-corner
 * hand-off additionally concentrates the last corner crescent into one
 * short link + corner arc, ~1.35× the diagonal bound), 0.64 keeps the
 * concentrated corner window at the same budget as the straights; the cost
 * is ~55% more reference rings, which adaptive buys back in depth-of-cut.
 */
const CORNER_SAFETY = 0.64;
/** Doc §1.6: orbit radius floor max(0.5 mm, 0.15·D) — smaller orbits make the
 * G2/G3 spans so short that files balloon and controllers jitter. */
export function minOrbitRadius(toolDiameter: number): number {
  return Math.max(0.5, 0.15 * toolDiameter);
}
/** Right-turn threshold (degrees) for inserting a corner trochoid on a direct
 * walk — a turn toward the uncut side (material on the right under climb) is
 * where a wedge could over-engage. Round-join erosions produce arcs, not
 * sharp vertices, so this is a defensive path (miter-ish inputs). */
const CORNER_TURN_DEG = 30;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function distPointSegmentSq(p: Point2, a: Point2, b: Point2): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  const t = lenSq < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
  const eu = p.u - (a.u + t * du);
  const ev = p.v - (a.v + t * dv);
  return eu * eu + ev * ev;
}

/** Squared distance from p to a closed ring's boundary. */
function distToRingSq(p: Point2, ring: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, distPointSegmentSq(p, ring[i]!, ring[(i + 1) % ring.length]!));
  }
  return best;
}

/** Domain containment tolerant of points ON the boundary (ring walks and
 * their vertices sit exactly there; a strict inside test would flake). */
function insideComponentInclusive(p: Point2, comp: RegionComponent): boolean {
  const eps = 1e-7;
  if (!pointInPolygon(p, comp.outer) && distToRingSq(p, comp.outer) > eps * eps) return false;
  for (const h of comp.holes) {
    if (pointInPolygon(p, h) && distToRingSq(p, h) > eps * eps) return false;
  }
  return true;
}

/** True when the chord a→b stays inside ONE component (quarter samples — the
 * same conservative guard level the raster linker uses; anything doubtful is
 * rejected so the caller retracts instead). */
function segmentInDomain(a: Point2, b: Point2, regions: RegionComponent[]): boolean {
  return regions.some((comp) =>
    [0.25, 0.5, 0.75].every((t) =>
      insideComponentInclusive({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t }, comp),
    ),
  );
}

/** Split a planned path wherever a connector chord would leave the domain:
 * the emitter then retracts between the runs instead of gouging. Ring edges
 * and orbit polylines always pass (they are domain geometry by construction);
 * this guard exists for chords the planner connects between elements. */
function splitByDomain(path: Point2[], regions: RegionComponent[]): Point2[][] {
  if (path.length < 2) return [];
  const runs: Point2[][] = [];
  let cur: Point2[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const b = path[i]!;
    if (segmentInDomain(cur[cur.length - 1]!, b, regions)) {
      cur.push(b);
    } else {
      if (cur.length >= 2) runs.push(cur);
      cur = [b];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** Closed-ring cumulative arc lengths (vertex 0 → 0) and total length. */
function ringArcs(ring: Point2[]): { s: number[]; L: number } {
  const s = [0];
  for (let i = 1; i < ring.length; i++) {
    s.push(s[i - 1]! + Math.hypot(ring[i]!.u - ring[i - 1]!.u, ring[i]!.v - ring[i - 1]!.v));
  }
  const L = s[s.length - 1]! + Math.hypot(ring[0]!.u - ring[ring.length - 1]!.u, ring[0]!.v - ring[ring.length - 1]!.v);
  return { s, L };
}

/** Point at arc length t ∈ [0, L) along a closed ring. */
function ringPointAt(ring: Point2[], s: number[], L: number, t: number): Point2 {
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = ring[lo]!;
  const b = ring[lo + 1 < ring.length ? lo + 1 : 0]!;
  const segLen = lo + 1 < s.length ? s[lo + 1]! - s[lo]! : L - s[lo]!;
  if (segLen <= 1e-12) return a;
  const f = (t - s[lo]!) / segLen;
  return { u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f };
}

/** Orbit centres along a closed reference ring, spacing ≤ `spacing` by arc
 * length, starting at vertex 0 (deterministic). */
function resampleClosedBySpacing(ring: Point2[], spacing: number): Point2[] {
  const { s, L } = ringArcs(ring);
  const count = Math.max(1, Math.ceil(L / spacing - 1e-9));
  const out: Point2[] = [];
  for (let j = 0; j < count; j++) out.push(ringPointAt(ring, s, L, (L * j) / count));
  return out;
}

/** Polyline samples for a full orbit circle: chord sagitta ≤ ORBIT_SAGITTA. */
function orbitSampleCount(b: number): number {
  const cosHalf = Math.max(-1, Math.min(1, 1 - ORBIT_SAGITTA / b));
  return Math.min(96, Math.max(12, Math.ceil(Math.PI / Math.acos(cosHalf))));
}

/** Append a full CCW circle of radius b around center, starting at angle
 * th0 (the circle closes back onto its own start point). CCW is the climb
 * bite direction: at the orbit's frontal extreme the tangent keeps the
 * virgin material on the right (M3), matching the helix entry direction. */
function pushOrbit(out: Point2[], center: Point2, b: number, th0: number): void {
  const n = orbitSampleCount(b);
  for (let k = 1; k <= n; k++) {
    const th = th0 + (2 * Math.PI * k) / n;
    pushPoint(out, center.u + b * Math.cos(th), center.v + b * Math.sin(th));
  }
}

function pushPoint(out: Point2[], u: number, v: number): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last.u - u) < 1e-9 && Math.abs(last.v - v) < 1e-9) return;
  out.push({ u, v });
}

/**
 * The trochoid chain along one reference ring: orbit centres spaced ≤ e by
 * arc length, each traced as a full CCW circle. Hand-offs happen at each
 * orbit's REAR point (the point closest to the previous centre, on the
 * centre line): the straight hand-off chord from rear_i to rear_{i+1} then
 * lies at depth ≤ e − b inside the previous orbit's swept disc
 * (b + r), so the connector rides entirely in already-cut air — the classic
 * trochoid topology (bite at the front arc, travel at the back). A left-
 * intersection hand-off instead ploughs the next orbit's whole frontal
 * crescent in one straight capsule (the review that caught this measured
 * ~7 mm² of virgin material in a single 1.5 mm connector move).
 */
function buildOrbitChain(ring: Point2[], b: number, e: number): { path: Point2[]; firstCenter: Point2; orbits: number } {
  const centers = resampleClosedBySpacing(ring, e);
  const m = centers.length;
  const startOf: Point2[] = [];
  for (let i = 0; i < m; i++) {
    const c = centers[i]!;
    const next = centers[(i + 1) % m]!;
    let du = next.u - c.u;
    let dv = next.v - c.v;
    let len = Math.hypot(du, dv);
    if (len < 1e-9) {
      // Single orbit (or duplicate centres): advance along the ring tangent
      // at the start vertex, falling back to +u for degenerate rings.
      const a = ring[0]!;
      const w = ring[1 % ring.length]!;
      du = w.u - a.u;
      dv = w.v - a.v;
      len = Math.hypot(du, dv);
    }
    if (len < 1e-9) {
      du = 1;
      dv = 0;
      len = 1;
    }
    startOf.push({ u: c.u - (du / len) * b, v: c.v - (dv / len) * b });
  }
  const path: Point2[] = [];
  for (let i = 0; i < m; i++) {
    const c = centers[i]!;
    const s = startOf[i]!;
    pushOrbit(path, c, b, Math.atan2(s.v - c.v, s.u - c.u));
    if (i + 1 < m) pushPoint(path, startOf[i + 1]!.u, startOf[i + 1]!.v);
  }
  if (path.length === 0) path.push({ u: centers[0]!.u, v: centers[0]!.v });
  return { path, firstCenter: centers[0]!, orbits: m };
}

/**
 * Direct ring walk (closed, start vertex preserved) with defensive corner
 * trochoids: at a right turn ≥ CORNER_TURN_DEG (toward the uncut side under
 * climb) a full orbit centred ON the vertex pre-nibbles the wedge — the
 * orbit fits because a depth-d ring vertex sits d inside the domain.
 */
function directWalk(ring: Point2[], bCorner: number): Point2[] {
  const path: Point2[] = [];
  const n = ring.length;
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const p = ring[idx]!;
    pushPoint(path, p.u, p.v);
    if (i === n || bCorner <= 0 || n < 3) continue;
    const a = ring[(idx - 1 + n) % n]!;
    const c = ring[(idx + 1) % n]!;
    const cross = (p.u - a.u) * (c.v - p.v) - (p.v - a.v) * (c.u - p.u);
    if (cross >= 0) continue; // left turn — away from the uncut side
    const inLen = Math.hypot(p.u - a.u, p.v - a.v);
    const outLen = Math.hypot(c.u - p.u, c.v - p.v);
    if (inLen < 1e-9 || outLen < 1e-9) continue;
    const dot = ((p.u - a.u) * (c.u - p.u) + (p.v - a.v) * (c.v - p.v)) / (inLen * outLen);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (turn < (CORNER_TURN_DEG * Math.PI) / 180) continue;
    pushOrbit(path, p, bCorner, Math.atan2(a.v - p.v, a.u - p.u));
  }
  return path;
}

/**
 * Plan one level's adaptive clearing for the whole domain. Pure and
 * deterministic: clipper output is canonicalized (winding + start vertex +
 * component order), orbit chains anchor at canonical ring starts, and ring
 * order within a depth is greedy-nearest from the previous walk's end.
 */
export function planAdaptiveClearing(
  regions: RegionComponent[],
  opts: AdaptiveClearingOptions,
): AdaptiveClearingPlan {
  const D = opts.toolDiameter;
  const r = D / 2;
  const phiDeg = clamp(opts.engagementDeg ?? 30, 5, 60);
  const ae = clamp(
    Math.min(opts.stepoverCap, D * Math.sin(((phiDeg * Math.PI) / 180) / 2)) * CORNER_SAFETY,
    MIN_STEP_FACTOR * D,
    MAX_STEP_FACTOR * D,
  );
  const bMin = minOrbitRadius(D);
  const empty: AdaptiveClearingPlan = {
    paths: [], pathEntries: [], finishFrom: 0, entryOrbit: null, linkMax: 3 * ae,
    stats: { depths: 0, chainedRings: 0, directRings: 0, orbits: 0 },
  };
  if (regions.length === 0 || !Number.isFinite(ae) || ae <= 0) return empty;

  const erodeAll = (d: number): RegionComponent[] =>
    regions.flatMap((rg) => offsetRegion(rg.outer, rg.holes, -d));

  // Deepest surviving erosion, scanned in ae steps. Bounded by each
  // component's bbox half-width (an erosion deeper than the inradius is
  // necessarily empty) so pathological inputs cannot spin the loop.
  let kBound = 2;
  for (const rg of regions) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of rg.outer) {
      minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
    }
    kBound = Math.max(kBound, Math.ceil((Math.min(maxU - minU, maxV - minV) / 2) / ae) + 2);
  }
  let kMax = 0;
  for (let k = 1; k <= Math.min(400, kBound); k++) {
    if (erodeAll(k * ae).length === 0) break;
    kMax = k;
  }

  const paths: Point2[][] = [];
  const pathEntries: Array<AdaptiveEntryOrbit | null> = [];
  const stats = { depths: 0, chainedRings: 0, directRings: 0, orbits: 0 };
  const dust = (Math.PI * r * r) / 16;
  let finishFrom = 0;
  let entryOrbit: AdaptiveEntryOrbit | null = null;
  let pos: Point2 | null = null;

  /** Rotate a closed ring so it starts at the vertex nearest `from` (tie:
   * lowest index) — re-entry then bites out of the neighbour's already-swept
   * band instead of a virgin one, and inter-path links stay short. */
  const rotateToNearest = (ring: Point2[], from: Point2): Point2[] => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = Math.hypot(ring[i]!.u - from.u, ring[i]!.v - from.v);
      if (d < bestD - 1e-12) {
        bestD = d;
        best = i;
      }
    }
    return best === 0 ? ring : [...ring.slice(best), ...ring.slice(0, best)];
  };

  let d = kMax * ae;
  let virgin = true; // nothing swept yet — a plain ring walk would full-slot
  let prevBeta = 0; // orbit radius used one ring deeper (chain reach)
  let prevD = Infinity;
  let prevComps: RegionComponent[] = [];
  let guard = 0;
  while (guard++ < 512) {
    stats.depths++;
    if (d <= 1e-9) finishFrom = paths.length;
    const comps = d <= 1e-9 ? regions : erodeAll(d);
    // A component that did not exist one walk shallower (erosion split, or
    // the very first depth) starts in virgin material on its engagement
    // side: its first chain needs its own helical entry (the doc §1.4
    // re-entry rule — plunging into virgin material is a full engagement).
    // Lineage test: a WALKABLE (≥ dust) deeper ancestor's canonical vertex
    // falls inside the shallower (larger) new component — the reverse
    // containment would flag every concentric growth as new, the inclusive
    // test tolerates near-identical canonical vertices of successive
    // erosions landing exactly ON each other's boundary, and sub-dust
    // ancestors are skipped (a mixed depth can carry walkable lobes next to
    // dust ghosts; a ghost inside a lobe must not mark it "seen" — P1-1).
    const netArea = (comp: RegionComponent): number =>
      Math.abs(polygonArea(comp.outer)) -
      comp.holes.reduce((s, h) => s + Math.abs(polygonArea(h)), 0);
    const compIsNew = (comp: RegionComponent): boolean =>
      virgin ||
      !prevComps.some(
        (pc) => netArea(pc) >= dust && insideComponentInclusive(pc.outer[0]!, comp),
      );
    // Rings at this depth. Winding is already climb-correct from offsetRegion:
    // outer rings CCW (uncut material outside the loop rides on the right),
    // hole rings CW (island material inside the loop rides on the right).
    // The dust filter matches the offset strategy's (sub-tool debris is not
    // a machinable ring) and applies at EVERY depth including the first —
    // the deepest erosion of a near-medial domain is often a razor-thin
    // sliver that clipper returns as a handful of arc pieces; walking those
    // as "the virgin core" (a pass-#37 review) spawned one entry orbit per
    // dust piece. The walk simply starts one ring shallower instead.
    const rings: Point2[][] = [];
    const ringVirgin: boolean[] = [];
    for (const comp of comps) {
      const net = netArea(comp);
      const isNew = compIsNew(comp);
      if (net >= dust) {
        rings.push(comp.outer);
        ringVirgin.push(isNew);
      }
      for (const hole of comp.holes) {
        if (-polygonArea(hole) >= dust) {
          rings.push(hole);
          ringVirgin.push(isNew);
        }
      }
    }
    // Orbit radius at this depth: a boundary point of erode(X, d) sits
    // exactly d from ∂X, so the orbit fits iff b ≤ d — uniform along the
    // ring, no distance queries. b targets ae/2 (task/doc derivation), with
    // the doc's floor max(0.5, 0.15D) and the room cap; no honest orbit → 0.
    const orbitRadiusAt = (depth: number): number => {
      const room = depth - ROOM_SHAVE;
      let bb = Math.min(ae / 2, room);
      if (bb < bMin) bb = Math.min(bMin, room);
      return bb < bMin - 1e-9 ? 0 : bb;
    };
    const b = orbitRadiusAt(d);
    // Chain when a direct walk would over-engage — always in the virgin core
    // (a plain ring walk there is a full-width slot) — or while the core is
    // still WIDE (d ≥ r: at least one tool radius of material beyond the
    // current band, the "宽区走摆线" zone). The chain's per-orbit advance
    // e = ae is then the bite. Narrower bands (the final r-wide rim) walk
    // directly: their crescent is ae by the spacing pre-compensation.
    const crescent = virgin ? Infinity : prevD - d - prevBeta;
    const chain = b > 0 && (virgin || crescent > ae * 1.02 || d >= r);

    // Deterministic ring order: canonical (component/hole sort) for the very
    // first ring, greedy-nearest from the previous walk's end afterwards —
    // with each ring ROTATED to start at its vertex nearest that end (see
    // rotateToNearest). The first ring of the plan keeps its canonical start
    // so the level entry/helix anchor never moves.
    if (pos !== null && rings.length > 0) {
      const remainingVirgin = ringVirgin.map((v, i) => ({ v, i }));
      const ordered: Point2[][] = [];
      const orderedVirgin: boolean[] = [];
      const pool = rings.map((rg, i) => ({ ring: rg, virgin: remainingVirgin[i]!.v }));
      while (pool.length > 0) {
        for (const item of pool) item.ring = rotateToNearest(item.ring, pos!);
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const h = pool[i]!.ring[0]!;
          const dist = Math.hypot(h.u - pos!.u, h.v - pos!.v);
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
        const next = pool.splice(best, 1)[0]!;
        ordered.push(next.ring);
        orderedVirgin.push(next.virgin);
        pos = next.ring[0]!;
      }
      rings.length = 0;
      rings.push(...ordered);
      ringVirgin.length = 0;
      ringVirgin.push(...orderedVirgin);
    }

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri]!;
      const ringIsVirgin = ringVirgin[ri]!;
      let path: Point2[];
      let thisEntry: AdaptiveEntryOrbit | null = null;
      if (chain) {
        const built = buildOrbitChain(ring, b, ae);
        path = built.path;
        stats.chainedRings++;
        stats.orbits += built.orbits;
        if (entryOrbit === null) entryOrbit = { center: built.firstCenter, radius: b };
        if (ringIsVirgin) thisEntry = { center: built.firstCenter, radius: b };
      } else {
        path = directWalk(ring, b > 0 ? b : 0);
        stats.directRings++;
      }
      for (const run of splitByDomain(path, regions)) {
        paths.push(run);
        // The entry orbit rides on the run containing its centre's walk; in
        // practice the splitter never cuts a chain's first orbit (it is
        // domain geometry), so attaching to the first run is exact enough.
        pathEntries.push(paths.length === 1 ? (entryOrbit ?? thisEntry) : thisEntry);
        pos = run[run.length - 1]!;
      }
    }

    if (d <= 1e-9) break; // the wall-side walk just emitted
    // Dust-skipped depths (no ring survived the filter) walk NOTHING: they
    // must not consume the virgin flag, become lineage ancestors (ghost dust
    // pieces then mark the real lobes "already seen", leaving a split
    // component's first chain to plunge bare into virgin material — the
    // P1-1 review), or charge the spacing budget. prevD likewise only
    // tracks WALKED depths so the crescent account stays honest.
    prevBeta = chain && rings.length > 0 ? b : 0;
    if (rings.length > 0) {
      prevD = d;
      prevComps = comps;
      virgin = false;
    }
    // Next reference ring outward. Spacing = ae + β(this) − β(next): the
    // direct walk's crescent AND a chain's orbital outer reach both then
    // advance the swept front by exactly ae (a chain sweeps to ring + b_next,
    // so it starts b_next further in; β(next) is a pure function of the next
    // depth). The compensation is CLAMPED to keep the sequence strictly
    // decreasing — where the chain/direct boundary flips, β(next) can exceed
    // ae and the naive fixed point oscillates (a pass-#37 review found the
    // tube annulus wandering d = 1.491→1.494→1.497→1.500); the clamp lands
    // in direct territory where no orbit reach needs compensating.
    let nextD = d - (ae + prevBeta);
    if (nextD > 1e-9) {
      const bNext = orbitRadiusAt(nextD);
      if (bNext > 0) nextD += bNext;
    }
    nextD = Math.min(nextD, d - ae * 0.5);
    d = Math.max(0, nextD);
  }

  return {
    paths,
    pathEntries,
    // finishFrom may equal paths.length when every depth-0 ring was dust —
    // the finish slice is then empty, which is the honest result.
    finishFrom: Math.min(finishFrom, paths.length),
    entryOrbit,
    linkMax: 3 * ae,
    stats,
  };
}
