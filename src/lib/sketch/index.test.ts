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
