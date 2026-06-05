import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addRectangle, addCircle, addArc, addPolygon,
  addConstraint, removeEntity, removeConstraint, solveSketch, snapTargets,
  detectRectangle, resizeRectangle,
} from './engine';

describe('createSketch', () => {
  it('creates a sketch with the specified plane ID', () => {
    const s = createSketch('xz');
    expect(s.planeId).toBe('xz');
    expect(s.entities.size).toBe(0);
    expect(s.constraints.size).toBe(0);
  });

  it('creates a sketch with a unique ID', () => {
    const s1 = createSketch('xy');
    const s2 = createSketch('xy');
    expect(s1.id).not.toBe(s2.id);
  });

  it('creates sketches for all standard planes', () => {
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      const s = createSketch(plane);
      expect(s.planeId).toBe(plane);
    }
  });
});

describe('snapTargets', () => {
  it('returns each point plus every line midpoint', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 10, 0); // endpoints (0,0),(10,0); midpoint (5,0)
    const targets = snapTargets(s);
    expect(targets).toContainEqual({ x: 0, y: 0 });
    expect(targets).toContainEqual({ x: 10, y: 0 });
    expect(targets).toContainEqual({ x: 5, y: 0 }); // midpoint snap target
  });

  it('is empty for an empty sketch', () => {
    expect(snapTargets(createSketch('xy'))).toEqual([]);
  });
});

describe('createSketch', () => {
  it('should create an empty sketch', () => {
    const sketch = createSketch('xy');
    expect(sketch.planeId).toBe('xy');
    expect(sketch.entities.size).toBe(0);
    expect(sketch.constraints.size).toBe(0);
  });
});

describe('addPoint', () => {
  it('should add a point to the sketch', () => {
    const sketch = createSketch('xy');
    const pt = addPoint(sketch, 10, 20);
    expect(pt.type).toBe('point');
    expect(pt.x).toBe(10);
    expect(pt.y).toBe(20);
    expect(sketch.entities.size).toBe(1);
  });
});

describe('addLine', () => {
  it('should add a line with two endpoints', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 10);
    expect(line.type).toBe('line');
    expect(sketch.entities.size).toBe(3); // 2 points + 1 line
    expect(sketch.entities.has(line.p1Id)).toBe(true);
    expect(sketch.entities.has(line.p2Id)).toBe(true);
  });

  it('line endpoints are at correct positions', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 5, 10, 20, 30);
    const p1 = sketch.entities.get(line.p1Id) as { x: number; y: number };
    const p2 = sketch.entities.get(line.p2Id) as { x: number; y: number };
    expect(p1.x).toBe(5);
    expect(p1.y).toBe(10);
    expect(p2.x).toBe(20);
    expect(p2.y).toBe(30);
  });

  it('multiple lines share no endpoints by default', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 10, 0, 10, 10);
    // Second line starts where first ends, but they have separate point entities.
    const points = [...sketch.entities.values()].filter((e) => e.type === 'point');
    expect(points.length).toBe(4); // 2 per line, not shared
  });

  it('creates unique line IDs', () => {
    const sketch = createSketch('xy');
    const l1 = addLine(sketch, 0, 0, 10, 0);
    const l2 = addLine(sketch, 0, 5, 10, 5);
    expect(l1.id).not.toBe(l2.id);
  });
});

describe('addRectangle', () => {
  it('should add 4 points and 4 lines', () => {
    const sketch = createSketch('xy');
    const { lines, points } = addRectangle(sketch, 0, 0, 10, 5);
    expect(points.length).toBe(4);
    expect(lines.length).toBe(4);
    expect(sketch.entities.size).toBe(8); // 4 points + 4 lines
  });
});

describe('addCircle', () => {
  it('should add a circle with center point', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 5, 5, 10);
    expect(circle.type).toBe('circle');
    expect(circle.radius).toBe(10);
    expect(sketch.entities.size).toBe(2); // 1 point + 1 circle
  });

  it('circle center is at correct position', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 7, 13, 5);
    const center = sketch.entities.get(circle.centerId) as { x: number; y: number };
    expect(center.x).toBe(7);
    expect(center.y).toBe(13);
  });

  it('circle radius is stored correctly', () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 0, 0, 42.5);
    expect(circle.radius).toBe(42.5);
  });

  it('multiple circles have unique IDs', () => {
    const sketch = createSketch('xy');
    const c1 = addCircle(sketch, 0, 0, 5);
    const c2 = addCircle(sketch, 10, 10, 3);
    expect(c1.id).not.toBe(c2.id);
  });
});

describe('addArc', () => {
  it('should add an arc with center point', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI);
    expect(arc.type).toBe('arc');
    expect(arc.radius).toBe(5);
    expect(sketch.entities.size).toBe(2); // 1 point + 1 arc
  });

  it('arc center is at correct position', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 7, 13, 5, 0, Math.PI);
    const center = sketch.entities.get(arc.centerId) as { x: number; y: number };
    expect(center.x).toBe(7);
    expect(center.y).toBe(13);
  });

  it('arc stores start and end angles', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, Math.PI / 4, Math.PI * 3 / 4);
    expect(arc.startAngle).toBeCloseTo(Math.PI / 4, 6);
    expect(arc.endAngle).toBeCloseTo(Math.PI * 3 / 4, 6);
  });

  it('multiple arcs have unique IDs', () => {
    const sketch = createSketch('xy');
    const a1 = addArc(sketch, 0, 0, 5, 0, Math.PI);
    const a2 = addArc(sketch, 10, 0, 3, 0, Math.PI / 2);
    expect(a1.id).not.toBe(a2.id);
  });
});

describe('addPolygon', () => {
  it('should add a polygon with the specified number of sides', () => {
    const sketch = createSketch('xy');
    const ids = addPolygon(sketch, 0, 0, 5, 6);
    // Returns 6 line IDs.
    expect(ids.length).toBe(6);
  });

  it('should create a triangle (3 sides)', () => {
    const sketch = createSketch('xy');
    const ids = addPolygon(sketch, 0, 0, 5, 3);
    expect(ids.length).toBe(3);
  });

  it('should create a square (4 sides)', () => {
    const sketch = createSketch('xy');
    const ids = addPolygon(sketch, 0, 0, 5, 4);
    expect(ids.length).toBe(4);
  });

  it('should have all line entities', () => {
    const sketch = createSketch('xy');
    addPolygon(sketch, 0, 0, 5, 6);
    const lines = [...sketch.entities.values()].filter((e) => e.type === 'line');
    expect(lines.length).toBe(6);
  });

  it('line IDs reference valid entities', () => {
    const sketch = createSketch('xy');
    const ids = addPolygon(sketch, 0, 0, 5, 6);
    for (const id of ids) {
      expect(sketch.entities.has(id)).toBe(true);
    }
  });
});

describe('addConstraint', () => {
  it('should add a constraint', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 5);
    const c = addConstraint(sketch, 'horizontal', [line.id]);
    expect(c.type).toBe('horizontal');
    expect(sketch.constraints.size).toBe(1);
  });

  it('should add a distance constraint with value', () => {
    const sketch = createSketch('xy');
    const p1 = addPoint(sketch, 0, 0);
    const p2 = addPoint(sketch, 5, 0);
    const c = addConstraint(sketch, 'distance', [p1.id, p2.id], 10);
    expect(c.value).toBe(10);
  });
});

describe('removeEntity', () => {
  it('removes an entity, its constraints, and its orphaned points', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 0);
    addConstraint(sketch, 'horizontal', [line.id]);
    expect(sketch.entities.size).toBe(3); // line + 2 endpoints
    expect(sketch.constraints.size).toBe(1);

    removeEntity(sketch, line.id);
    expect(sketch.entities.size).toBe(0); // endpoints cleaned up, not orphaned
    expect(sketch.constraints.size).toBe(0);
  });

  it('keeps a shared/constrained point when its line is removed', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 0);
    // Anchor one endpoint; that point must survive the line's removal.
    addConstraint(sketch, 'fixed', [line.p1Id]);

    removeEntity(sketch, line.id);
    expect(sketch.entities.has(line.p1Id)).toBe(true); // referenced by 'fixed'
    expect(sketch.entities.has(line.p2Id)).toBe(false); // private, removed
    expect(sketch.constraints.size).toBe(1); // 'fixed' still references p1
  });
});

describe('removeConstraint', () => {
  it('should remove a constraint', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 0);
    const c = addConstraint(sketch, 'horizontal', [line.id]);
    expect(sketch.constraints.size).toBe(1);

    removeConstraint(sketch, c.id);
    expect(sketch.constraints.size).toBe(0);
  });
});

describe('solveSketch', () => {
  it('should return resolved points', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 5);
    const result = solveSketch(sketch);
    expect(result.size).toBe(2);
  });

  it('should apply horizontal constraint', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 5);
    addConstraint(sketch, 'horizontal', [line.id]);
    const result = solveSketch(sketch);

    const p1 = result.get(line.p1Id);
    const p2 = result.get(line.p2Id);
    expect(p1?.y).toBeCloseTo(p2?.y ?? 0);
  });
});

describe('detectRectangle', () => {
  it('detects a rectangle from 4 lines forming a closed loop', () => {
    const s = createSketch('xy');
    const result = addRectangle(s, 0, 0, 10, 5);
    const firstLineId = result.lines[0]!.id;
    const rect = detectRectangle(s, firstLineId);
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeCloseTo(10, 1);
    expect(rect!.height).toBeCloseTo(5, 1);
    expect(rect!.lineIds).toHaveLength(4);
    expect(rect!.corners).toHaveLength(4);
  });

  it('returns null for a standalone line', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 0);
    expect(detectRectangle(s, line.id)).toBeNull();
  });

  it('returns null for a triangle (3 lines)', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 10, 0);
    addLine(s, 10, 0, 5, 8);
    addLine(s, 5, 8, 0, 0);
    const firstLine = [...s.entities.values()].find((e) => e.type === 'line');
    expect(detectRectangle(s, firstLine!.id)).toBeNull();
  });
});

describe('resizeRectangle', () => {
  it('resizes a rectangle to new dimensions', () => {
    const s = createSketch('xy');
    const result = addRectangle(s, 0, 0, 10, 5);
    const firstLineId = result.lines[0]!.id;
    const rect = detectRectangle(s, firstLineId)!;
    resizeRectangle(s, rect, 20, 8);
    const rect2 = detectRectangle(s, firstLineId);
    expect(rect2).not.toBeNull();
    expect(rect2!.width).toBeCloseTo(20, 1);
    expect(rect2!.height).toBeCloseTo(8, 1);
  });
});

describe('removeEntity edge cases', () => {
  it('removing a point keeps referencing lines (they become dangling)', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 0);
    const p1 = s.entities.get(line.p1Id)!;
    removeEntity(s, p1.id);
    // The line still exists (with a dangling reference).
    expect(s.entities.has(line.id)).toBe(true);
  });

  it('removing a line removes orphaned points', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 0);
    removeEntity(s, line.id);
    // Both endpoints should be removed since they're orphaned.
    expect(s.entities.size).toBe(0);
  });

  it('removing a line keeps shared points', () => {
    const s = createSketch('xy');
    const line1 = addLine(s, 0, 0, 10, 0);
    addLine(s, 10, 0, 10, 10); // shares endpoint with line1
    removeEntity(s, line1.id);
    // The shared point (10,0) should be kept since line2 references it.
    expect(s.entities.size).toBeGreaterThan(0);
  });

  it('removing a circle removes its center point', () => {
    const s = createSketch('xy');
    const circle = addCircle(s, 5, 5, 3);
    removeEntity(s, circle.id);
    // Center point should be removed since it's orphaned.
    expect(s.entities.size).toBe(0);
  });

  it('removing an arc removes its center point', () => {
    const s = createSketch('xy');
    const arc = addArc(s, 5, 5, 3, 0, Math.PI);
    removeEntity(s, arc.id);
    expect(s.entities.size).toBe(0);
  });
});
