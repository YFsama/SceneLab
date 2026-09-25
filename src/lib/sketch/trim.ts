// Sketch Trim & Extend (Fusion 360 / SolidWorks 2D parity): Trim removes the
// piece of an entity you click — bounded by where other (non-construction)
// lines cross it, and deleted entirely when nothing crosses it. Extend moves
// a line endpoint (or sweeps an arc end) out to the nearest crossing with
// another line in the clicked direction. Both mutate the passed sketch
// (engine convention) and clean up orphaned points via removeEntity.
import type { Sketch, SketchLine, SketchCircle, SketchArc, Vec2 } from './types';
import { addPoint, addLineBetween, addArc, removeEntity } from './engine';

const TWO_PI = Math.PI * 2;

/** Junction-identity precision — same 6-decimal position key convention as
 * offset.ts's findClosedLoop (freehand segments never share point ids). */
const posKey = (p: Vec2): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
/** Parametric "on the segment" slack (in parameter units). */
const T_EPS = 1e-9;
/** Pieces/spans shorter than this (mm) are degenerate and dropped. */
const MIN_PIECE = 1e-6;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
/** x normalised into [0, 2π). */
const norm = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A sketch line's endpoint coordinates (null if its points are missing). */
function lineEnds(sketch: Sketch, l: SketchLine): { a: Vec2; b: Vec2 } | null {
  const p1 = sketch.entities.get(l.p1Id);
  const p2 = sketch.entities.get(l.p2Id);
  if (p1?.type !== 'point' || p2?.type !== 'point') return null;
  return { a: { x: p1.x, y: p1.y }, b: { x: p2.x, y: p2.y } };
}

/** Every OTHER non-construction line in the sketch (the cutting boundaries). */
function cutterLines(sketch: Sketch, targetId: string): SketchLine[] {
  const out: SketchLine[] = [];
  for (const e of sketch.entities.values()) {
    if (e.type === 'line' && e.id !== targetId && !e.construction) out.push(e);
  }
  return out;
}

/** Segment×segment intersection (endpoint touches included), or null when the
 * segments are parallel/collinear (no single cut point) or disjoint. */
function segmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-12) return null;
  const cx = b1.x - a1.x, cy = b1.y - a1.y;
  const t = (cx * dby - cy * dbx) / denom;
  const u = (day * cx - dax * cy) / denom;
  if (t < -T_EPS || t > 1 + T_EPS || u < -T_EPS || u > 1 + T_EPS) return null;
  return { x: a1.x + dax * t, y: a1.y + day * t };
}

/** Proper crossing points of a segment with a circle (tangent touches yield
 * none — a tangent bounds no deleted span). */
function segmentCircleHits(l1: Vec2, l2: Vec2, c: Vec2, r: number): Vec2[] {
  const dx = l2.x - l1.x, dy = l2.y - l1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-24 || !(r > 0)) return [];
  const fx = l1.x - c.x, fy = l1.y - c.y;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * len2 * cc;
  if (disc <= 1e-12) return [];
  const root = Math.sqrt(disc);
  const out: Vec2[] = [];
  for (const t of [(-b - root) / (2 * len2), (-b + root) / (2 * len2)]) {
    if (t < -T_EPS || t > 1 + T_EPS) continue;
    out.push({ x: l1.x + dx * t, y: l1.y + dy * t });
  }
  return out;
}

/**
 * Trim the piece of `targetId` containing `cutPoint` (Fusion's TRIM): a line
 * is cut at every crossing with other non-construction lines and the clicked
 * piece removed (the surviving pieces become fresh lines, sharing junction
 * point ids where they coincide with existing points); with no crossings the
 * whole line is deleted. Circles and arcs crossed by lines keep one arc per
 * surviving span (a 4-crossing circle clicked in one span keeps THREE arcs);
 * with no crossings the whole entity is deleted. True when anything changed.
 */
export function trimSketchEntityAt(sketch: Sketch, targetId: string, cutPoint: Vec2): boolean {
  const target = sketch.entities.get(targetId);
  if (!target) return false;
  if (target.type === 'line') return trimLine(sketch, target, cutPoint);
  if (target.type === 'circle') return trimCircle(sketch, target, cutPoint);
  if (target.type === 'arc') return trimArc(sketch, target, cutPoint);
  return false; // points/rectangles are not trimmable
}

/** Dedupe cut positions, dropping repeats and near-endpoint slivers. */
function sortedCuts(sketch: Sketch, targetId: string, a: Vec2, b: Vec2): Vec2[] {
  const hits: Vec2[] = [];
  for (const cutter of cutterLines(sketch, targetId)) {
    const ends = lineEnds(sketch, cutter);
    if (!ends) continue;
    const hit = segmentIntersection(a, b, ends.a, ends.b);
    if (hit) hits.push(hit);
  }
  const seen = new Set<string>();
  return hits
    .filter((p) => {
      const k = posKey(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return dist(p, a) > MIN_PIECE && dist(p, b) > MIN_PIECE; // no zero-length slivers
    })
    .sort((p, q) => dist(a, p) - dist(a, q));
}

function trimLine(sketch: Sketch, target: SketchLine, cutPoint: Vec2): boolean {
  const ends = lineEnds(sketch, target);
  if (!ends) return false;
  const { a, b } = ends;
  const len = dist(a, b);
  if (len < MIN_PIECE) return false;

  const cuts = sortedCuts(sketch, target.id, a, b);
  if (cuts.length === 0) {
    removeEntity(sketch, target.id); // nothing bounds the clicked piece — whole line goes
    return true;
  }

  // Pieces between consecutive stops [a, cut…cut, b], dropping degenerates.
  const stops: Vec2[] = [a, ...cuts, b];
  const tOf = (p: Vec2): number =>
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
  const pieces: { from: Vec2; to: Vec2 }[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if (dist(stops[i]!, stops[i + 1]!) >= MIN_PIECE) pieces.push({ from: stops[i]!, to: stops[i + 1]! });
  }

  // Which piece did the user click? Project the point onto the segment
  // (clamped), then take the piece containing it — nearest piece if the click
  // lands in a degenerate gap.
  const tCut = clamp(tOf(cutPoint), 0, 1);
  let hit = -1;
  let bestGap = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    const t1 = tOf(pieces[i]!.from), t2 = tOf(pieces[i]!.to);
    if (tCut >= t1 - 1e-12 && tCut <= t2 + 1e-12) { hit = i; break; }
    const gap = tCut < t1 ? t1 - tCut : tCut - t2;
    if (gap < bestGap) { bestGap = gap; hit = i; }
  }
  if (hit === -1 || pieces.length === 0) {
    removeEntity(sketch, target.id);
    return true;
  }

  // Keep every OTHER piece. Endpoints reuse existing point ids at the same
  // position (position-keyed junctions — shared rectangle corners stay shared
  // and their constraints survive), creating fresh points only for new spots.
  const byPos = new Map<string, string>();
  for (const e of sketch.entities.values()) {
    if (e.type === 'point') byPos.set(posKey(e), e.id);
  }
  const pointAt = (p: Vec2): string => {
    const k = posKey(p);
    const existing = byPos.get(k);
    if (existing) return existing;
    const created = addPoint(sketch, p.x, p.y).id;
    byPos.set(k, created);
    return created;
  };
  for (let i = 0; i < pieces.length; i++) {
    if (i === hit) continue;
    const line = addLineBetween(sketch, pointAt(pieces[i]!.from), pointAt(pieces[i]!.to));
    if (target.construction) line.construction = true;
  }
  removeEntity(sketch, target.id); // cleans its orphaned points + constraints
  return true;
}

function trimCircle(sketch: Sketch, target: SketchCircle, cutPoint: Vec2): boolean {
  const c = sketch.entities.get(target.centerId);
  if (c?.type !== 'point') return false;
  const center = { x: c.x, y: c.y };
  const r = target.radius;
  if (!(r > 0)) return false;

  const angles = circleCrossingAngles(sketch, target.id, center, r);
  if (angles.length < 2) {
    removeEntity(sketch, target.id); // no proper crossing — trim to nothing
    return true;
  }
  angles.sort((p, q) => norm(p) - norm(q));

  // CCW spans between consecutive crossings; find the one containing the click.
  const aCut = norm(Math.atan2(cutPoint.y - center.y, cutPoint.x - center.x));
  const k = angles.length;
  let spanIdx = k - 1; // default: the wrapping span [a_{k-1} → a_0 + 2π]
  for (let i = 0; i < k; i++) {
    const from = norm(angles[i]!);
    const to = i + 1 < k ? norm(angles[i + 1]!) : norm(angles[0]!) + TWO_PI;
    if (aCut >= from - 1e-12 && aCut <= to + 1e-12) { spanIdx = i; break; }
  }

  // One arc per SURVIVING span (a 4-crossing circle keeps three arcs — same
  // as Fusion, which never merges disconnected spans).
  for (let i = 0; i < k; i++) {
    if (i === spanIdx) continue;
    const from = norm(angles[i]!);
    const to = i + 1 < k ? norm(angles[i + 1]!) : norm(angles[0]!) + TWO_PI;
    if ((to - from) * r < MIN_PIECE) continue; // degenerate sliver span
    const arc = addArc(sketch, center.x, center.y, r, from, from + (to - from));
    if (target.construction) arc.construction = true;
  }
  removeEntity(sketch, target.id);
  return true;
}

/** Position-deduped crossing angles of every cutter line with a circle. */
function circleCrossingAngles(sketch: Sketch, targetId: string, center: Vec2, r: number): number[] {
  const seen = new Set<string>();
  const angles: number[] = [];
  for (const cutter of cutterLines(sketch, targetId)) {
    const ends = lineEnds(sketch, cutter);
    if (!ends) continue;
    for (const hit of segmentCircleHits(ends.a, ends.b, center, r)) {
      const k = posKey(hit);
      if (seen.has(k)) continue;
      seen.add(k);
      angles.push(Math.atan2(hit.y - center.y, hit.x - center.x));
    }
  }
  return angles;
}

function trimArc(sketch: Sketch, target: SketchArc, cutPoint: Vec2): boolean {
  const c = sketch.entities.get(target.centerId);
  if (c?.type !== 'point') return false;
  const center = { x: c.x, y: c.y };
  const r = target.radius;
  if (!(r > 0)) return false;
  const sa = target.startAngle;
  const ea = target.endAngle;
  const sweep = ea - sa;
  const spanArc = norm(sweep);
  if (spanArc < 1e-9) return false; // degenerate (zero-sweep) arc
  // Sweep-space parameter: t(angle) ∈ [0, spanArc] along the arc's own
  // direction (+CCW for positive sweeps, backwards for CW arcs).
  const dir = sweep > 0 ? 1 : -1;
  const tOf = (angle: number): number => norm((angle - sa) * dir);

  // Crossings inside the arc's SPAN only (hits on the missing part of the
  // circle don't bound a piece of this arc), deduped by position.
  const seen = new Set<string>();
  const cuts: number[] = [];
  for (const angle of circleCrossingAngles(sketch, target.id, center, r)) {
    const t = tOf(angle);
    if (t <= 1e-12 || t >= spanArc - 1e-12) continue; // at/beyond the ends — no cut
    const hit = { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) };
    const k = posKey(hit);
    if (seen.has(k)) continue;
    seen.add(k);
    cuts.push(t);
  }

  if (cuts.length === 0) {
    removeEntity(sketch, target.id); // trim to nothing, like lines/circles
    return true;
  }
  cuts.sort((p, q) => p - q);

  // Spans along the sweep; the clicked one goes, the others stay as arcs with
  // the SAME centre/radius and construction flag (angles stay continuous).
  const stops = [0, ...cuts, spanArc];
  const spans: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if ((stops[i + 1]! - stops[i]!) * r >= MIN_PIECE) spans.push({ from: stops[i]!, to: stops[i + 1]! });
  }
  const tCut = clamp(tOf(Math.atan2(cutPoint.y - center.y, cutPoint.x - center.x)), 0, spanArc);
  let hit = -1;
  let bestGap = Infinity;
  for (let i = 0; i < spans.length; i++) {
    if (tCut >= spans[i]!.from - 1e-12 && tCut <= spans[i]!.to + 1e-12) { hit = i; break; }
    const gap = tCut < spans[i]!.from ? spans[i]!.from - tCut : tCut - spans[i]!.to;
    if (gap < bestGap) { bestGap = gap; hit = i; }
  }
  if (hit === -1) {
    removeEntity(sketch, target.id);
    return true;
  }

  for (let i = 0; i < spans.length; i++) {
    if (i === hit) continue;
    const start = sa + dir * spans[i]!.from;
    const end = sa + dir * spans[i]!.to;
    const arc = addArc(sketch, center.x, center.y, r, start, end);
    if (target.construction) arc.construction = true;
  }
  removeEntity(sketch, target.id);
  return true;
}

/**
 * Extend `targetId` toward `toward` (Fusion's EXTEND): a line's endpoint
 * nearest the click moves to the nearest crossing of its infinite extension
 * with another non-construction line's segment (the other endpoint stays
 * fixed; a click "behind" the line still extends the nearer endpoint). An
 * arc's nearer end sweeps along its own circle to the first crossing with a
 * line's segment, continuing the arc's sweep direction. Circles are closed —
 * not extendable. True when anything changed.
 */
export function extendSketchEntityTo(sketch: Sketch, targetId: string, toward: Vec2): boolean {
  const target = sketch.entities.get(targetId);
  if (!target) return false;
  if (target.type === 'line') return extendLine(sketch, target, toward);
  if (target.type === 'arc') return extendArc(sketch, target, toward);
  return false; // circles (and points/rectangles) are not extendable
}

function extendLine(sketch: Sketch, target: SketchLine, toward: Vec2): boolean {
  const ends = lineEnds(sketch, target);
  if (!ends) return false;
  const { a, b } = ends;
  const len = dist(a, b);
  if (len < MIN_PIECE) return false;

  // The endpoint nearest the click moves (ties move p2); the other stays fixed.
  const moveB = dist(b, toward) <= dist(a, toward);
  const fixed = moveB ? a : b;
  const moving = moveB ? b : a;
  const d = { x: moving.x - fixed.x, y: moving.y - fixed.y }; // |d| = len

  // Nearest crossing of the extension (beyond `moving`) with a cutter segment.
  let bestS = Infinity;
  let hit: Vec2 | null = null;
  for (const cutter of cutterLines(sketch, target.id)) {
    const ce = lineEnds(sketch, cutter);
    if (!ce) continue;
    // Parameter s along {fixed + s·d}: s ∈ (1, ∞) is past the moving endpoint.
    const dbx = ce.b.x - ce.a.x, dby = ce.b.y - ce.a.y;
    const denom = d.x * dby - d.y * dbx;
    if (Math.abs(denom) < 1e-12) continue; // parallel to the extension
    const wx = ce.a.x - fixed.x, wy = ce.a.y - fixed.y;
    const u = (d.y * wx - d.x * wy) / denom;
    if (u < -T_EPS || u > 1 + T_EPS) continue; // misses the cutter's segment
    const px = ce.a.x + dbx * u, py = ce.a.y + dby * u;
    const s = ((px - fixed.x) * d.x + (py - fixed.y) * d.y) / (len * len);
    if (s > 1 + MIN_PIECE / len && s < bestS) { bestS = s; hit = { x: px, y: py }; }
  }
  if (!hit) return false; // nothing to extend to

  // Move the point itself (shared-vertex convention, like the sketch fillet).
  const pid = moveB ? target.p2Id : target.p1Id;
  const p = sketch.entities.get(pid);
  if (p?.type !== 'point') return false;
  p.x = hit.x;
  p.y = hit.y;
  return true;
}

function extendArc(sketch: Sketch, target: SketchArc, toward: Vec2): boolean {
  const c = sketch.entities.get(target.centerId);
  if (c?.type !== 'point') return false;
  const center = { x: c.x, y: c.y };
  const r = target.radius;
  if (!(r > 0)) return false;
  const sa = target.startAngle, ea = target.endAngle;
  const sweep = ea - sa;
  if (Math.abs(sweep) < 1e-9) return false; // degenerate arc

  // The end nearer the click extends (ties extend the end angle).
  const endPt = { x: center.x + r * Math.cos(ea), y: center.y + r * Math.sin(ea) };
  const startPt = { x: center.x + r * Math.cos(sa), y: center.y + r * Math.sin(sa) };
  const extendEnd = dist(endPt, toward) <= dist(startPt, toward);
  const aE = extendEnd ? ea : sa;
  // An arc only grows along its own sweep: +CCW from the end angle, −CCW (i.e.
  // backwards) from the start angle.
  const dir = (extendEnd ? 1 : -1) * (sweep > 0 ? 1 : -1);
  const spanArc = norm(sweep);

  // First hit on the arc's FULL circle, sweeping from the moving end in `dir`,
  // skipping hits inside the current span (those would shrink the arc).
  let bestDelta = Infinity;
  let bestAngle: number | null = null;
  for (const cutter of cutterLines(sketch, target.id)) {
    const ce = lineEnds(sketch, cutter);
    if (!ce) continue;
    for (const hitPt of segmentCircleHits(ce.a, ce.b, center, r)) {
      const h = Math.atan2(hitPt.y - center.y, hitPt.x - center.x);
      const inSpan = sweep > 0 ? norm(h - sa) : norm(sa - h);
      if (inSpan < spanArc - 1e-9) continue;
      const delta = dir > 0 ? norm(h - aE) : norm(aE - h);
      if (delta <= 1e-9) continue; // hit exactly at the moving end
      if (delta < bestDelta) { bestDelta = delta; bestAngle = aE + dir * delta; }
    }
  }
  if (bestAngle === null) return false;

  if (extendEnd) target.endAngle = bestAngle;
  else target.startAngle = bestAngle;
  return true;
}
