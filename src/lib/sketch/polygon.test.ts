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
});
