import ClipperLib from 'clipper-lib';
import { polygonArea, type Point2 } from './silhouette';

/**
 * Region (outer boundary + island holes) offsetting, backed by Clipper 6.4.2
 * (`clipper-lib` on npm — Angus Johnson's Clipper ported to pure JavaScript by
 * Timo, Boost Software License 1.0; no WASM, fully synchronous, so the CAM
 * generation call chain stays sync). This replaces the single-loop, miter-only
 * `offsetPolygon` everywhere a whole REGION must be grown or eroded: morphing
 * a multi-loop region is a morphological boolean, and per-vertex normal
 * averaging cannot express "the island grew until it merged with the wall".
 *
 * Coordinate conventions (fixed by the code, callers must not compensate):
 * - The plane is the CAM planning plane (u, v) = (body x, body z) with the
 *   standard shoelace sign: POSITIVE area = counter-clockwise. Clipper is
 *   purely algebraic about this (positive area = outer, negative = hole), so
 *   points are fed and returned unflipped — no Y-axis translation happens
 *   inside this module.
 * - INPUT winding is forgiving: `outer` may arrive either way (topSilhouette
 *   normalizes every loop CCW, including islands) and is forced CCW here;
 *   holes are forced CW. Correct region semantics depend on that pairing, so
 *   the normalization is not optional.
 * - OUTPUT winding is fixed: every component's `outer` is CCW (positive
 *   area), every hole CW (negative), and every ring is rotated to start at
 *   its lexicographically smallest vertex (min u, tie: min v) so results are
 *   deterministic across runs and comparable in tests. The |delta| ≈ 0 fast
 *   path is the documented exception: it returns the input rings re-wound
 *   only, because level-0 identity with the caller's base region matters
 *   more there than canonical form.
 *
 * delta > 0 dilates the region (holes shrink), delta < 0 erodes it (holes
 * grow, the region may split into several connected components, or vanish —
 * `[]`). |delta| below 1e-9 mm short-circuits: the validated input region is
 * returned verbatim (only re-wound), no clipper pass, so a "level 0" offset
 * of an already-offset region stays byte-identical to its base.
 */

/** One connected piece of the offset result: material enclosed by `outer`
 * minus the material of each hole ring. */
export interface RegionComponent {
  outer: Point2[];
  holes: Point2[][];
}

export interface OffsetRegionOptions {
  /**
   * Maximum deviation (mm) of round-join polylines from the true arc. Default
   * 0.02: a full circle of radius |delta| becomes ≈ π/acos(1 − t/|δ|)
   * segments (27 at δ = 3 mm) — coarse enough that the toolpath's arc fitter
   * (`fitArcs`, span cap 512 points) re-merges each join into one or two
   * G2/G3 moves, fine enough that the polyline never strays past the 20 µm
   * this library already promises elsewhere. Clipper internally clamps the
   * effective tolerance to 0.25·|delta| (its own default sanity bound).
   */
  arcTolerance?: number;
  /**
   * 'round' (default) is the geometrically exact join for a disc cutter:
   * dilating around a convex corner sweeps exactly a circular arc, and
   * eroding into a concave one rounds it off because the cutter centre simply
 * cannot reach the sharp bottom. 'miter' keeps sharp corners (behaviour
   * parity for the contour operation, whose legacy offset was a true miter).
   */
  joinType?: 'round' | 'miter';
  /** Miter displacement cap in multiples of delta (joinType 'miter' only).
   * Default 3.5 — the same ceiling the legacy offsetPolygon clamp used. */
  miterLimit?: number;
}

/** mm → integer scale. 1e6 puts the quantum at 1 nm; every coordinate that
 * is an exact multiple of 1e-4 mm survives the round trip bit-exactly
 * (integer / 1e6 is correctly rounded), which is what lets the contour tests
 * assert 6-decimal perimeters. The quantum matters beyond prettiness: the
 * arc fitter's three-point circumcircle amplifies coordinate noise by
 * ~1/(1−cos(θ/2)) on short spans, so at 0.1 µm quantization a 5.6° seam arc
 * came out with a 0.05 mm radius error — at 1 nm the same span errs by
 * ~5e-4 mm, far below the 5e-3 the G-code consumers verify. Points are
 * re-centred on the region bbox before scaling (the centre snapped to the
 * SCALE grid — 1 nm, so 1e-4 multiples stay exact) so geometry far from the
 * origin keeps small integers; Clipper auto-switches to its full 2^52 range
 * beyond ~4.7e7 units, so even a 100 m part cannot overflow. */
const SCALE = 1e6;

const DEFAULT_ARC_TOLERANCE = 0.02;

/** Rings whose area collapses below this (mm²) are integer-rounding dust,
 * not machinable features — real shapes here are tool-scale (≥ mm²). */
const MIN_RING_AREA = 1e-6;

/**
 * Greedy chord decimation of a closed ring at deviation tolerance `tol`.
 * The pure-JS Clipper port costs ~15 µs per input vertex in the boolean
 * sweep, and imported-mesh silhouettes arrive as 2000+ vertex near-circles
 * where every vertex is individually irrelevant: collapsing runs of vertices
 * that deviate less than `tol` from their chord tames the worst case (a
 * 2000-gon circle drops ~7× at 2 µm). 2 µm is 10× below the arc tolerance
 * and 4 orders below machining relevance, so the offset boundary may move by
 * at most that much — inward (erosion) or outward (dilation) — relative to
 * the undiscretized input. Chord length is capped so long straight runs stay
 * linear-time (the per-extension re-check is bounded by the cap).
 */
const DECIMATE_TOLERANCE = 0.002;
const DECIMATE_MAX_SPAN = 64;

function decimateRing(pts: Point2[], tol: number): Point2[] {
  const n = pts.length;
  if (n < 12) return pts; // nothing worth removing on tiny rings
  const deviation = (p: Point2, a: Point2, b: Point2): number => {
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const lenSq = du * du + dv * dv;
    const t = lenSq < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq));
    return Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv));
  };
  const out: Point2[] = [];
  let anchor = 0;
  while (anchor < n) {
    // Extend the chord anchor→end while every intermediate vertex stays
    // within tol; end === n closes the chord onto vertex 0 (the ring seam),
    // which lets a smooth ring collapse across the seam too.
    let end = anchor + 2;
    const cap = Math.min(n, anchor + DECIMATE_MAX_SPAN);
    while (end <= cap) {
      const endPt = pts[end % n]!;
      let ok = true;
      for (let j = anchor + 1; j < end; j++) {
        if (deviation(pts[j]!, pts[anchor]!, endPt) > tol) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      end++;
    }
    // end is the first failing chord end (or cap+1); pts[end−1] was the last
    // valid one, so it becomes the next anchor. Vertices past the final
    // anchor are pushed one per iteration once extension keeps failing, so
    // nothing is ever silently dropped from the ring tail.
    out.push(pts[anchor]!);
    anchor = end - 1;
  }
  return out.length >= 3 && out.length < n ? out : pts;
}

/** Valid closed ring (≥3 points, non-near-zero area) with consecutive
 * duplicates and a duplicated closing point dropped. Null when degenerate. */
function cleanRing(pts: Point2[]): Point2[] | null {
  const out: Point2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.u - p.u) < 1e-12 && Math.abs(last.v - p.v) < 1e-12) continue;
    out.push(p);
  }
  if (out.length >= 2) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first.u - last.u) < 1e-12 && Math.abs(first.v - last.v) < 1e-12) out.pop();
  }
  if (out.length < 3) return null;
  if (Math.abs(polygonArea(out)) <= 1e-9) return null;
  return out;
}

/** Rotate a closed ring so it starts at its lexicographically smallest
 * vertex (min u, tie: min v) — deterministic starts for deterministic
 * toolpaths. */
function rotateToCanonicalStart(pts: Point2[]): Point2[] {
  let best = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const b = pts[best]!;
    if (p.u < b.u - 1e-12 || (Math.abs(p.u - b.u) <= 1e-12 && p.v < b.v - 1e-12)) best = i;
  }
  if (best === 0) return pts;
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/** Scaled ring → { points (re-centred, canonical start, winding forced),
 * signed area }; null when the result is dust. */
function unscaleRing(
  path: Array<{ X: number; Y: number }>,
  cu: number,
  cv: number,
  wantCcw: boolean,
): { pts: Point2[]; area: number } | null {
  const pts = path.map((p) => ({ u: p.X / SCALE + cu, v: p.Y / SCALE + cv }));
  const ring = cleanRing(pts);
  if (!ring || Math.abs(polygonArea(ring)) < MIN_RING_AREA) return null;
  const area = polygonArea(ring);
  const wound = area > 0 === wantCcw ? ring : [...ring].reverse();
  return { pts: rotateToCanonicalStart(wound), area: wantCcw ? Math.abs(area) : -Math.abs(area) };
}

/**
 * Offset the region {outer, holes} by `delta` mm (positive = grow the region,
 * negative = erode it) and return the resulting connected components with
 * normalized winding and starts. Pure function, synchronous, no side effects.
 * Degenerate input (outer < 3 points or zero area) yields []; erosion down to
 * nothing also yields [] ("tool too large").
 */
export function offsetRegion(
  outer: Point2[],
  holes: Point2[][],
  delta: number,
  opts: OffsetRegionOptions = {},
): RegionComponent[] {
  if (!Number.isFinite(delta)) return [];
  const outerRing = cleanRing(outer);
  if (!outerRing) return [];
  const holeRings: Point2[][] = [];
  for (const h of holes) {
    const ring = cleanRing(h);
    if (ring) holeRings.push(ring);
  }
  // Force outer CCW / holes CW regardless of how the caller stores islands
  // (topSilhouette hands everything out CCW-normalized).
  const ccwOuter = polygonArea(outerRing) > 0 ? outerRing : [...outerRing].reverse();
  const cwHoles = holeRings.map((h) => (polygonArea(h) < 0 ? h : [...h].reverse()));

  if (Math.abs(delta) < 1e-9) {
    // Zero offset: the region itself, verbatim (winding only). No clipper
    // round trip, so a level-0 ring family pass equals its base region
    // bit-for-bit — the wall ring and the "tool too large" semantics both
    // depend on that identity.
    return [{ outer: ccwOuter, holes: cwHoles }];
  }

  // Re-centre on the bbox midpoint (snapped to the scale grid so exact
  // coordinates stay exact through the round trip), decimate, scale.
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const scanBox = (pts: Point2[]): void => {
    for (const p of pts) {
      if (p.u < minU) minU = p.u;
      if (p.u > maxU) maxU = p.u;
      if (p.v < minV) minV = p.v;
      if (p.v > maxV) maxV = p.v;
    }
  };
  scanBox(ccwOuter);
  for (const h of cwHoles) scanBox(h);
  const cu = Math.round(((minU + maxU) / 2) * SCALE) / SCALE;
  const cv = Math.round(((minV + maxV) / 2) * SCALE) / SCALE;
  const toInt = (pts: Point2[]): Array<{ X: number; Y: number }> =>
    decimateRing(pts, DECIMATE_TOLERANCE).map((p) => ({
      X: Math.round((p.u - cu) * SCALE),
      Y: Math.round((p.v - cv) * SCALE),
    }));

  const miterLimit = opts.miterLimit ?? 3.5;
  const arcTolerance = Math.max(1e-4, opts.arcTolerance ?? DEFAULT_ARC_TOLERANCE);
  const join =
    opts.joinType === 'miter' ? ClipperLib.JoinType.jtMiter : ClipperLib.JoinType.jtRound;
  const co = new ClipperLib.ClipperOffset(miterLimit, arcTolerance * SCALE);
  co.AddPath(toInt(ccwOuter), join, ClipperLib.EndType.etClosedPolygon);
  if (cwHoles.length > 0) {
    co.AddPaths(cwHoles.map(toInt), join, ClipperLib.EndType.etClosedPolygon);
  }
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, Math.round(delta * SCALE));

  const comps: RegionComponent[] = [];
  for (const node of tree.Childs()) {
    const o = unscaleRing(node.Contour(), cu, cv, true);
    if (!o) continue;
    const hs: Point2[][] = [];
    for (const hNode of node.Childs()) {
      // Two levels only (outer + holes). Grandchild rings — an island
      // inside an island, depth ≥ 3 — are dropped. topSilhouette cannot
      // produce that nesting (it yields depth-0 outer + odd-depth islands),
      // so this is unreachable from the CAM pipeline; any future caller
      // feeding deeper polygons must flatten them itself first.
      const h = unscaleRing(hNode.Contour(), cu, cv, false);
      if (h) hs.push(h.pts);
    }
    comps.push({ outer: o.pts, holes: hs });
  }
  // Deterministic order: components by their outer's canonical start vertex,
  // holes within a component the same way.
  const byStart = (a: Point2[], b: Point2[]): number => a[0]!.u - b[0]!.u || a[0]!.v - b[0]!.v;
  for (const comp of comps) comp.holes.sort((a, b) => byStart(a, b));
  comps.sort((a, b) => byStart(a.outer, b.outer));
  return comps;
}
