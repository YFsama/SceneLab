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
});

describe('addArc', () => {
  it('should add an arc with center point', () => {
    const sketch = createSketch('xy');
    const arc = addArc(sketch, 0, 0, 5, 0, Math.PI);
    expect(arc.type).toBe('arc');
    expect(arc.radius).toBe(5);
    expect(sketch.entities.size).toBe(2); // 1 point + 1 arc
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
