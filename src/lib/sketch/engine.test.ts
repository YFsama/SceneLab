import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addRectangle, addCircle, addArc,
  addConstraint, removeEntity, removeConstraint, solveSketch,
} from './engine';

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
  it('should remove entity and its constraints', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 0);
    addConstraint(sketch, 'horizontal', [line.id]);
    expect(sketch.entities.size).toBe(3);
    expect(sketch.constraints.size).toBe(1);

    removeEntity(sketch, line.id);
    expect(sketch.entities.size).toBe(2); // points remain
    expect(sketch.constraints.size).toBe(0); // constraint removed
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
