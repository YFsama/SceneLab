/**
 * Circle/arc recognition over a view's projected line soup.
 *
 * The BREP tessellates cylinders as n-gon prisms (32 segments by default), so
 * every hole and boss reaches the drawing sheet as a pile of straight chords.
 * This module chains those chords back into loops and open polylines, then
 * classifies each chain:
 *
 *  - a CLOSED loop of >= MIN_CIRCLE_SEGMENTS segments whose vertices all sit
 *    on one circle (radial deviation + convex same-sign turning + total turn
 *    2π) is a circle → an ASME center mark;
 *  - an OPEN chain of constant curvature is a fitted arc (Kåså algebraic
 *    circle fit) → a DrawingView.arcs entry, so renderers can draw true arcs
 *    instead of the chords.
 *
 * Detection is additive: the source tessellation lines stay in
 * DrawingView.lines (detail views and any consumer that ignores `arcs` keep
 * working); `centers`/`arcs` are extra knowledge about the same geometry.
 */
import type { DrawingArc, DrawingCenterMark, DrawingLine } from './drawing';

/** Result of running detection over a view's lines. */
export interface CircleDetection {
  /**
   * Circle centers to mark. Coincident detections are collapsed twice over:
   * identical projected segments are deduplicated before chaining (stacked
   * prism caps project to the same segments), and near-coincident fitted
   * centers/radii are deduplicated after classification.
   */
  centers: DrawingCenterMark[];
  /** Open constant-curvature chains, as arcs. */
  arcs: DrawingArc[];
}

type Pt = { x: number; y: number };

/** Segments shorter than this (in view units) are projection noise. */
const MIN_SEGMENT = 1e-9;
/** Endpoint quantization for chaining (same grid as drawing.ts loops). */
const KEY_DECIMALS = 6;
/** A closed loop needs at least this many segments to read as a circle. */
const MIN_CIRCLE_SEGMENTS = 8;
/** An open arc needs at least this many points (≥ 3 turning angles). */
const MIN_ARC_POINTS = 5;
/**
 * Radial-fit tolerance: 0.5% of the radius, with an absolute floor. RELATIVE
 * on purpose, unlike the absolute (0.005 mm) sagitta gate of
 * detectCircularHoles in geometry/query.ts: a drawing only needs the loop to
 * look circular at sheet scale, whatever the part size, while CAM drilling
 * must quote the pin-that-fits truth in millimetres.
 */
const RADIAL_TOL_RATIO = 0.005;
const RADIAL_TOL_FLOOR = 1e-4;
/** |Σturning − 2π| below this accepts a loop as a full convex circle. */
const TOTAL_TURN_TOL = 0.05;
/**
 * Turning-angle tie band for the chain continuation pick (in the same 1−cos
 * units as the pick itself): candidates this close in angle are decided by the
 * lowest quantized endpoint key so the walk stays deterministic.
 */
const TURN_TIE = 1e-12;
/**
 * Length-consistency band for the chain continuation pick: a candidate whose
 * length is within this factor of the incoming segment (either way) counts as
 * length-consistent and beats length-inconsistent ones. Tessellation chords of
 * one circle are equal-length; seam spokes to outer corners are 10-50× longer,
 * and a wider band lets an unrelated walk ramp its step length down onto a
 * ring one halving at a time (each step may shrink by the band factor), so the
 * band is kept tight. Ordinary chaining with varying edge lengths is
 * unaffected — when nothing is length-consistent the pick falls back to the
 * pure smallest turn.
 */
const LENGTH_BAND = 1.5;
/** Coincidence tolerance for dedupe (stacked prism caps project identically). */
const DEDUPE_RATIO = 0.01;
const DEDUPE_FLOOR = 1e-4;

const key = (p: Pt): string => `${fmt(p.x)},${fmt(p.y)}`;

/** Matches a toFixed result that is all zeroes with a leading minus. */
const NEG_ZERO = /^-0(?:\.0+)?$/;

/**
 * toFixed with negative zero normalized: a coordinate that quantizes to
 * "-0.000000" (e.g. r·sin(2π) = −2.4e-16, the recomputed closing vertex of a
 * tessellation loop) must key EQUAL to "0.000000". Without this the closure
 * check in chainSegments fails on that joint and a real circle downgrades to
 * a full-turn arc.
 */
function fmt(n: number): string {
  const s = n.toFixed(KEY_DECIMALS);
  return s.charCodeAt(0) === 45 && NEG_ZERO.test(s) ? s.slice(1) : s;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Signed turning angle at vertex b for the polyline a→b→c (CCW positive). */
function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const d1x = b.x - a.x;
  const d1y = b.y - a.y;
  const d2x = c.x - b.x;
  const d2y = c.y - b.y;
  return Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y);
}

/** All turning angles strictly one sign (zero/reversal turns break circles). */
function sameSignTurns(turns: number[]): boolean {
  let sign = 0;
  for (const t of turns) {
    if (Math.abs(t) < 1e-9) return false; // collinear run — not a circle
    const s = t > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

interface Chain {
  pts: Pt[];
  closed: boolean;
}

/**
 * Chain segments sharing quantized endpoints into maximal polylines. A chain
 * that arrives back at its first point is closed (the duplicate arrival point
 * is dropped). The 2D analogue of drawing.ts's chainOnPlaneLoops, extended to
 * keep open chains (section cuts break cap loops open).
 *
 * At a vertex with several unused incident segments (degree ≥ 3) the walk
 * continues along the SMALLEST TURNING ANGLE relative to the incoming
 * direction (tangent continuation), ties broken by the lowest quantized
 * endpoint key. Boolean- Cut / Hole results project extra seam edges whose
 * endpoints land exactly on ring chord vertices; taking the first unused
 * incident edge wanders off down a seam spoke and the ring never closes, so
 * machined holes lost their center marks entirely (QA F7). The ring's own
 * chords turn ~11° (32-gon); radial seam spokes turn ~90°. One wrinkle the
 * pure angle rule cannot survive: face triangulations connect OUTER corners
 * to ring vertices, and by the tangent-chord theorem some of those spokes
 * leave within ~5° of the ring tangent — straighter than any chord. Those
 * spokes are 50×+ the chord length, so among angle-competitive candidates the
 * walk prefers one whose length is consistent with the incoming segment
 * (tessellation chords of one circle are all the same length); with no
 * length-consistent candidate it falls back to the smallest turn.
 *
 * Real-kernel boolean soups (sketch rect → extrude → Feature Hole) defeat
 * those local rules in two more ways, both closed here:
 *
 *  - The plate's cap triangulation arrives at ring vertices ON long fan
 *    spokes. Spokes are length-consistent with each other (not with the
 *    chords), so a walk sweeping the fan hops spoke→spoke straight through
 *    ring vertices, steps onto a ring only at spoke-free vertices, and walks
 *    the WHOLE ring before dead-ending at its entry vertex. The ring is
 *    inside that walk, bracketed by the repeated entry vertex → after the
 *    forward walk any repeated vertex whose bracketed sub-walk passes the
 *    circle tests is carved out as a closed chain (the seam prefix stays
 *    open). Definitive circle evidence, independent of walk order.
 *  - Chord-length near-tangential fan spokes (the plate corner's fan) tie or
 *    beat the closing chord on BOTH angle and length at the vertex adjacent
 *    to the walk's start. So when a continuation exists that leads straight
 *    back to the START vertex, it is tried speculatively first: if the loop
 *    it closes passes the circle tests the walk closes there; only when that
 *    fails does the normal pick stand. (A closed walk that fits a circle IS
 *    the ring; the spokes are decoration.)
 */
function chainSegments(segs: DrawingLine[]): Chain[] {
  const adj = new Map<string, { seg: number; other: Pt }[]>();
  segs.forEach((s, i) => {
    const ka = key(s.start);
    const kb = key(s.end);
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push({ seg: i, other: s.end });
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push({ seg: i, other: s.start });
  });

  const used = new Set<number>();

  /** Strictly better under (turn, endpoint-key) with the deterministic tie band. */
  const beats = (turn: number, k: string, refTurn: number, refKey: string): boolean =>
    turn < refTurn - TURN_TIE || (Math.abs(turn - refTurn) <= TURN_TIE && k < refKey);

  /**
   * Straightest continuation from `to` having arrived from `from`: the unused
   * incident segment minimizing the turn |∠(from→to, to→next)|, ties broken by
   * the lowest quantized endpoint key. Null at a dead end. A single candidate
   * short-circuits (the common degree-2 case, identical to the historical
   * first-unused pick). Candidates whose length is within
   * [1/LENGTH_BAND, LENGTH_BAND] of the incoming segment win over
   * length-inconsistent ones (seam-spoke suppression); when NOTHING is
   * length-consistent the most length-SIMILAR candidate wins (a walk arriving
   * on a long seam spoke must not hand off to a short chord just because the
   * chord is the straightest — that swallows the whole ring into the seam
   * chain, QA F7).
   */
  const straightest = (from: Pt, to: Pt): { seg: number; other: Pt } | null => {
    const cands = (adj.get(key(to)) ?? []).filter((c) => !used.has(c.seg));
    if (cands.length === 0) return null;
    if (cands.length === 1) return cands[0]!;
    const inDx = to.x - from.x;
    const inDy = to.y - from.y;
    const inLen = Math.hypot(inDx, inDy);
    if (inLen < MIN_SEGMENT) return cands[0]!; // degenerate hop — keep old pick
    let best: { seg: number; other: Pt } | null = null;
    let bestTurn = Infinity;
    let bestKey = '';
    let bandBest: { seg: number; other: Pt } | null = null;
    let bandTurn = Infinity;
    let bandKey = '';
    let simBest: { seg: number; other: Pt } | null = null;
    let simRatio = Infinity;
    let simTurn = Infinity;
    let simKey = '';
    for (const c of cands) {
      const outDx = c.other.x - to.x;
      const outDy = c.other.y - to.y;
      const outLen = Math.hypot(outDx, outDy);
      if (outLen < MIN_SEGMENT) continue;
      const cos = (inDx * outDx + inDy * outDy) / (inLen * outLen);
      const turn = 1 - Math.max(-1, Math.min(1, cos)); // monotone in |turn angle|
      const k = key(c.other);
      if (beats(turn, k, bestTurn, bestKey)) {
        best = c;
        bestTurn = turn;
        bestKey = k;
      }
      // Log-length distance from the incoming segment (0 = same length).
      const ratio = Math.abs(Math.log(outLen / inLen));
      const simWins =
        simBest === null ||
        ratio < simRatio - 1e-12 ||
        (Math.abs(ratio - simRatio) <= 1e-12 && beats(turn, k, simTurn, simKey));
      if (simWins) {
        simBest = c;
        simRatio = ratio;
        simTurn = turn;
        simKey = k;
      }
      if (outLen > inLen / LENGTH_BAND && outLen < inLen * LENGTH_BAND && beats(turn, k, bandTurn, bandKey)) {
        bandBest = c;
        bandTurn = turn;
        bandKey = k;
      }
    }
    return bandBest ?? simBest ?? best;
  };

  const chains: Chain[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const seg = segs[i]!;
    const startKey = key(seg.start);
    const pts: Pt[] = [seg.start, seg.end];
    let closed = false;

    // Walk forward from the segment's end until closure or a dead end.
    let cur = seg.end;
    for (let guard = 0; guard <= segs.length; guard++) {
      if (key(cur) === startKey) {
        closed = true;
        pts.pop(); // drop the duplicated closing point
        break;
      }
      const next = straightest(pts[pts.length - 2]!, cur);
      if (!next) break;
      // Speculative start-closure (see the header comment): an unused
      // continuation back to the walk's start vertex outranks the normal pick
      // when the loop it would close passes the circle tests. The loop that
      // would be classified is pts itself (the arrival point is pushed then
      // popped by the closure check below), so that is what gets tested.
      if (pts.length >= MIN_CIRCLE_SEGMENTS && key(next.other) !== startKey) {
        const closing = (adj.get(key(cur)) ?? []).find(
          (c) => !used.has(c.seg) && key(c.other) === startKey,
        );
        if (closing && circularLoop(pts)) {
          used.add(closing.seg);
          cur = closing.other;
          pts.push(cur);
          continue;
        }
      }
      used.add(next.seg);
      cur = next.other;
      pts.push(cur);
    }

    // Ring-inside-a-walk recovery: a walk that entered a ring down a seam
    // spoke and walked the whole loop dead-ends at (or passes through) its
    // entry vertex — any vertex appearing twice brackets a sub-walk. Carve
    // out the LONGEST bracketed sub-walk that passes the circle tests as a
    // closed chain; the seam prefix stays open for the backward growth below.
    if (!closed) {
      const firstSeen = new Map<string, number>();
      let carved: { pts: Pt[]; head: number } | null = null;
      for (let k = 0; k < pts.length; k++) {
        const kk = key(pts[k]!);
        const j = firstSeen.get(kk);
        if (j === undefined) {
          firstSeen.set(kk, k);
          continue;
        }
        if (k - j >= 3 && circularLoop(pts.slice(j, k))) {
          const len = k - j;
          if (!carved || len > carved.pts.length) carved = { pts: pts.slice(j, k), head: j };
        }
      }
      if (carved) {
        chains.push({ pts: carved.pts, closed: true });
        pts.length = carved.head; // the seam prefix remains an open chain
      }
    }

    // Open chains also grow backward from their head (same straightest-line
    // rule, evaluated through the head: ...→p→pts[0]→pts[1] should run
    // straight through pts[0]).
    if (!closed && pts.length >= 2) {
      for (let guard = 0; guard <= segs.length; guard++) {
        if (pts.length < 2) break;
        const prev = straightest(pts[1]!, pts[0]!);
        if (!prev) break;
        used.add(prev.seg);
        pts.unshift(prev.other);
      }
    }
    chains.push({ pts, closed });
  }
  return chains;
}

/**
 * Kåså algebraic circle fit: least squares of ‖p−c‖² − r² over the points,
 * reduced to a 3×3 linear system in (cx, cy, c). Biases slightly small on
 * arcs (fine for annotation radii).
 */
function fitCircle(pts: Pt[]): { center: Pt; radius: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
    sxz += p.x * z;
    syz += p.y * z;
    sz += z;
  }
  // Normal equations for x²+y² = 2a·x + 2b·y + c (center (a,b)):
  // [2sxx 2sxy sx][a]   [sxz]
  // [2sxy 2syy sy][b] = [syz]
  // [sx   sy   n ][c]   [sz ]
  const m = [
    [2 * sxx, 2 * sxy, sx],
    [2 * sxy, 2 * syy, sy],
    [sx, sy, n],
  ];
  const v = [sxz, syz, sz];
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    }
    if (Math.abs(m[piv]![col]!) < 1e-12) return null; // degenerate (collinear)
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    [v[col], v[piv]] = [v[piv]!, v[col]!];
    for (let r = col + 1; r < 3; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c < 3; c++) m[r]![c]! -= f * m[col]![c]!;
      v[r]! -= f * v[col]!;
    }
  }
  const sol = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let acc = v[r]!;
    for (let c = r + 1; c < 3; c++) acc -= m[r]![c]! * sol[c]!;
    sol[r] = acc / m[r]![r]!;
  }
  const cx = sol[0]!;
  const cy = sol[1]!;
  const r2 = sol[2]! + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  return { center: { x: cx, y: cy }, radius: Math.sqrt(r2) };
}

/** Max |‖p−c‖ − r| over the points: how far off the fitted circle they sit. */
function maxRadialDeviation(pts: Pt[], center: Pt, radius: number): number {
  let max = 0;
  for (const p of pts) {
    max = Math.max(max, Math.abs(dist(p, center) - radius));
  }
  return max;
}

/** Turning angles at the interior vertices (open) / every vertex (closed). */
function turningAngles(pts: Pt[], closed: boolean): number[] {
  const n = pts.length;
  const turns: number[] = [];
  const stop = closed ? n : n - 1;
  for (let i = 0; i < stop; i++) {
    turns.push(turnAngle(pts[(i - 1 + n) % n]!, pts[i]!, pts[(i + 1) % n]!));
  }
  return turns;
}

const radialTol = (r: number): number => Math.max(RADIAL_TOL_RATIO * r, RADIAL_TOL_FLOOR);

/**
 * The closed-loop circle tests: centroid → mean radius, then radial
 * deviation + convex same-sign turning + total turn ≈ 2π. Returns the fitted
 * (center, radius) when every test passes, else null. The classifier and the
 * chain walker's closure rules share this one predicate so "this walk IS the
 * ring" is decided identically everywhere.
 */
function circularLoop(pts: Pt[]): { center: Pt; radius: number } | null {
  if (pts.length < MIN_CIRCLE_SEGMENTS) return null;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let r = 0;
  for (const p of pts) r += dist(p, { x: cx, y: cy });
  r /= pts.length;
  if (!(r > MIN_SEGMENT)) return null;
  const turns = turningAngles(pts, true);
  if (!sameSignTurns(turns)) return null;
  const total = turns.reduce((s, t) => s + t, 0);
  if (Math.abs(Math.abs(total) - 2 * Math.PI) >= TOTAL_TURN_TOL) return null;
  if (maxRadialDeviation(pts, { x: cx, y: cy }, r) >= radialTol(r)) return null;
  return { center: { x: cx, y: cy }, radius: r };
}

/**
 * Honest radius for a closed regular n-gon loop of circumradius r. View units
 * carry no physical scale, so the tessellation test is RELATIVE: when the
 * relative sagitta 1 − cos(π/n) is within RADIAL_TOL_RATIO the loop is a fine
 * circular tessellation and the circumradius — the radius of the circle the
 * tessellator aimed at — is quoted exactly (n ≥ 32 under the current 0.5%
 * ratio); a coarser, deliberate n-gon (a 16-gon sketch circle extrusion, hex
 * stock) is sized by its across-flats incircle r·cos(π/n) instead.
 */
function reportedRadius(r: number, n: number): number {
  return 1 - Math.cos(Math.PI / n) > RADIAL_TOL_RATIO ? r * Math.cos(Math.PI / n) : r;
}

/** The center point of either detection shape (mark or arc). */
function centerOf(d: { center: Pt; radius: number } | DrawingCenterMark): Pt {
  return 'center' in d ? d.center : d;
}

/** Coincident for dedupe: same center and radius within tolerance. */
function coincident(
  a: { center: Pt; radius: number } | DrawingCenterMark,
  b: { center: Pt; radius: number } | DrawingCenterMark,
): boolean {
  const tol = Math.max(DEDUPE_RATIO * Math.max(a.radius, b.radius), DEDUPE_FLOOR);
  return dist(centerOf(a), centerOf(b)) < tol && Math.abs(a.radius - b.radius) < tol;
}

/**
 * Detect circles and arcs in a view's projected lines (run by projectBodies
 * after the section clip). Tessellation lines are NOT removed — the marks and
 * arcs annotate the same geometry the lines already draw.
 */
export function detectCircles(lines: DrawingLine[]): CircleDetection {
  // Drop degenerate segments (projecting a cylinder's side edges along their
  // axis yields points) and duplicates: stacked prism caps project to the
  // exact same 2D segments, and a duplicate parallel edge makes the chain
  // walk step straight back to its start (bogus 2-point "loops"). Degenerate
  // means zero-length OR both endpoints quantizing to the SAME key — boolean
  // kernels emit sub-1e-6 sliver edges whose length survives the 1e-9 floor
  // while both endpoints key identically; such a self-loop edge adds TWO
  // adjacency entries at one key and poisons the walk.
  const segs: DrawingLine[] = [];
  const seenSeg = new Set<string>();
  for (const l of lines) {
    const ka = key(l.start);
    const kb = key(l.end);
    if (ka === kb) continue;
    if (Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) <= MIN_SEGMENT) continue;
    const uk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seenSeg.has(uk)) continue;
    seenSeg.add(uk);
    segs.push(l);
  }

  const centers: DrawingCenterMark[] = [];
  const arcs: DrawingArc[] = [];

  for (const { pts, closed } of chainSegments(segs)) {
    if (closed) {
      // Circle: centroid radius + deviation + turning tests (one shared
      // predicate with the walker's closure rules).
      const fit = circularLoop(pts);
      if (fit) {
        centers.push({
          x: fit.center.x,
          y: fit.center.y,
          radius: reportedRadius(fit.radius, pts.length),
        });
        continue;
      }
    }
    if (!closed && pts.length >= MIN_ARC_POINTS) {
      // Arc: open constant-curvature chain (e.g. a sectioned cap).
      const turns = turningAngles(pts, false);
      if (!sameSignTurns(turns)) continue;
      const fit = fitCircle(pts);
      if (!fit) continue;
      const { center, radius } = fit;
      if (!(radius > MIN_SEGMENT)) continue;
      if (maxRadialDeviation(pts, center, radius) >= radialTol(radius)) continue;
      const ccw = turns[0]! > 0;
      arcs.push({
        center,
        radius,
        startAngle: Math.atan2(pts[0]!.y - center.y, pts[0]!.x - center.x),
        endAngle: Math.atan2(pts[pts.length - 1]!.y - center.y, pts[pts.length - 1]!.x - center.x),
        ccw,
      });
    }
  }

  // Dedupe coincident detections: a prism's stacked caps project to identical
  // loops, and a sectioned one yields identical open chains.
  return {
    centers: centers.filter((c, i) => !centers.slice(0, i).some((p) => coincident(p, c))),
    arcs: arcs.filter((a, i) => !arcs.slice(0, i).some((p) => coincident(p, a))),
  };
}
