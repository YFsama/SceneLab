import { describe, it, expect } from 'vitest';
import { seatOnBed } from './seat';
import { createBox, computeBoundingBox, translateBody } from '../geometry';

describe('seatOnBed', () => {
  it('drops a floating part so its lowest point rests at y=0', () => {
    const floating = translateBody(createBox(10, 10, 10), { x: 3, y: 50, z: -4 });
    const seated = seatOnBed(floating);
    const bb = computeBoundingBox(seated);
    expect(bb.min.y).toBeCloseTo(0, 6);
    // Footprint (X/Z) is preserved — only the build axis moved.
    const before = computeBoundingBox(floating);
    expect(bb.min.x).toBeCloseTo(before.min.x, 6);
    expect(bb.min.z).toBeCloseTo(before.min.z, 6);
  });

  it('lifts a part sunk below the bed up to y=0', () => {
    const sunk = translateBody(createBox(10, 10, 10), { x: 0, y: -25, z: 0 });
    const bb = computeBoundingBox(seatOnBed(sunk));
    expect(bb.min.y).toBeCloseTo(0, 6);
  });

  it('seats along a custom build axis (+Z)', () => {
    const part = translateBody(createBox(10, 10, 10), { x: 0, y: 0, z: 40 });
    const bb = computeBoundingBox(seatOnBed(part, { x: 0, y: 0, z: 1 }));
    expect(bb.min.z).toBeCloseTo(0, 6);
  });

  it('returns an already-seated part unchanged', () => {
    const box = createBox(10, 20, 10); // base already at y=0
    expect(seatOnBed(box)).toBe(box);
  });
});
