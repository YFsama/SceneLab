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
/** Radial-fit tolerance: 0.5% of the radius, with an absolute floor. */
const RADIAL_TOL_RATIO = 0.005;
const RADIAL_TOL_FLOOR = 1e-4;
/** |Σturning − 2π| below this accepts a loop as a full convex circle. */
const TOTAL_TURN_TOL = 0.05;
/** Coincidence tolerance for dedupe (stacked prism caps project identically). */
const DEDUPE_RATIO = 0.01;
const DEDUPE_FLOOR = 1e-4;

const key = (p: Pt): string => `${p.x.toFixed(KEY_DECIMALS)},${p.y.toFixed(KEY_DECIMALS)}`;

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
      const next = (adj.get(key(cur)) ?? []).find((c) => !used.has(c.seg));
      if (!next) break;
      used.add(next.seg);
      cur = next.other;
      pts.push(cur);
    }

    // Open chains also grow backward from their head.
    if (!closed) {
      for (let guard = 0; guard <= segs.length; guard++) {
        const prev = (adj.get(key(pts[0]!)) ?? []).find((c) => !used.has(c.seg));
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
  // walk step straight back to its start (bogus 2-point "loops").
  const segs: DrawingLine[] = [];
  const seenSeg = new Set<string>();
  for (const l of lines) {
    if (Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) <= MIN_SEGMENT) continue;
    const ka = key(l.start);
    const kb = key(l.end);
    const uk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seenSeg.has(uk)) continue;
    seenSeg.add(uk);
    segs.push(l);
  }

  const centers: DrawingCenterMark[] = [];
  const arcs: DrawingArc[] = [];

  for (const { pts, closed } of chainSegments(segs)) {
    if (closed && pts.length >= MIN_CIRCLE_SEGMENTS) {
      // Circle: centroid → mean radius → deviation + turning tests.
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
      const turns = turningAngles(pts, true);
      const total = turns.reduce((s, t) => s + t, 0);
      if (
        r > MIN_SEGMENT &&
        sameSignTurns(turns) &&
        Math.abs(Math.abs(total) - 2 * Math.PI) < TOTAL_TURN_TOL &&
        maxRadialDeviation(pts, { x: cx, y: cy }, r) < radialTol(r)
      ) {
        centers.push({ x: cx, y: cy, radius: r });
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
