import { describe, it, expect } from 'vitest';
import { offsetSketchProfile, miterOffsetVertex } from './offset';
import { createSketch, addLine, addLineBetween, addPoint, addCircle, addArc, addRectangle } from './engine';
import type { Sketch } from './types';

/** Build a closed triangle through shared point ids by chaining addLine. */
function triangle(sketch: Sketch, a: [number, number], b: [number, number], c: [number, number]) {
  const l1 = addLine(sketch, a[0], a[1], b[0], b[1]);
  const l2 = addLine(sketch, b[0], b[1], c[0], c[1]);
  const l3 = addLine(sketch, c[0], c[1], a[0], a[1]);
  return [l1, l2, l3];
}

const centroid = (pts: { x: number; y: number }[]) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

describe('offsetSketchProfile (loop/profile offset)', () => {
  it('offsets a circle outward and inward about its centre', () => {
    const sketch = createSketch('xz');
    const circle = addCircle(sketch, 5, 5, 10);
    const out = offsetSketchProfile(sketch, circle.id, 2);
    expect(out).not.toBeNull();
    const grown = sketch.entities.get(out![0]!);
    expect(grown?.type === 'circle' && grown.radius).toBeCloseTo(12, 9);

    const inward = offsetSketchProfile(sketch, circle.id, -3);
    expect(inward).not.toBeNull();
    const shrunk = sketch.entities.get(inward![0]!);
    expect(shrunk?.type === 'circle' && shrunk.radius).toBeCloseTo(7, 9);
  });

  it('refuses a collapsing circle offset without mutating', () => {
    const sketch = createSketch('xz');
    const circle = addCircle(sketch, 0, 0, 2);
    const before = sketch.entities.size;
    expect(offsetSketchProfile(sketch, circle.id, -2.05)).toBeNull();
    expect(sketch.entities.size).toBe(before);
  });

  it('offsets an arc keeping centre and sweep, radius shifted', () => {
    const sketch = createSketch('xz');
    const arc = addArc(sketch, 1, 1, 5, 0, Math.PI / 2);
    const ids = offsetSketchProfile(sketch, arc.id, 1.5);
    expect(ids).not.toBeNull();
    const copy = sketch.entities.get(ids![0]!);
    if (copy?.type !== 'arc') throw new Error('expected arc');
    expect(copy.radius).toBeCloseTo(6.5, 9);
    expect(copy.startAngle).toBeCloseTo(0, 9);
    expect(copy.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('offsets a rectangle (4-line closed loop) into an expanded frame', () => {
    const sketch = createSketch('xz');
    // The rect tool decomposes into 4 chained lines — a closed loop, so the
    // miter path handles it (the legacy rectangle-entity branch also exists
    // for deserialized files).
    const rect = addRectangle(sketch, 0, 0, 10, 6);
    const ids = offsetSketchProfile(sketch, rect.lines[0]!.id, 1);
    expect(ids).not.toBeNull();
    expect(ids).toHaveLength(4);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') continue;
      for (const pid of [e.p1Id, e.p2Id]) {
        const p = sketch.entities.get(pid);
        if (p?.type === 'point') { xs.push(p.x); ys.push(p.y); }
      }
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(8, 6);
  });

  it('offsets a closed CCW line loop outward with mitered corners and preserved edge lengths', () => {
    const sketch = createSketch('xz');
    // CCW right triangle with legs 30/40 → hypotenuse 50 (three freehand
    // lines — fresh points per segment, junctions match by position).
    const l1 = triangle(sketch, [0, 0], [30, 0], [0, 40]);
    const ids = offsetSketchProfile(sketch, l1[0]!.id, 2);
    expect(ids).not.toBeNull();
    expect(ids).toHaveLength(3);

    // The copy shares junction points: taking p1 of each new line (in loop
    // order) yields exactly the n offset vertices.
    const pts: { x: number; y: number }[] = [];
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') continue;
      const p = sketch.entities.get(e.p1Id);
      if (p?.type === 'point') pts.push({ x: p.x, y: p.y });
    }
    expect(pts).toHaveLength(3);
    // Every original corner moved outward: distance from the centroid grew for
    // all three corners (miter displacement ≥ the offset distance).
    const original = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 40 }];
    const co = centroid(original);
    const cn = centroid(pts);
    for (const o of original) {
      const nearest = Math.min(...pts.map((p) => Math.hypot(p.x - (o.x + (cn.x - co.x)), p.y - (o.y + (cn.y - co.y)))));
      expect(nearest).toBeGreaterThanOrEqual(2 - 1e-6);
    }
    // Every edge GROWS on an outward miter offset (corner extensions
    // d·tan((180−θ)/2), clamped by the spike guard at acute corners).
    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const lengths = pts.map((p, i) => dist2(p, pts[(i + 1) % pts.length]!)).sort((a, b) => a - b);
    expect(lengths[0]).toBeGreaterThan(30);
    expect(lengths[1]).toBeGreaterThan(40);
    expect(lengths[2]).toBeGreaterThan(50);
    // Each new edge stays near-parallel to an original edge at ~|d|
    // perpendicular distance. Acute corners are spike-clamped, which pulls
    // their miter points slightly along the offset line — so parallelism and
    // distance hold exactly only at unclamped corners; assert a tight band.
    for (let i = 0; i < 3; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 3]!;
      const dir = { x: b.x - a.x, y: b.y - a.y };
      let best: { angle: number; perp: number } | null = null;
      for (let j = 0; j < 3; j++) {
        const c = original[j]!;
        const e = original[(j + 1) % 3]!;
        const oDir = { x: e.x - c.x, y: e.y - c.y };
        const cross = dir.x * oDir.y - dir.y * oDir.x;
        const dotp = dir.x * oDir.x + dir.y * oDir.y;
        const angle = Math.abs(Math.atan2(cross, dotp));
        const perp = Math.abs(dir.x * (c.y - a.y) - dir.y * (c.x - a.x)) / dist2(a, b);
        if (!best || angle < best.angle) best = { angle, perp };
      }
      expect(best!.angle).toBeLessThan((3 * Math.PI) / 180); // < 3°
      expect(best!.perp).toBeGreaterThan(1.5);
      expect(best!.perp).toBeLessThanOrEqual(2.000001);
    }
  });

  it('positive distance is outward for CW-wound loops too', () => {
    const sketch = createSketch('xz');
    // CW triangle (reversed vertex order).
    const l1 = triangle(sketch, [0, 0], [0, 40], [30, 0]);
    const ids = offsetSketchProfile(sketch, l1[0]!.id, 2);
    expect(ids).not.toBeNull();
    // The offset triangle's bounding box grows by the offset on every side.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') continue;
      for (const pid of [e.p1Id, e.p2Id]) {
        const p = sketch.entities.get(pid);
        if (p?.type === 'point') { xs.push(p.x); ys.push(p.y); }
      }
    }
    expect(Math.min(...xs)).toBeLessThan(-1.9);
    expect(Math.max(...xs)).toBeGreaterThan(31.9);
    expect(Math.max(...ys)).toBeGreaterThan(41.9);
    expect(Math.min(...ys)).toBeLessThan(-1.9);
  });

  it('rejects an inward offset past the inradius (collapse) without mutating', () => {
    const sketch = createSketch('xz');
    const l1 = triangle(sketch, [0, 0], [30, 0], [0, 40]);
    const before = sketch.entities.size;
    // The inradius of the 30-40-50 triangle is 10 — offsetting 15 inward must
    // invert/collapse the profile, which the engine refuses.
    expect(offsetSketchProfile(sketch, l1[0]!.id, -15)).toBeNull();
    expect(sketch.entities.size).toBe(before);
  });

  it('rejects an open chain (single line not in a closed loop)', () => {
    const sketch = createSketch('xz');
    const line = addLine(sketch, 0, 0, 10, 10);
    expect(offsetSketchProfile(sketch, line.id, 2)).toBeNull();
  });

  it('rejects zero/NaN distances and unknown ids', () => {
    const sketch = createSketch('xz');
    const line = addLine(sketch, 0, 0, 10, 10);
    expect(offsetSketchProfile(sketch, line.id, 0)).toBeNull();
    expect(offsetSketchProfile(sketch, line.id, Number.NaN)).toBeNull();
    expect(offsetSketchProfile(sketch, 'nope', 2)).toBeNull();
  });
});

describe('miterOffsetVertex', () => {
  it('moves a right-angle corner along the 45° bisector by distance·√2', () => {
    // Walk (-1,0) → (0,0) → (0,1): a left (CCW) turn, so outward is the RIGHT
    // side — bisector direction (1,-1)/√2, scaled by √2 for the 90° corner.
    const v = miterOffsetVertex({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, 2, true);
    expect(v.x).toBeCloseTo(2, 6);
    expect(v.y).toBeCloseTo(-2, 6);
  });

  it('clamps near-degenerate reversals instead of spiking', () => {
    // Edges reversing ~180°: the bisector nearly vanishes; the miter scale is
    // clamped by MITER_DOT_FLOOR (0.35) → max displacement = d / 0.35.
    const v = miterOffsetVertex({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0.0001 }, 2, true);
    const dist = Math.hypot(v.x - 1, v.y - 0);
    expect(dist).toBeLessThanOrEqual(2 / 0.35 + 1e-9);
  });

  it('moves a collinear (180°) vertex by exactly the distance', () => {
    const v = miterOffsetVertex({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, 3, true);
    expect(v.x).toBeCloseTo(1, 9);
    expect(v.y).toBeCloseTo(-3, 9);
  });
});

describe('offsetSketchProfile — exact miter geometry (shared-id loops)', () => {
  /** Equilateral triangle as a shared-id line loop, centroid (0,0), R = 6. */
  function equilateralLoop(sketch: Sketch, ccw: boolean): string[] {
    const R = 6;
    const pts = [
      { x: 0, y: R },
      { x: (-R * Math.sqrt(3)) / 2, y: -R / 2 },
      { x: (R * Math.sqrt(3)) / 2, y: -R / 2 },
    ];
    const ordered = ccw ? pts : [pts[0]!, pts[2]!, pts[1]!];
    const pids = ordered.map((p) => addPoint(sketch, p.x, p.y).id);
    return pids.map((pid, i) => addLineBetween(sketch, pid, pids[(i + 1) % pids.length]!).id);
  }

  /** The copy's vertex positions: p1 of each new line, in loop (creation) order. */
  function copyVertices(sketch: Sketch, originalIds: string[]): { x: number; y: number }[] {
    const newLines = [...sketch.entities.values()].filter(
      (e) => e.type === 'line' && !originalIds.includes(e.id),
    );
    return newLines.map((l) => {
      const p = sketch.entities.get((l as { p1Id: string }).p1Id);
      return p?.type === 'point' ? { x: p.x, y: p.y } : { x: 0, y: 0 };
    });
  }

  it('CCW equilateral +2: every vertex lands on circumradius R + d/sin(30°) = 10', () => {
    const sketch = createSketch('xy');
    const ids = equilateralLoop(sketch, true);
    expect(offsetSketchProfile(sketch, ids[0]!, 2)).not.toBeNull();
    const verts = copyVertices(sketch, ids);
    expect(verts).toHaveLength(3);
    for (const v of verts) expect(Math.hypot(v.x, v.y)).toBeCloseTo(10, 6); // grew from 6
    // The original loop is untouched: its junction points still sit at R = 6.
    for (const pid of ids.flatMap((id) => {
      const l = sketch.entities.get(id);
      return l?.type === 'line' ? [l.p1Id] : [];
    })) {
      const p = sketch.entities.get(pid);
      if (p?.type === 'point') expect(Math.hypot(p.x, p.y)).toBeCloseTo(6, 6);
    }
  });

  it('CW equilateral +2: sign flips, positive still lands OUTWARD at 10', () => {
    const sketch = createSketch('xy');
    const ids = equilateralLoop(sketch, false);
    expect(offsetSketchProfile(sketch, ids[1]!, 2)).not.toBeNull();
    for (const v of copyVertices(sketch, ids)) {
      // A wrong sign would shrink to circumradius 2 instead of growing to 10.
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(10, 6);
    }
  });

  it('rejects inward offsets at/past the inradius (collapse) with no mutation', () => {
    const sketch = createSketch('xy');
    const ids = equilateralLoop(sketch, true);
    const before = sketch.entities.size;
    const keys = [...sketch.entities.keys()];
    expect(offsetSketchProfile(sketch, ids[0]!, -3)).toBeNull(); // = inradius: edges → 0
    expect(offsetSketchProfile(sketch, ids[0]!, -6)).toBeNull(); // inverts the profile
    expect(sketch.entities.size).toBe(before);
    expect([...sketch.entities.keys()]).toEqual(keys);
  });
});

describe('offsetSketchProfile — rectangle entities', () => {
  function addRectEntity(sketch: Sketch, x1: number, y1: number, x2: number, y2: number): string {
    const p1 = addPoint(sketch, x1, y1);
    const p2 = addPoint(sketch, x2, y1);
    const p3 = addPoint(sketch, x2, y2);
    const p4 = addPoint(sketch, x1, y2);
    const rect = {
      id: `rect_entity_${sketch.entities.size}`,
      type: 'rectangle' as const,
      p1Id: p1.id,
      p2Id: p2.id,
      p3Id: p3.id,
      p4Id: p4.id,
    };
    sketch.entities.set(rect.id, rect);
    return rect.id;
  }

  it('expands a rectangle entity by the distance on all four sides', () => {
    const sketch = createSketch('xy');
    const rect = addRectEntity(sketch, 0, 0, 10, 6);
    const lineIdsBefore = new Set(
      [...sketch.entities.values()].filter((e) => e.type === 'line').map((e) => e.id),
    );
    const ids = offsetSketchProfile(sketch, rect, 2);
    expect(ids).not.toBeNull();
    expect(ids).toHaveLength(4); // the copy decomposes into 4 lines, like addSketchRect
    const xs: number[] = [];
    const ys: number[] = [];
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') continue;
      for (const pid of [e.p1Id, e.p2Id]) {
        const p = sketch.entities.get(pid);
        if (p?.type === 'point') { xs.push(p.x); ys.push(p.y); }
      }
    }
    expect(Math.min(...xs)).toBeCloseTo(-2, 9); // w+2d = 14, h+2d = 10, same centre
    expect(Math.max(...xs)).toBeCloseTo(12, 9);
    expect(Math.min(...ys)).toBeCloseTo(-2, 9);
    expect(Math.max(...ys)).toBeCloseTo(8, 9);
    // The original rectangle entity survives untouched.
    expect(sketch.entities.get(rect)?.type).toBe('rectangle');
    expect(lineIdsBefore.size).toBe(0);
  });

  it('shrinks a rectangle entity inward', () => {
    const sketch = createSketch('xy');
    const rect = addRectEntity(sketch, 0, 0, 10, 6);
    const ids = offsetSketchProfile(sketch, rect, -2);
    expect(ids).not.toBeNull();
    const xs: number[] = [];
    const ys: number[] = [];
    for (const id of ids!) {
      const e = sketch.entities.get(id);
      if (e?.type !== 'line') continue;
      for (const pid of [e.p1Id, e.p2Id]) {
        const p = sketch.entities.get(pid);
        if (p?.type === 'point') { xs.push(p.x); ys.push(p.y); }
      }
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6, 9); // 10 - 2·2
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 9); // 6 - 2·2
  });

  it('rejects a rectangle entity offset whose new side would collapse', () => {
    const sketch = createSketch('xy');
    const rect = addRectEntity(sketch, 0, 0, 10, 6);
    const before = sketch.entities.size;
    expect(offsetSketchProfile(sketch, rect, -3)).toBeNull(); // height 6 - 6 = 0
    expect(offsetSketchProfile(sketch, rect, -5)).toBeNull(); // negative sides
    expect(sketch.entities.size).toBe(before);
  });
});
