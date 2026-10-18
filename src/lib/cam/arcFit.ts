import type { ToolpathPoint } from './types';

/**
 * A fitted circular arc replacing a run of coplanar cutting moves, in the
 * spirit of Mastercam's arc filter. All coordinates are SCENE coordinates:
 * the arc lives in the (x, z) planning plane at the constant layer height y,
 * which the G-code post-processor maps onto the machine XY plane (G17).
 */
export interface ArcSpec {
  /** Arc start — an original point object (feedRate/rapid context rides along). */
  start: ToolpathPoint;
  /** Arc end — an original point object; the arc replaces every polyline move up to it. */
  end: ToolpathPoint;
  /** Circle center in scene coordinates (y = the layer height). */
  center: { x: number; y: number; z: number };
  /** Counter-clockwise in the scene (u, v) = (x, z) plane, which IS machine XY. */
  ccw: boolean;
  radius: number;
  /** Sweep in radians, positive, capped at 120°. */
  sweep: number;
}

/** Per-arc sweep cap (rad): keeps arcs away from the full-circle regime where
 * a G2/G3 with near-coincident endpoints is ambiguous for controllers. */
const MAX_SWEEP = (120 * Math.PI) / 180;
/** Radius bounds (mm): tighter than 1 µm or flatter than 1 km is noise. */
const MIN_RADIUS = 1e-3;
const MAX_RADIUS = 1e6;
/** Flatness tolerance (mm) for the constant-layer (y) run test. */
const FLATNESS = 1e-9;
/** |sin(turn)| below this counts as "no turn" (collinear continuation). */
const TURN_EPS = 1e-9;

interface Circle {
  u: number;
  v: number;
  radius: number;
}

/**
 * Circumcircle of three planar points ((u, v) = scene (x, z)). Returns null
 * when the points are coincident or collinear — no finite circle passes
 * through them, so arc extension must stop there.
 */
function circumcircle(
  a: { x: number; z: number },
  m: { x: number; z: number },
  b: { x: number; z: number },
): Circle | null {
  const abU = b.x - a.x;
  const abV = b.z - a.z;
  const amU = m.x - a.x;
  const amV = m.z - a.z;
  const cross = amU * abV - amV * abU;
  const scale = Math.hypot(amU, amV) * Math.hypot(abU, abV);
  if (scale < 1e-18) return null; // coincident points
  if (Math.abs(cross) <= TURN_EPS * scale) return null; // collinear
  const d = 2 * cross;
  const aSq = a.x * a.x + a.z * a.z;
  const mSq = m.x * m.x + m.z * m.z;
  const bSq = b.x * b.x + b.z * b.z;
  const u = (aSq * (m.z - b.z) + mSq * (b.z - a.z) + bSq * (a.z - m.z)) / d;
  const v = (aSq * (b.x - m.x) + mSq * (a.x - b.x) + bSq * (m.x - a.x)) / d;
  const radius = Math.hypot(a.x - u, a.z - v);
  if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(radius) || radius <= 0) return null;
  return { u, v, radius };
}

interface SpanInfo {
  ccw: boolean;
  sweep: number;
}

/**
 * Validate the candidate arc over run[i..e] against the ORIGINAL polyline —
 * the emitted arc is a substitute for it, so the geometry must not move:
 *
 * 1. Every span vertex lies within `tolerance` of the circle radially.
 * 2. Every original SEGMENT stays within `tolerance` of the arc. A sound
 *    bound: radially project each vertex onto the circle (offset = its radial
 *    deviation); the arc over a segment's angular span Δ deviates from that
 *    chord by the sagitta R·(1 − cos(Δ/2)), and two segments whose endpoints
 *    are δ apart stay δ apart everywhere. Vertices alone are NOT enough — a
 *    rectangle's corners are perfectly concyclic while its edges bow
 *    R·(1 − cos 45°) ≈ 0.29·R off that circle.
 * 3. The turn direction never flips: consecutive chords keep one cross-sign,
 *    and the angle around the center advances monotonically.
 * 4. The accumulated sweep respects the 120° cap.
 */
function checkSpan(
  run: ToolpathPoint[],
  i: number,
  e: number,
  c: Circle,
  tolerance: number,
): SpanInfo | null {
  const dev: number[] = [];
  for (let j = i; j <= e; j++) {
    const p = run[j]!;
    const d = Math.abs(Math.hypot(p.x - c.u, p.z - c.v) - c.radius);
    if (d > tolerance) return null;
    dev.push(d);
  }

  let dir = 0; // +1 ccw, −1 cw, 0 undecided
  let sweep = 0;
  let prevChordU = 0;
  let prevChordV = 0;
  let prevChordLen = 0;
  for (let j = i; j < e; j++) {
    const p = run[j]!;
    const q = run[j + 1]!;
    const chordU = q.x - p.x;
    const chordV = q.z - p.z;
    const chordLen = Math.hypot(chordU, chordV);

    // Same-sign chord cross products (the turn at each vertex).
    if (j > i && prevChordLen > 0 && chordLen > 0) {
      const cross = prevChordU * chordV - prevChordV * chordU;
      if (Math.abs(cross) > TURN_EPS * prevChordLen * chordLen) {
        const s = cross > 0 ? 1 : -1;
        if (dir === 0) dir = s;
        else if (s !== dir) return null; // polyline turned the other way
      }
    }

    // Signed angular step between the two vertex rays — direction cross-check
    // plus sweep accumulation and the sagitta bound for this segment.
    const r1U = p.x - c.u;
    const r1V = p.z - c.v;
    const r2U = q.x - c.u;
    const r2V = q.z - c.v;
    const delta = Math.atan2(r1U * r2V - r1V * r2U, r1U * r2U + r1V * r2V);
    if (Math.abs(delta) > 1e-12) {
      const s = delta > 0 ? 1 : -1;
      if (dir === 0) dir = s;
      else if (s !== dir) return null; // angle ran backwards (numerical net)
    }
    sweep += Math.abs(delta);
    if (sweep > MAX_SWEEP) return null;
    const sagitta = c.radius * (1 - Math.cos(Math.abs(delta) / 2));
    if (Math.max(dev[j - i]!, dev[j - i + 1]!) + sagitta > tolerance) return null;

    prevChordU = chordU;
    prevChordV = chordV;
    prevChordLen = chordLen;
  }

  if (dir === 0) return null; // no angular progress — degenerate span
  return { ccw: dir > 0, sweep };
}

/**
 * Greedy longest-arc fit over one constant-y cutting run. The move INTO
 * run[0] (rapid entry or vertical plunge) always stays a straight move; arcs
 * only replace moves from run[0] onward. After an arc ends on run[bestEnd]
 * the next arc starts exactly there — that point is never re-emitted.
 *
 * TRUE-ARC PASSTHROUGH: a point carrying `arcTo` (a marker set by the
 * generator from an analytic cylinder tag — ground truth, not a fit) ends a
 * true arc that replaces every move up to it. The greedy span never extends
 * across a tagged point; when it lands exactly on one, or when the next
 * point is tagged, the tag becomes an ArcSpec verbatim after consistency
 * validation (trueArcSpec below) — no circumcircle, no tolerance spent.
 *
 * Candidate spans are capped at MAX_SPAN_POINTS: checkSpan is linear in the
 * span, so an uncapped greedy pass is O(n²) per run — a 20k-vertex imported
 * mesh contour froze the main thread for ~3.4 s (review pass #33). The cap
 * just splits monster circles into consecutive arcs; sweep is separately
 * bounded by MAX_SWEEP anyway.
 */
const MAX_SPAN_POINTS = 512;

/**
 * Build the ArcSpec for the true arc start → end (the tag rides on the end
 * point). Returns null when the tag is inconsistent — radius wobble beyond
 * 1e-6·r between the endpoints, radius outside the sane bounds, a
 * degenerate (start ≈ end) or over-120° sweep (splitting a true arc is the
 * GENERATOR's job, mirroring the fitted-arc cap) — so the caller degrades
 * that one move to the plain polyline path. The center's y is taken from
 * the end point: arcs live in constant-y runs, and the tag's plane must
 * agree with the layer it was generated on.
 */
function trueArcSpec(start: ToolpathPoint, end: ToolpathPoint): ArcSpec | null {
  const tag = end.arcTo!;
  const c = tag.center;
  const rStart = Math.hypot(start.x - c.x, start.z - c.z);
  const rEnd = Math.hypot(end.x - c.x, end.z - c.z);
  if (!(rStart >= MIN_RADIUS) || !(rStart <= MAX_RADIUS)) return null;
  if (Math.abs(rStart - rEnd) > 1e-6 * rStart) return null;
  const a0 = Math.atan2(start.z - c.z, start.x - c.x);
  const a1 = Math.atan2(end.z - c.z, end.x - c.x);
  let sweep = tag.ccw ? a1 - a0 : a0 - a1;
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep <= 1e-9) return null; // degenerate — e.g. an un-split full circle
  // Note: the sweep cap below is also the direction guard. For any sweep
  // < 180° the chord necessarily advances along the start tangent implied
  // by ccw (tangent·chord = r²·sin(sweep) > 0), so a tag whose flag
  // contradicts the geometry can only describe the complement arc
  // (2π − θ ≥ 240°) — which the cap rejects here.
  if (sweep > MAX_SWEEP + 1e-9) return null;
  return {
    start,
    end,
    center: { x: c.x, y: end.y, z: c.z },
    ccw: tag.ccw,
    radius: rStart,
    sweep,
  };
}

function emitRun(run: ToolpathPoint[], tolerance: number, out: Array<ToolpathPoint | ArcSpec>): void {
  out.push(run[0]!);
  // nextTag[k] = smallest t > k whose point carries a true-arc tag (−1 when
  // none) — tags bound the greedy extension so a fitted span can never
  // swallow a tagged endpoint as an intermediate vertex.
  const nextTag = new Array<number>(run.length).fill(-1);
  let nt = -1;
  for (let k = run.length - 1; k >= 0; k--) {
    nextTag[k] = nt;
    if (run[k]!.arcTo) nt = k;
  }
  let pos = 0;
  while (pos < run.length - 1) {
    const tagEnd = nextTag[pos]!;
    const eMax = Math.min(run.length - 1, pos + MAX_SPAN_POINTS, tagEnd === -1 ? Infinity : tagEnd);
    let bestEnd = -1;
    let best: { circle: Circle; ccw: boolean; sweep: number } | null = null;
    for (let e = pos + 2; e <= eMax; e++) {
      // Three-point circumcircle: run start, a middle vertex, candidate end.
      const circle = circumcircle(run[pos]!, run[(pos + e) >> 1]!, run[e]!);
      if (!circle) break; // collinear/degenerate — stop extending
      if (circle.radius < MIN_RADIUS || circle.radius > MAX_RADIUS) break;
      const span = checkSpan(run, pos, e, circle, tolerance);
      if (!span) break; // first failing candidate ends the greedy extension
      bestEnd = e;
      best = { circle, ccw: span.ccw, sweep: span.sweep };
    }
    if (best && bestEnd > pos) {
      if (bestEnd === tagEnd) {
        // The greedy landed exactly on a true-arc end: the analytic tag is
        // the better geometry — honour it when it validates.
        const trueArc = trueArcSpec(run[pos]!, run[bestEnd]!);
        if (trueArc) {
          out.push(trueArc);
          pos = bestEnd;
          continue;
        }
      }
      out.push({
        start: run[pos]!,
        end: run[bestEnd]!,
        center: { x: best.circle.u, y: run[pos]!.y, z: best.circle.v },
        ccw: best.ccw,
        radius: best.circle.radius,
        sweep: best.sweep,
      });
      pos = bestEnd;
    } else {
      pos += 1;
      if (pos === tagEnd) {
        const trueArc = trueArcSpec(run[pos - 1]!, run[pos]!);
        if (trueArc) {
          out.push(trueArc);
          continue;
        }
      }
      out.push(run[pos]!);
    }
  }
}

/**
 * Fit coplanar cutting runs to arcs (Mastercam arc-filter style). Runs are
 * maximal sequences of consecutive non-rapid points at one layer height
 * (1e-9 flatness): rapids and ANY depth change (ramps, tab climbs) break a
 * run and can never be swallowed by an arc. Every returned point item is the
 * ORIGINAL point object, and an ArcSpec's start/end reference original
 * objects too, so feedRate/rapid context travels with them. A tolerance that
 * is non-positive or non-finite disables fitting (pure polyline
 * pass-through). Points carrying `arcTo` (generator-marked true arcs from
 * analytic cylinder tags) pass through as ArcSpecs verbatim after radius/
 * sweep validation — see emitRun.
 */
export function fitArcs(points: ToolpathPoint[], tolerance: number): Array<ToolpathPoint | ArcSpec> {
  const out: Array<ToolpathPoint | ArcSpec> = [];
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    // Fitting disabled — but true-arc tags are not fits, they are ground
    // truth from the generator: honour them (validated) anyway, else a
    // disabled fitter would silently turn a true circle into three 120°
    // chords that gouge 6.5 mm at R13 (sag = r·(1 − cos(sweep/2))). Only
    // the greedy polyline fitting is switched off; tags on rapids/depth
    // changes are structurally absent.
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const prev = points[i - 1];
      if (p.arcTo && prev && !prev.rapid && Math.abs(p.y - prev.y) <= FLATNESS) {
        const arc = trueArcSpec(prev, p);
        if (arc) {
          out.push(arc);
          continue;
        }
      }
      out.push(p);
    }
    return out;
  }

  let i = 0;
  while (i < points.length) {
    const p = points[i]!;
    if (p.rapid) {
      out.push(p);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < points.length && !points[j]!.rapid && Math.abs(points[j]!.y - p.y) <= FLATNESS) {
      j += 1;
    }
    // points[i, j) is one flat cutting run; arcs need ≥ 3 points (2 moves).
    if (j - i >= 3) emitRun(points.slice(i, j), tolerance, out);
    else out.push(...points.slice(i, j));
    i = j;
  }
  return out;
}
