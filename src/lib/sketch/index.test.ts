import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addRectangle, addCircle, addArc,
  addConstraint, removeEntity, removeConstraint, solveSketch, getEntityPoints,
  solveConstraints,
} from './index';

describe('sketch module exports', () => {
  it('should export createSketch', () => {
    expect(typeof createSketch).toBe('function');
  });

  it('should export addPoint', () => {
    expect(typeof addPoint).toBe('function');
  });

  it('should export addLine', () => {
    expect(typeof addLine).toBe('function');
  });

  it('should export addRectangle', () => {
    expect(typeof addRectangle).toBe('function');
  });

  it('should export addCircle', () => {
    expect(typeof addCircle).toBe('function');
  });

  it('should export addArc', () => {
    expect(typeof addArc).toBe('function');
  });

  it('should export addConstraint', () => {
    expect(typeof addConstraint).toBe('function');
  });

  it('should export removeEntity', () => {
    expect(typeof removeEntity).toBe('function');
  });

  it('should export removeConstraint', () => {
    expect(typeof removeConstraint).toBe('function');
  });

  it('should export solveSketch', () => {
    expect(typeof solveSketch).toBe('function');
  });

  it('should export getEntityPoints', () => {
    expect(typeof getEntityPoints).toBe('function');
  });

  it('should export solveConstraints', () => {
    expect(typeof solveConstraints).toBe('function');
  });

  it('should create and solve a sketch end-to-end', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 5);
    addConstraint(sketch, 'horizontal', [Array.from(sketch.entities.values()).find(e => e.type === 'line')!.id]);
    const result = solveSketch(sketch);
    expect(result.size).toBe(2);
  });
});

describe('getEntityPoints', () => {
  it('returns the point for a point entity', () => {
    const s = createSketch('xy');
    const pt = addPoint(s, 5, 10);
    const pts = getEntityPoints(pt, s.entities);
    expect(pts).toEqual([{ x: 5, y: 10 }]);
  });

  it('returns two endpoints for a line entity', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 5);
    const pts = getEntityPoints(line, s.entities);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 10, y: 5 });
  });

  it('returns center point for a circle entity', () => {
    const s = createSketch('xy');
    const circle = addCircle(s, 5, 10, 3);
    const pts = getEntityPoints(circle, s.entities);
    expect(pts).toEqual([{ x: 5, y: 10 }]);
  });

  it('returns center point for an arc entity', () => {
    const s = createSketch('xy');
    const arc = addArc(s, 5, 10, 3, 0, Math.PI);
    const pts = getEntityPoints(arc, s.entities);
    expect(pts).toEqual([{ x: 5, y: 10 }]);
  });

  it('returns four corner points for a rectangle entity', () => {
    const s = createSketch('xy');
    addRectangle(s, 0, 0, 10, 5);
    const rectEntity = [...s.entities.values()].find(e => e.type === 'rectangle');
    if (rectEntity) {
      const pts = getEntityPoints(rectEntity, s.entities);
      expect(pts).toHaveLength(4);
    }
  });

  it('returns empty for a line with missing endpoints', () => {
    const s = createSketch('xy');
    const line = { id: 'bad', type: 'line' as const, p1Id: 'missing1', p2Id: 'missing2' };
    const pts = getEntityPoints(line, s.entities);
    expect(pts).toEqual([]);
  });

  it('returns empty for a circle with missing center', () => {
    const s = createSketch('xy');
    const circle = { id: 'bad', type: 'circle' as const, centerId: 'missing', radius: 5 };
    const pts = getEntityPoints(circle, s.entities);
    expect(pts).toEqual([]);
  });

  it('returns empty for an arc with missing center', () => {
    const s = createSketch('xy');
    const arc = { id: 'bad', type: 'arc' as const, centerId: 'missing', radius: 5, startAngle: 0, endAngle: Math.PI };
    const pts = getEntityPoints(arc, s.entities);
    expect(pts).toEqual([]);
  });

  it('returns correct points for a line with negative coordinates', () => {
    const s = createSketch('xy');
    const line = addLine(s, -5, -10, 3, 7);
    const pts = getEntityPoints(line, s.entities);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ x: -5, y: -10 });
    expect(pts[1]).toEqual({ x: 3, y: 7 });
  });
});
