import { describe, it, expect } from 'vitest';
import { mirrorSketchEntities } from './mirror';
import { createSketch, addPoint, addLine, addCircle, addArc, addRectangle } from './engine';
import type { Sketch, SketchArc, SketchPoint } from './types';

// The mirror axis for every test: an ARBITRARY slanted line (slope 3/4,
// direction angle atan2(3,4) ≈ 0.6435 rad) — never axis-aligned, so a
// reflection bug that only mirrors x or y cannot pass these tests.
const A = { x: 1, y: 2 };
const B = { x: 5, y: 5 };

/** Independent reference reflection: foot of the perpendicular, then doubled. */
function reflectRef(p: { x: number; y: number }): { x: number; y: number } {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / (dx * dx + dy * dy);
  const fx = A.x + t * dx;
  const fy = A.y + t * dy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

/** Signed distance to the infinite axis (cross product / axis length):
 * equidistant-and-opposite-sides ⇔ d(image) = −d(original). */
function signedDist(p: { x: number; y: number }): number {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  return ((p.x - A.x) * dy - (p.y - A.y) * dx) / Math.hypot(dx, dy);
}

const TWO_PI = Math.PI * 2;
const norm = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;
/** Is `angle` inside the arc span swept from `start` to `end` (signed sweep)? */
function angleInArc(start: number, end: number, angle: number): boolean {
  const sweep = end - start;
  const span = Math.abs(sweep);
  if (span < 1e-9) return false;
  const d = norm((angle - start) * Math.sign(sweep));
  // d ≈ 2π is "just below the start" — the wrap-around of a tiny float error.
  return d <= span + 1e-6 || d >= TWO_PI - 1e-6;
}

function pointAt(sketch: Sketch, pid: string): SketchPoint {
  const p = sketch.entities.get(pid);
  if (p?.type !== 'point') throw new Error(`missing point ${pid}`);
  return p;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

/** Serialized snapshot of a sketch, for no-mutation-on-refusal assertions. */
function snapshot(sketch: Sketch): string {
  return JSON.stringify(
    [...sketch.entities.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function slantedAxis(sketch: Sketch) {
  return addLine(sketch, A.x, A.y, B.x, B.y);
}

describe('mirrorSketchEntities (reflection about a slanted line)', () => {
  it('reflects a point about the axis, equidistant and on the opposite side', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const p = addPoint(sketch, 0, 0);
    const ids = mirrorSketchEntities(sketch, [p.id], axis.id);
    expect(ids).not.toBeNull();
    const copy = pointAt(sketch, ids![0]!);
    const want = reflectRef({ x: 0, y: 0 });
    expect(copy.x).toBeCloseTo(want.x, 9);
    expect(copy.y).toBeCloseTo(want.y, 9);
    expect(copy.id).not.toBe(p.id); // a copy, not the original

    // Invariance: equal distance from the axis, opposite sides.
    expect(Math.abs(signedDist(copy))).toBeCloseTo(Math.abs(signedDist(p)), 9);
    expect(signedDist(copy)).toBeCloseTo(-signedDist(p), 9);
  });

  it('reflects a line (both endpoints), carrying the construction flag', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const line = addLine(sketch, 0, 1, 2, -1);
    line.construction = true;
    const ids = mirrorSketchEntities(sketch, [line.id], axis.id);
    expect(ids).toHaveLength(1);
    const copy = sketch.entities.get(ids![0]!);
    if (copy?.type !== 'line') throw new Error('expected line');
    expect(copy.construction).toBe(true); // carried
    expect(copy.p1Id).not.toBe(copy.p2Id); // a real line, not collapsed

    // The copy's endpoints are exactly the two reflected endpoints.
    const got = [pointAt(sketch, copy.p1Id), pointAt(sketch, copy.p2Id)];
    for (const w of [reflectRef({ x: 0, y: 1 }), reflectRef({ x: 2, y: -1 })]) {
      expect(got.find((g) => near(g, w)), `image of (${w.x},${w.y})`).toBeDefined();
    }
  });

  it('reflects a circle about its mirrored centre with the same radius', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const circle = addCircle(sketch, 0, 0, 3.5);
    circle.construction = true;
    const ids = mirrorSketchEntities(sketch, [circle.id], axis.id);
    expect(ids).toHaveLength(1);
    const copy = sketch.entities.get(ids![0]!);
    if (copy?.type !== 'circle') throw new Error('expected circle');
    const c = pointAt(sketch, copy.centerId);
    const want = reflectRef({ x: 0, y: 0 });
    expect(c.x).toBeCloseTo(want.x, 9);
    expect(c.y).toBeCloseTo(want.y, 9);
    expect(copy.radius).toBeCloseTo(3.5, 9);
    expect(copy.construction).toBe(true);
  });

  it('mirrors a CCW arc point-for-point (same point set, same sweep sign)', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const arc = addArc(sketch, 2, 1, 4, 0.2, 1.4); // sweep +1.2 (CCW), straddles the axis angle
    const ids = mirrorSketchEntities(sketch, [arc.id], axis.id);
    const copy = sketch.entities.get(ids![0]!);
    if (copy?.type !== 'arc') throw new Error('expected arc');
    const origCenter = pointAt(sketch, arc.centerId);
    const copyCenter = pointAt(sketch, copy.centerId);
    const mc = reflectRef(origCenter);
    expect(copyCenter.x).toBeCloseTo(mc.x, 9);
    expect(copyCenter.y).toBeCloseTo(mc.y, 9);
    expect(copy.radius).toBeCloseTo(4, 9);
    // Sweep magnitude kept, sign kept (the winding convention — see mirror.ts).
    expect(copy.endAngle - copy.startAngle).toBeCloseTo(arc.endAngle - arc.startAngle, 9);

    // Every sampled original point's mirror image lies ON the copy.
    const at = (c: SketchPoint, ang: number) => ({
      x: c.x + 4 * Math.cos(ang),
      y: c.y + 4 * Math.sin(ang),
    });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const phi = arc.startAngle + t * (arc.endAngle - arc.startAngle);
      const ms = reflectRef(at(origCenter, phi));
      const psi = Math.atan2(ms.y - copyCenter.y, ms.x - copyCenter.x);
      expect(Math.hypot(ms.x - copyCenter.x, ms.y - copyCenter.y)).toBeCloseTo(4, 9);
      expect(angleInArc(copy.startAngle, copy.endAngle, psi)).toBe(true);
    }
    // ...and nothing else: the copy's endpoints ARE the images of the
    // original's endpoints (as a set — parameterization direction may swap).
    const copyEnds = [at(copyCenter, copy.startAngle), at(copyCenter, copy.endAngle)];
    for (const w of [reflectRef(at(origCenter, arc.startAngle)), reflectRef(at(origCenter, arc.endAngle))]) {
      expect(copyEnds.find((g) => near(g, w))).toBeDefined();
    }
  });

  it('mirrors a CW arc point-for-point (negative sweep kept negative)', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const arc = addArc(sketch, 2, 1, 4, 1.4, 0.2); // sweep −1.2 (CW)
    const ids = mirrorSketchEntities(sketch, [arc.id], axis.id);
    const copy = sketch.entities.get(ids![0]!) as SketchArc;
    expect(copy.type).toBe('arc');
    expect(copy.endAngle - copy.startAngle).toBeCloseTo(arc.endAngle - arc.startAngle, 9); // −1.2
    expect(copy.endAngle - copy.startAngle).toBeLessThan(0); // winding kept, not flipped
    const origCenter = pointAt(sketch, arc.centerId);
    const copyCenter = pointAt(sketch, copy.centerId);
    for (const t of [0, 0.3, 0.6, 1]) {
      const phi = arc.startAngle + t * (arc.endAngle - arc.startAngle);
      const ms = reflectRef({
        x: origCenter.x + 4 * Math.cos(phi),
        y: origCenter.y + 4 * Math.sin(phi),
      });
      const psi = Math.atan2(ms.y - copyCenter.y, ms.x - copyCenter.x);
      expect(angleInArc(copy.startAngle, copy.endAngle, psi)).toBe(true);
    }
  });

  it('shares junction point ids on a mirrored rectangle (copies re-chain)', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const rect = addRectangle(sketch, -8, 1, -4, 4); // left of the axis, 4 chained lines
    const before = sketch.entities.size;
    const ids = mirrorSketchEntities(sketch, rect.lines.map((l) => l.id), axis.id);
    expect(ids).toHaveLength(4);
    // 4 new junction points + 4 new lines, nothing else.
    expect(sketch.entities.size).toBe(before + 8);

    const cornerIds = new Set(rect.points.map((p) => p.id));
    const newPoints = new Set<string>();
    const useCount = new Map<string, number>();
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') throw new Error('expected line');
      for (const pid of [e.p1Id, e.p2Id]) {
        expect(cornerIds.has(pid)).toBe(false); // fresh ids, not the originals
        newPoints.add(pid);
        useCount.set(pid, (useCount.get(pid) ?? 0) + 1);
      }
    }
    expect(newPoints.size).toBe(4); // one shared point per mirrored corner
    for (const n of useCount.values()) expect(n).toBe(2); // each joins exactly two copy lines

    // Mirrored corners are exact reflections, on the opposite side of the
    // axis at the same distance.
    const images = [...newPoints].map((pid) => pointAt(sketch, pid));
    for (const p of rect.points) {
      const w = reflectRef(p);
      const hit = images.find((q) => near(q, w));
      expect(hit, `image of corner (${p.x},${p.y})`).toBeDefined();
      expect(Math.abs(signedDist(hit!))).toBeCloseTo(Math.abs(signedDist(p)), 9);
      expect(signedDist(hit!)).toBeCloseTo(-signedDist(p), 9);
    }
  });

  it('re-chains freehand segments whose junctions match only by position', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    // Four INDEPENDENT lines forming a rectangle (fresh point per segment —
    // the freehand convention; no shared ids anywhere).
    const l1 = addLine(sketch, 0, 0, 4, 0);
    const l2 = addLine(sketch, 4, 0, 4, 3);
    const l3 = addLine(sketch, 4, 3, 0, 3);
    const l4 = addLine(sketch, 0, 3, 0, 0);
    const before = sketch.entities.size;
    const ids = mirrorSketchEntities(sketch, [l1.id, l2.id, l3.id, l4.id], axis.id);
    expect(ids).toHaveLength(4);
    // 8 original endpoints collapse to 4 shared image junctions + 4 lines.
    expect(sketch.entities.size).toBe(before + 8);
    const useCount = new Map<string, number>();
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') throw new Error('expected line');
      for (const pid of [e.p1Id, e.p2Id]) {
        useCount.set(pid, (useCount.get(pid) ?? 0) + 1);
      }
    }
    expect(useCount.size).toBe(4);
    for (const n of useCount.values()) expect(n).toBe(2);
  });

  it('reuses an existing point when an endpoint lies ON the axis (stitching)', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    // (3, 3.5) is the axis midpoint — its own reflection.
    const line = addLine(sketch, 3, 3.5, 0, 5);
    const ids = mirrorSketchEntities(sketch, [line.id], axis.id);
    const copy = sketch.entities.get(ids![0]!);
    if (copy?.type !== 'line') throw new Error('expected line');
    expect([copy.p1Id, copy.p2Id]).toContain(line.p1Id); // the on-axis end reuses the id
    const other = copy.p1Id === line.p1Id ? copy.p2Id : copy.p1Id;
    const w = reflectRef({ x: 0, y: 5 });
    expect(pointAt(sketch, other).x).toBeCloseTo(w.x, 9);
    expect(pointAt(sketch, other).y).toBeCloseTo(w.y, 9);
    // A half profile against the axis closes: copy and original share a point.
    expect(new Set([copy.p1Id, copy.p2Id, line.p1Id, line.p2Id]).size).toBe(3);
  });

  it('copies a legacy rectangle entity as 4 chained lines between mirrored corners', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const p1 = addPoint(sketch, -8, 1);
    const p2 = addPoint(sketch, -4, 1);
    const p3 = addPoint(sketch, -4, 4);
    const p4 = addPoint(sketch, -8, 4);
    sketch.entities.set('rect_legacy', {
      id: 'rect_legacy',
      type: 'rectangle',
      p1Id: p1.id,
      p2Id: p2.id,
      p3Id: p3.id,
      p4Id: p4.id,
    });
    const ids = mirrorSketchEntities(sketch, ['rect_legacy'], axis.id);
    expect(ids).toHaveLength(4);
    const junctions = new Set<string>();
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') throw new Error('expected line');
      junctions.add(e.p1Id).add(e.p2Id);
    }
    expect(junctions.size).toBe(4);
  });

  it('skips the mirror line itself when it is part of the selection', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const circle = addCircle(sketch, 0, 0, 2);
    const ids = mirrorSketchEntities(sketch, [axis.id, circle.id], axis.id);
    expect(ids).toHaveLength(1); // only the circle copied
    const lines = [...sketch.entities.values()].filter((e) => e.type === 'line');
    expect(lines).toHaveLength(1); // the axis has no duplicate
  });

  it('mirrors a mixed selection and returns every copy id', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const p = addPoint(sketch, -6, 0);
    const line = addLine(sketch, -7, 2, -6, 4);
    const circle = addCircle(sketch, -3, 6, 1.5);
    const arc = addArc(sketch, -2, -1, 2, 0, Math.PI / 2);
    const before = sketch.entities.size;
    const ids = mirrorSketchEntities(sketch, [p.id, line.id, circle.id, arc.id], axis.id);
    expect(ids).toHaveLength(4);
    for (const id of ids!) expect(sketch.entities.has(id)).toBe(true);
    // point + line(2 pts + 1 line) + circle(centre + circle) + arc(centre + arc)
    expect(sketch.entities.size).toBe(before + 8);
  });
});

describe('mirrorSketchEntities (refusals — null, sketch untouched)', () => {
  it('refuses a missing mirror line id', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 1, 1);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [line.id], 'line_nope')).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('refuses a non-line mirror entity', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 1, 1);
    const circle = addCircle(sketch, 5, 5, 2);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [line.id], circle.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('refuses a degenerate (zero-length) axis', () => {
    const sketch = createSketch('xy');
    const degenerate = addLine(sketch, 2, 2, 2, 2);
    const line = addLine(sketch, 0, 0, 1, 1);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [line.id], degenerate.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('refuses an empty selection', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [], axis.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('refuses when every id is unknown (skip-and-continue finds nothing)', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, ['pt_x', 'line_y'], axis.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('refuses when the only selected entity is the axis itself', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [axis.id], axis.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });

  it('skips unknown ids when some are valid, and skips zero-length lines', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const zero = addLine(sketch, 10, 10, 10, 10); // degenerate — would copy to nothing
    const circle = addCircle(sketch, -5, 0, 2);
    const ids = mirrorSketchEntities(sketch, ['pt_unknown', zero.id, circle.id], axis.id);
    expect(ids).toHaveLength(1); // only the circle
    expect(sketch.entities.get(ids![0]!)?.type).toBe('circle');
    // the zero-length line was skipped, not copied (axis + it = 2 lines)
    expect([...sketch.entities.values()].filter((e) => e.type === 'line')).toHaveLength(2);
  });

  it('refuses a lone zero-length line selection without mutating', () => {
    const sketch = createSketch('xy');
    const axis = slantedAxis(sketch);
    const zero = addLine(sketch, 10, 10, 10, 10);
    const snap = snapshot(sketch);
    expect(mirrorSketchEntities(sketch, [zero.id], axis.id)).toBeNull();
    expect(snapshot(sketch)).toBe(snap);
  });
});
