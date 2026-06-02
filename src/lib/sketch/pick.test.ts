import { describe, it, expect } from 'vitest';
import { createSketch, addLine, addCircle } from './engine';
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
});
