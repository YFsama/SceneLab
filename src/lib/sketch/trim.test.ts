import { describe, it, expect } from 'vitest';
import { trimSketchEntityAt, extendSketchEntityTo } from './trim';
import { createSketch, addLine, addCircle, addArc, addPoint } from './engine';
import type { Sketch } from './types';

type Pt = { x: number; y: number };
type Seg = [number, number][];

const cmpPt = (a: [number, number], b: [number, number]): number => a[0]! - b[0]! || a[1]! - b[1]!;
const cmpSeg = (s: Seg, t: Seg): number =>
  cmpPt(s[0]!, t[0]!) || cmpPt(s[1]!, t[1]!);

/** Endpoint coordinates of every line in the sketch, each segment canonically
 * ordered so orientation never matters to the assertions. */
function segmentsOf(sketch: Sketch): Seg[] {
  const segs: Seg[] = [];
  for (const e of sketch.entities.values()) {
    if (e.type !== 'line') continue;
    const p1 = sketch.entities.get(e.p1Id);
    const p2 = sketch.entities.get(e.p2Id);
    if (p1?.type !== 'point' || p2?.type !== 'point') continue;
    const a: [number, number] = [p1.x, p1.y];
    const b: [number, number] = [p2.x, p2.y];
    segs.push(cmpPt(a, b) <= 0 ? [a, b] : [b, a]);
  }
  return segs.sort(cmpSeg);
}

const lengthOf = (seg: Seg): number =>
  Math.hypot(seg[1]![0] - seg[0]![0], seg[1]![1] - seg[0]![1]);

function lineById(sketch: Sketch, id: string): { a: Pt; b: Pt } | null {
  const e = sketch.entities.get(id);
  if (e?.type !== 'line') return null;
  const p1 = sketch.entities.get(e.p1Id);
  const p2 = sketch.entities.get(e.p2Id);
  if (p1?.type !== 'point' || p2?.type !== 'point') return null;
  return { a: { x: p1.x, y: p1.y }, b: { x: p2.x, y: p2.y } };
}

describe('trimSketchEntityAt (line)', () => {
  it('clicking the middle piece of a doubly-crossed line keeps both end pieces (total = original minus deleted span)', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 3, -5, 3, 5); // crosses at (3,0)
    addLine(sketch, 7, -5, 7, 5); // crosses at (7,0)
    expect(sketch.entities.size).toBe(9); // 3 lines + 6 endpoints

    expect(trimSketchEntityAt(sketch, target.id, { x: 5, y: 0 })).toBe(true);
    expect(sketch.entities.has(target.id)).toBe(false);

    const segs = segmentsOf(sketch);
    expect(segs).toHaveLength(4); // 2 cutters + the 2 kept pieces
    expect(segs[0]).toEqual([[0, 0], [3, 0]]); // kept left piece
    expect(segs[1]).toEqual([[3, -5], [3, 5]]); // cutter
    expect(segs[2]).toEqual([[7, -5], [7, 5]]); // cutter
    expect(segs[3]).toEqual([[7, 0], [10, 0]]); // kept right piece
    // Total kept geometry = original minus the deleted span (3→7).
    const kept = lengthOf(segs[0]!) + lengthOf(segs[3]!);
    expect(kept).toBeCloseTo(6, 9);
    // Cut points became fresh points; the original endpoints survive (shared).
    expect(sketch.entities.size).toBe(12);
  });

  it('clicking an end piece yields one shorter line', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 5, -5, 5, 5);
    expect(trimSketchEntityAt(sketch, target.id, { x: 2, y: 0 })).toBe(true);

    const segs = segmentsOf(sketch);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual([[5, -5], [5, 5]]); // the cutter
    expect(segs[1]).toEqual([[5, 0], [10, 0]]); // the kept piece
    expect(lengthOf(segs[1]!)).toBeCloseTo(5, 9);
  });

  it('a line with no intersections is deleted entirely and its orphaned points cleaned up', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 20, 5, 30, 5); // unrelated
    expect(sketch.entities.size).toBe(6);

    expect(trimSketchEntityAt(sketch, target.id, { x: 4, y: 0 })).toBe(true);
    expect(sketch.entities.has(target.id)).toBe(false);
    expect(sketch.entities.size).toBe(3); // only the unrelated line + its points
    expect(segmentsOf(sketch)).toEqual([[[20, 5], [30, 5]]]);
  });

  it('construction lines are not cutting boundaries', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    const construction = addLine(sketch, 5, -5, 5, 5);
    construction.construction = true;
    expect(trimSketchEntityAt(sketch, target.id, { x: 2, y: 0 })).toBe(true);
    // Nothing non-construction crosses it — trim deletes the whole line.
    expect(sketch.entities.has(target.id)).toBe(false);
    expect(sketch.entities.has(construction.id)).toBe(true);
  });

  it('trims a line that only touches another at an endpoint (whole line goes, Fusion behaviour)', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 0, 0, 0, 8); // touches at target's start point only
    expect(trimSketchEntityAt(sketch, target.id, { x: 6, y: 0 })).toBe(true);
    expect(sketch.entities.has(target.id)).toBe(false);
  });
});

describe('trimSketchEntityAt (circle)', () => {
  it('a circle crossed by a line becomes the arc covering the complement of the clicked span', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 0, 0, 5);
    addLine(sketch, -10, 0, 10, 0); // crosses at angles 0 and π

    // Click the upper semicircle → the lower complement arc π → 2π remains.
    expect(trimSketchEntityAt(sketch, circle.id, { x: 0, y: 5 })).toBe(true);
    const arcs = [...sketch.entities.values()].filter((e) => e.type === 'arc');
    expect(arcs).toHaveLength(1);
    const arc = arcs[0]!;
    expect(arc.type === 'arc' && arc.startAngle).toBeCloseTo(Math.PI, 9);
    expect(arc.type === 'arc' && arc.endAngle).toBeCloseTo(2 * Math.PI, 9);
    expect(arc.type === 'arc' && arc.radius).toBeCloseTo(5, 9);
    expect(sketch.entities.has(circle.id)).toBe(false);
  });

  it('clicking the other side keeps the opposite complement', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 0, 0, 5);
    addLine(sketch, -10, 0, 10, 0);
    expect(trimSketchEntityAt(sketch, circle.id, { x: 0, y: -5 })).toBe(true); // click lower
    const arc = [...sketch.entities.values()].find((e) => e.type === 'arc');
    expect(arc?.type === 'arc' && arc.startAngle).toBeCloseTo(0, 9);
    expect(arc?.type === 'arc' && arc.endAngle).toBeCloseTo(Math.PI, 9);
  });

  it('an uncrossed circle is deleted entirely', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 1, 2, 5);
    expect(sketch.entities.size).toBe(2); // circle + centre
    expect(trimSketchEntityAt(sketch, circle.id, { x: 6, y: 2 })).toBe(true);
    expect(sketch.entities.size).toBe(0); // centre point cleaned up too
  });
});

describe('trimSketchEntityAt (invalid targets)', () => {
  it('returns false for an unknown id without mutating', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    const before = sketch.entities.size;
    expect(trimSketchEntityAt(sketch, 'missing_1', { x: 5, y: 0 })).toBe(false);
    expect(sketch.entities.size).toBe(before);
  });

  it('returns false for a point entity', () => {
    const sketch = createSketch('xy');
    const pt = addPoint(sketch, 3, 4);
    expect(trimSketchEntityAt(sketch, pt.id, { x: 3, y: 4 })).toBe(false);
    expect(sketch.entities.has(pt.id)).toBe(true);
  });
});

describe('extendSketchEntityTo (line)', () => {
  it('extends exactly to the nearest crossing in the toward direction, other endpoint fixed', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 5, 0);
    addLine(sketch, 10, -5, 10, 5); // nearest boundary
    addLine(sketch, 15, -5, 15, 5); // farther boundary

    expect(extendSketchEntityTo(sketch, target.id, { x: 20, y: 0 })).toBe(true);
    const e = lineById(sketch, target.id);
    expect(e).not.toBeNull();
    expect(e!.a.x).toBeCloseTo(0, 9);
    expect(e!.a.y).toBeCloseTo(0, 9);
    expect(e!.b.x).toBeCloseTo(10, 9); // exactly the crossing, not the far one
    expect(e!.b.y).toBeCloseTo(0, 9);
  });

  it('returns false and changes nothing with no reachable intersection', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 5, 0);
    addLine(sketch, 8, 3, 12, 3); // parallel — never meets the extension
    addLine(sketch, -3, -5, -3, 5); // behind the line, opposite to toward
    const before = sketch.entities.size;

    expect(extendSketchEntityTo(sketch, target.id, { x: 20, y: 0 })).toBe(false);
    expect(sketch.entities.size).toBe(before);
    const e = lineById(sketch, target.id);
    expect(e!.a.x).toBeCloseTo(0, 9);
    expect(e!.b.x).toBeCloseTo(5, 9);
  });

  it('toward behind the line still extends the endpoint nearest to the click', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, -5, -5, -5, 5);

    // Click below the middle: (0,0) is the nearest endpoint → it extends left.
    expect(extendSketchEntityTo(sketch, target.id, { x: 2, y: -3 })).toBe(true);
    const e = lineById(sketch, target.id);
    expect(e!.a.x).toBeCloseTo(-5, 9);
    expect(e!.a.y).toBeCloseTo(0, 9);
    expect(e!.b.x).toBeCloseTo(10, 9); // far endpoint untouched
    expect(e!.b.y).toBeCloseTo(0, 9);
  });

  it('ignores construction boundaries', () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 5, 0);
    const construction = addLine(sketch, 10, -5, 10, 5);
    construction.construction = true;
    expect(extendSketchEntityTo(sketch, target.id, { x: 20, y: 0 })).toBe(false);
    const e = lineById(sketch, target.id);
    expect(e!.b.x).toBeCloseTo(5, 9);
  });
});

describe('extendSketchEntityTo (arc)', () => {
  it('extends the end angle to the circle-line hit', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI / 2); // quarter, ends at (0,5)
    addLine(sketch, 0, -10, 0, 10); // crosses the full circle at ±90°

    // Click near the end endpoint → the END angle sweeps CCW to (0,-5).
    expect(extendSketchEntityTo(sketch, arc.id, { x: -1, y: 4 })).toBe(true);
    const e = sketch.entities.get(arc.id);
    expect(e?.type === 'arc' && e.startAngle).toBeCloseTo(0, 9); // unchanged
    expect(e?.type === 'arc' && e.endAngle).toBeCloseTo(1.5 * Math.PI, 9);
  });

  it('extends the start angle when the start endpoint is nearer to toward', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI / 2); // starts at (5,0)
    addLine(sketch, 0, -10, 0, 10);

    // Click near the start endpoint → the START angle sweeps CW to (0,-5).
    expect(extendSketchEntityTo(sketch, arc.id, { x: 4.5, y: 1 })).toBe(true);
    const e = sketch.entities.get(arc.id);
    expect(e?.type === 'arc' && e.startAngle).toBeCloseTo(-Math.PI / 2, 9);
    expect(e?.type === 'arc' && e.endAngle).toBeCloseTo(Math.PI / 2, 9); // unchanged
  });

  it('returns false with no crossing line', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI / 2);
    expect(extendSketchEntityTo(sketch, arc.id, { x: -5, y: 5 })).toBe(false);
    const e = sketch.entities.get(arc.id);
    expect(e?.type === 'arc' && e.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('does not shrink back to a hit inside the current span', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI); // upper half; ends at (-5,0)
    addLine(sketch, -10, 4, 10, 4); // hits the circle INSIDE the span at ~53°,127°

    // Click inside the span near the end — an inward hit must not shorten the arc.
    expect(extendSketchEntityTo(sketch, arc.id, { x: -3, y: 3 })).toBe(false);
    const e = sketch.entities.get(arc.id);
    expect(e?.type === 'arc' && e.startAngle).toBeCloseTo(0, 9);
    expect(e?.type === 'arc' && e.endAngle).toBeCloseTo(Math.PI, 9);
  });
});

describe('extendSketchEntityTo (circle)', () => {
  it('circles are not extendable', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 0, 0, 5);
    addLine(sketch, 10, -10, 10, 10);
    expect(extendSketchEntityTo(sketch, circle.id, { x: 20, y: 0 })).toBe(false);
    expect(sketch.entities.get(circle.id)?.type).toBe('circle');
  });
});

describe('trimSketchEntityAt (arc)', () => {
  /** All arcs in the sketch after a trim, as {center, r, sweep-in-degrees}. */
  function arcsOf(sketch: Sketch): { sweep: number }[] {
    const out: { sweep: number }[] = [];
    for (const e of sketch.entities.values()) {
      if (e.type === 'arc') out.push({ sweep: (e.endAngle - e.startAngle) * (180 / Math.PI) });
    }
    return out.sort((a, b) => a.sweep - b.sweep);
  }

  it('trims an arc crossed by one line: the clicked side goes, the other stays', () => {
    const sketch = createSketch('xz');
    // Semicircle arc over the top: angles 0 → π at r=10 centred at origin.
    const arc = addArc(sketch, 0, 0, 10, 0, Math.PI);
    // Vertical line through x=0 crosses the arc at its apex (0,10)… wait —
    // use x=5: crossings at (5, ±8.66); only the +8.66 one is ON the arc.
    addLine(sketch, 5, -10, 5, 10);
    // Cut on the RIGHT side of the crossing (angle ~30° region).
    expect(trimSketchEntityAt(sketch, arc.id, { x: 8.6, y: 5 })).toBe(true);
    const arcs = arcsOf(sketch);
    expect(arcs).toHaveLength(1);
    // Kept span: from the crossing angle (~60°) to the arc end (180°).
    expect(arcs[0]!.sweep).toBeCloseTo(120, 0);
  });

  it('an uncrossed arc is deleted entirely (trim to nothing)', () => {
    const sketch = createSketch('xz');
    const arc = addArc(sketch, 0, 0, 10, 0, Math.PI / 2);
    expect(trimSketchEntityAt(sketch, arc.id, { x: 10, y: 0 })).toBe(true);
    expect(arcsOf(sketch)).toHaveLength(0);
  });

  it('trims a CW-wound (negative sweep) arc correctly', () => {
    const sketch = createSketch('xz');
    // Semicircle UNDER the origin, wound clockwise: 0 → −π.
    const arc = addArc(sketch, 0, 0, 10, 0, -Math.PI);
    // Crossing line at x = −5 → angle 240° (−120°) is on the arc.
    addLine(sketch, -5, -10, -5, 10);
    // Click deep on the far-left part (angle ~200° sweep-space ≈ 160 of 180).
    expect(trimSketchEntityAt(sketch, arc.id, { x: -9, y: -4 })).toBe(true);
    const arcs = arcsOf(sketch);
    expect(arcs).toHaveLength(1);
    // Kept span: from 0 to the crossing at sweep-space 120° (60°→…). The
    // clicked piece (sweep-space 120→180) is gone; sweep stays negative.
    expect(arcs[0]!.sweep).toBeCloseTo(-120, 0);
  });

  it('carries the construction flag onto the surviving arc', () => {
    const sketch = createSketch('xz');
    const arc = addArc(sketch, 0, 0, 10, 0, Math.PI);
    arc.construction = true;
    addLine(sketch, 5, -10, 5, 10);
    trimSketchEntityAt(sketch, arc.id, { x: 8.6, y: 5 });
    const kept = [...sketch.entities.values()].find((e) => e.type === 'arc');
    expect(kept?.construction).toBe(true);
  });

  it('a doubly-crossed arc keeps BOTH outer pieces (two arcs)', () => {
    const sketch = createSketch('xz');
    // Full-ish arc 0 → π crossed at 60° and 120°: click the middle piece.
    const arc = addArc(sketch, 0, 0, 10, 0, Math.PI);
    addLine(sketch, 5, -10, 5, 10);   // crossing at 60°
    addLine(sketch, -5, -10, -5, 10); // crossing at 120°
    expect(trimSketchEntityAt(sketch, arc.id, { x: 0, y: 10 })).toBe(true);
    const arcs = arcsOf(sketch);
    expect(arcs).toHaveLength(2);
    expect(arcs[0]!.sweep).toBeCloseTo(60, 0);
    expect(arcs[1]!.sweep).toBeCloseTo(60, 0);
  });
});

describe('trimSketchEntityAt (circle, multi-cut)', () => {
  it('a four-crossing circle clicked in one span keeps THREE arcs', () => {
    const sketch = createSketch('xz');
    const circle = addCircle(sketch, 0, 0, 10);
    // Two crossing lines through the circle → 4 crossing points at 45°,135°,
    // 225°, 315° — spans of 90° each.
    addLine(sketch, -20, -20, 20, 20);   // through 45°/225°
    addLine(sketch, -20, 20, 20, -20);   // through 135°/315°
    // Click inside the first-quadrant span (45°..135°): e.g. angle 90°.
    expect(trimSketchEntityAt(sketch, circle.id, { x: 0, y: 10 })).toBe(true);
    const arcs = [...sketch.entities.values()].filter((e) => e.type === 'arc');
    expect(arcs).toHaveLength(3);
    const sweeps = arcs
      .map((a) => (a.type === 'arc' ? a.endAngle - a.startAngle : 0))
      .sort((p, q) => p - q);
    for (const s of sweeps) expect(s).toBeCloseTo(Math.PI / 2, 6);
  });
});
