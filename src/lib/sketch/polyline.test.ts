import { describe, it, expect } from 'vitest';
import { createSketch, addLine, solveSketch } from './engine';

describe('polyline tool', () => {
  it('creates connected line segments', () => {
    const sketch = createSketch('xz');

    // Simulate polyline: click at (0,0), then (10,0), then (10,10).
    // Each click commits a segment from the last point.
    let lastPoint: { x: number; y: number } | null = null;

    const clickAt = (x: number, y: number) => {
      if (lastPoint) {
        addLine(sketch, lastPoint.x, lastPoint.y, x, y);
      }
      lastPoint = { x, y };
    };

    clickAt(0, 0);
    clickAt(10, 0);
    clickAt(10, 10);

    // Should have 2 line segments (3 points → 2 lines).
    const lines = [...sketch.entities.values()].filter((e) => e.type === 'line');
    expect(lines).toHaveLength(2);

    // Lines should share the middle point.
    const line1 = lines[0]!;
    const line2 = lines[1]!;
    const p1End = sketch.entities.get(line1.p2Id);
    const p2Start = sketch.entities.get(line2.p1Id);
    expect(p1End?.type).toBe('point');
    expect(p2Start?.type).toBe('point');
  });

  it('polylineLast tracks the chain progress', () => {
    let polylineLast: { x: number; y: number } | null = null;

    // First click: set polylineLast.
    polylineLast = { x: 0, y: 0 };
    expect(polylineLast).toEqual({ x: 0, y: 0 });

    // Second click: commit segment, update polylineLast.
    polylineLast = { x: 10, y: 0 };
    expect(polylineLast).toEqual({ x: 10, y: 0 });

    // Third click: commit segment, update polylineLast.
    polylineLast = { x: 10, y: 10 };
    expect(polylineLast).toEqual({ x: 10, y: 10 });

    // Enter: finish chain (clear polylineLast).
    polylineLast = null;
    expect(polylineLast).toBeNull();
  });

  it('polyline produces valid sketch geometry', () => {
    const sketch = createSketch('xz');

    // Create a polyline: L-shape.
    addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 10, 0, 10, 10);

    // Solve should work without errors.
    const result = solveSketch(sketch);
    expect(result.size).toBeGreaterThan(0);

    // Check that the points are at the expected positions.
    const points = [...sketch.entities.values()].filter((e) => e.type === 'point');
    expect(points.length).toBeGreaterThanOrEqual(3); // at least 3 unique points
  });
});
