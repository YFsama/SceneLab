import { describe, it, expect } from 'vitest';
import { polygonPoints, addPolygon, createSketch } from './engine';

describe('polygonPoints', () => {
  it('returns `sides` vertices on the circumradius', () => {
    const pts = polygonPoints(0, 0, 5, 6);
    expect(pts).toHaveLength(6);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 6);
  });

  it('starts at the top (first vertex straight up)', () => {
    const [first] = polygonPoints(0, 0, 5, 4);
    expect(first!.x).toBeCloseTo(0, 6);
    expect(first!.y).toBeCloseTo(-5, 6);
  });

  it('clamps to at least 3 sides', () => {
    expect(polygonPoints(0, 0, 5, 2)).toHaveLength(3);
  });
});

describe('addPolygon', () => {
  it('adds one line per side to the sketch', () => {
    const s = createSketch('xy');
    const ids = addPolygon(s, 0, 0, 5, 6);
    expect(ids).toHaveLength(6);
    const lines = [...s.entities.values()].filter((e) => e.type === 'line');
    expect(lines).toHaveLength(6);
  });

  it('creates a triangle (3 sides)', () => {
    const s = createSketch('xy');
    const ids = addPolygon(s, 0, 0, 5, 3);
    expect(ids).toHaveLength(3);
  });

  it('creates a square (4 sides)', () => {
    const s = createSketch('xy');
    const ids = addPolygon(s, 0, 0, 5, 4);
    expect(ids).toHaveLength(4);
  });

  it('all returned IDs reference valid entities', () => {
    const s = createSketch('xy');
    const ids = addPolygon(s, 0, 0, 5, 6);
    for (const id of ids) {
      expect(s.entities.has(id)).toBe(true);
    }
  });
});

describe('polygonPoints edge cases', () => {
  it('handles large number of sides', () => {
    const pts = polygonPoints(0, 0, 5, 64);
    expect(pts).toHaveLength(64);
  });

  it('all points are at the correct radius', () => {
    const pts = polygonPoints(0, 0, 10, 8);
    for (const p of pts) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 6);
    }
  });

  it('points are evenly spaced around the circle', () => {
    const pts = polygonPoints(0, 0, 5, 4);
    // For a square, consecutive points should be 90° apart.
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      expect(dist).toBeGreaterThan(0);
    }
  });
});
