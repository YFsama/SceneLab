import { describe, it, expect } from 'vitest';
import { layFlat } from './layFlat';
import { createBox, computeBoundingBox } from '../geometry';
import { rotateBody } from '../geometry/operations';

describe('layFlat', () => {
  it('rests a tilted slab on its largest face, seated on the bed', () => {
    // 20×10×20: largest facets are the two 20×20 faces (normal ±Y).
    const tilted = rotateBody(createBox(20, 10, 20), { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, Math.PI / 6);
    const flat = layFlat(tilted);
    const bb = computeBoundingBox(flat);
    expect(bb.min.y).toBeCloseTo(0, 4); // seated on the bed
    // Resting on a 20×20 face → the remaining height is the 10mm dimension.
    expect(bb.max.y - bb.min.y).toBeCloseTo(10, 3);
  });

  it('leaves an already-flat box at height = its short dimension', () => {
    const flat = layFlat(createBox(30, 5, 30));
    const bb = computeBoundingBox(flat);
    expect(bb.min.y).toBeCloseTo(0, 4);
    expect(bb.max.y - bb.min.y).toBeCloseTo(5, 3);
  });
});
