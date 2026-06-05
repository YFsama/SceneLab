import { describe, it, expect } from 'vitest';
import { createSketch, addLine, addCircle, addArc, addPoint } from './engine';
import { pickSketchEntity } from './pick';

describe('pickSketchEntity', () => {
  it('picks a line when clicking near its segment', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 0);
    expect(pickSketchEntity(s, { x: 5, y: 0.2 }, 0.5)).toBe(line.id);
  });

  it('does not pick a line far from it', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 10, 0);
    expect(pickSketchEntity(s, { x: 5, y: 5 }, 0.5)).toBeNull();
  });

  it('picks a circle when clicking near its ring (not its centre)', () => {
    const s = createSketch('xy');
    const c = addCircle(s, 0, 0, 5);
    expect(pickSketchEntity(s, { x: 5.1, y: 0 }, 0.5)).toBe(c.id); // near ring
  });

  it('picks the nearest of several entities', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 10, 0);   // along y=0
    const l2 = addLine(s, 0, 5, 10, 5); // along y=5
    expect(pickSketchEntity(s, { x: 5, y: 4.9 }, 1)).toBe(l2.id);
  });

  it('picks an arc when clicking near its curve', () => {
    const s = createSketch('xy');
    const arc = addArc(s, 0, 0, 5, 0, Math.PI);
    expect(pickSketchEntity(s, { x: 5.1, y: 0.1 }, 0.5)).toBe(arc.id);
  });

  it('picks a point when clicking near it', () => {
    const s = createSketch('xy');
    const pt = addPoint(s, 10, 20);
    expect(pickSketchEntity(s, { x: 10.1, y: 20.1 }, 0.5)).toBe(pt.id);
  });

  it('returns null for empty sketch', () => {
    const s = createSketch('xy');
    expect(pickSketchEntity(s, { x: 5, y: 5 }, 0.5)).toBeNull();
  });

  it('picks line over distant circle', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 10, 0);
    addCircle(s, 50, 50, 10);
    expect(pickSketchEntity(s, { x: 5, y: 0.1 }, 1)).toBe(line.id);
  });
});
