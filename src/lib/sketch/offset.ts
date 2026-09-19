// Sketch Offset (Fusion 360 / SolidWorks "offset entity" parity): create an
// equidistant COPY of a sketch entity — circles/arcs grow or shrink about their
// centre, rectangles expand about their centre, and a line offsets its whole
// closed loop with mitered corners. The original stays; new entities are added.
import type { Sketch, SketchLine, Vec2 } from './types';
import { addPoint, addLineBetween, addCircle, addArc, addRectangle } from './engine';

/** Reject meaningless distances (0 would just duplicate the geometry). */
const MIN_DISTANCE = 1e-9;
/** A circle/arc copy must keep at least this radius (mm). */
const MIN_RADIUS = 0.05;
/** A rectangle copy must keep at least this side length (mm). */
const MIN_RECT_SIDE = 0.1;
/** A loop copy must keep at least this edge length (mm). */
const MIN_EDGE = 0.01;
/** Miter scale clamp: cos(half-angle) floor ≈ 2.83× max spike (common CAD). */
const MITER_DOT_FLOOR = 0.35;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Unit vector a→b; null when the two points coincide. */
function unitBetween(a: Vec2, b: Vec2): Vec2 | null {
  const d = sub(b, a);
  const l = len(d);
  return l < 1e-12 ? null : { x: d.x / l, y: d.y / l };
}

/**
 * Miter offset of one loop vertex: move `v` along the bisector of its interior
 * angle so both adjacent edge offsets meet exactly (a mitered corner).
 * `prev`/`next` are the neighbouring loop vertices in walk order; `distance`
 * is positive toward the loop's outside for a CCW walk (`ccw` = loop winding).
 * Spike length is clamped to ~2.83× the distance (MITER_DOT_FLOOR), the usual
 * CAD guard against near-180° reversal corners.
 */
export function miterOffsetVertex(prev: Vec2, v: Vec2, next: Vec2, distance: number, ccw: boolean): Vec2 {
  const d1 = unitBetween(prev, v);
  const d2 = unitBetween(v, next);
  // Outward normal of an edge direction: right normal for CCW walks, left for CW.
  const outward = (d: Vec2): Vec2 => (ccw ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x });
  if (!d1 || !d2) return { x: v.x, y: v.y };
  const o1 = outward(d1);
  const o2 = outward(d2);
  const m = { x: o1.x + o2.x, y: o1.y + o2.y };
  const ml = len(m);
  if (ml < 1e-9) {
    // Degenerate spike (edges reverse ~180°): offset along the incoming normal.
    return { x: v.x + o1.x * distance, y: v.y + o1.y * distance };
  }
  const n = { x: m.x / ml, y: m.y / ml };
  const scale = distance / Math.max(MITER_DOT_FLOOR, dot(n, o1));
  return { x: v.x + n.x * scale, y: v.y + n.y * scale };
}

/** Signed shoelace area of a closed polygon given in walk order. */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Winding-independent point-in-polygon (ray cast, boundary counts as in). */
function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    if (
      ((b.y > pt.y) !== (a.y > pt.y)) &&
      pt.x <= ((a.x - b.x) * (pt.y - b.y)) / (a.y - b.y) + b.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

interface ClosedLoop {
  /** Vertex positions in walk order (consistent winding along the chain). */
  vertices: Vec2[];
}

/**
 * Walk the closed chain of line entities containing `startLine`. Junctions
 * match by POSITION (6-decimal coordinate key), not by shared point ids: the
 * freehand line tool creates fresh points per segment, so a hand-drawn
 * triangle never shares ids — Fusion offsets those too. Every loop junction
 * must join exactly two lines — an open chain or a three-way branch is not a
 * clean profile and returns null.
 */
function findClosedLoop(sketch: Sketch, startLine: SketchLine): ClosedLoop | null {
  const posOf = (pid: string): Vec2 | null => {
    const p = sketch.entities.get(pid);
    return p?.type === 'point' ? { x: p.x, y: p.y } : null;
  };
  const keyOf = (pid: string): string => {
    const p = posOf(pid);
    return p ? `${p.x.toFixed(6)},${p.y.toFixed(6)}` : pid;
  };

  // Adjacency: position key → the lines with an end at that position.
  const adj = new Map<string, SketchLine[]>();
  for (const ent of sketch.entities.values()) {
    if (ent.type !== 'line') continue;
    for (const pid of [ent.p1Id, ent.p2Id]) {
      const k = keyOf(pid);
      const list = adj.get(k);
      if (list) list.push(ent);
      else adj.set(k, [ent]);
    }
  }

  const otherEnd = (l: SketchLine, key: string): string =>
    keyOf(l.p1Id) === key ? l.p2Id : l.p1Id;
  const endAt = (l: SketchLine, key: string): string =>
    keyOf(l.p1Id) === key ? l.p1Id : l.p2Id;

  const startKey = keyOf(startLine.p1Id);
  let currentKey = keyOf(startLine.p2Id);
  let lastLine: SketchLine = startLine;
  const vertexIds = [startLine.p1Id]; // a point id at the start junction
  const junctionKeys = [startKey];

  // Walk at most every line once; a clean loop closes well before that.
  const maxSteps = sketch.entities.size + 2;
  for (let step = 0; step < maxSteps && currentKey !== startKey; step++) {
    const junction = adj.get(currentKey) ?? [];
    const next = junction.find((l) => l.id !== lastLine.id);
    if (!next) return null; // open chain end (or junction only loops back on itself)
    vertexIds.push(endAt(lastLine, currentKey)); // a point id AT this junction
    junctionKeys.push(currentKey);
    lastLine = next;
    currentKey = keyOf(otherEnd(next, currentKey));
  }
  if (currentKey !== startKey || vertexIds.length < 3) return null;

  // Every junction of the finished loop (including the start) must be a clean
  // two-line join — a dangling branch attached anywhere makes the profile
  // ambiguous.
  for (const k of junctionKeys) {
    if ((adj.get(k) ?? []).length !== 2) return null;
  }

  const vertices: Vec2[] = [];
  for (const pid of vertexIds) {
    const p = posOf(pid);
    if (!p) return null;
    vertices.push(p);
  }
  return { vertices };
}

/** Offset a closed line loop by `distance` (positive = outward). */
function offsetLoop(sketch: Sketch, startLine: SketchLine, distance: number): string[] | null {
  const loop = findClosedLoop(sketch, startLine);
  if (!loop) return null;
  const v = loop.vertices;
  const area = signedArea(v);
  if (Math.abs(area) < 1e-9) return null; // degenerate (collinear) loop
  const ccw = area > 0;
  // miterOffsetVertex's normals are winding-aware (outward for the loop's own
  // winding), so the sign of `distance` alone picks in/out — no extra flip.

  const n = v.length;
  const newVerts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    newVerts.push(miterOffsetVertex(v[(i - 1 + n) % n]!, v[i]!, v[(i + 1) % n]!, distance, ccw));
  }

  // Validate BEFORE mutating: every new edge must survive, the loop must keep
  // its orientation, and — the real CAD guard — every offset vertex must land
  // on the correct side of the original polygon (outward offsets outside,
  // inward inside). An inward offset past the inradius spikes acute corners
  // across to the far side WITHOUT necessarily flipping the shoelace sign, so
  // the side test is what actually catches the self-intersection.
  for (let i = 0; i < n; i++) {
    if (len(sub(newVerts[(i + 1) % n]!, newVerts[i]!)) <= MIN_EDGE) return null;
  }
  const newArea = signedArea(newVerts);
  if (Math.abs(newArea) < 1e-9 || Math.sign(newArea) !== Math.sign(area)) return null;
  for (const nv of newVerts) {
    if (pointInPolygon(nv, v) === (distance > 0)) return null;
  }

  // Junction points are created ONCE and shared by the connecting lines —
  // the same structure the rectangle tool builds, so the copy chains into
  // profiles and re-offsets cleanly.
  const junctionIds: string[] = [];
  for (const p of newVerts) junctionIds.push(addPoint(sketch, p.x, p.y).id);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(addLineBetween(sketch, junctionIds[i]!, junctionIds[(i + 1) % n]!).id);
  }
  return ids;
}

/**
 * Offset (equidistant copy) of a sketch entity — Fusion's sketch Offset.
 * Circles/arcs offset about their centre (start/end angles kept), rectangles
 * expand about their centre (w+2d, h+2d), and a line offsets its whole closed
 * loop with mitered corners. Positive distance = outward/larger, negative =
 * inward/smaller. Returns the new entity ids, or null (no mutation) when the
 * entity isn't offsetable or the copy would collapse.
 */
export function offsetSketchProfile(sketch: Sketch, entityId: string, distance: number): string[] | null {
  if (!Number.isFinite(distance) || Math.abs(distance) < MIN_DISTANCE) return null;
  const e = sketch.entities.get(entityId);
  if (!e) return null;

  if (e.type === 'line') {
    return offsetLoop(sketch, e, distance);
  }

  if (e.type === 'circle' || e.type === 'arc') {
    const c = sketch.entities.get(e.centerId);
    if (c?.type !== 'point') return null;
    const r = e.radius + distance;
    if (!(r > MIN_RADIUS)) return null;
    return [
      e.type === 'circle'
        ? addCircle(sketch, c.x, c.y, r).id
        : addArc(sketch, c.x, c.y, r, e.startAngle, e.endAngle).id,
    ];
  }

  if (e.type === 'rectangle') {
    const pts: Vec2[] = [];
    for (const pid of [e.p1Id, e.p2Id, e.p3Id, e.p4Id]) {
      const p = sketch.entities.get(pid);
      if (p?.type !== 'point') return null; // missing corner
      pts.push({ x: p.x, y: p.y });
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX + 2 * distance;
    const h = maxY - minY + 2 * distance;
    if (!(w > MIN_RECT_SIDE) || !(h > MIN_RECT_SIDE)) return null;
    const { lines } = addRectangle(sketch, minX - distance, minY - distance, maxX + distance, maxY + distance);
    return lines.map((l) => l.id);
  }

  return null;
}

/** Boolean convenience wrapper around {@link offsetSketchProfile}. */
export function offsetSketchEntity(sketch: Sketch, entityId: string, distance: number): boolean {
  return offsetSketchProfile(sketch, entityId, distance) !== null;
}
