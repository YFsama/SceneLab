import { describe, it, expect } from 'vitest';
import { pickBody } from './pick';
import { createBox } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('pickBody', () => {
  it('hits a box and reports the nearest face distance', () => {
    const box = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10]
    // Ray from +Z looking toward -Z, aimed at the box center height.
    const hit = pickBody([box], { x: 0, y: 5, z: 100 }, { x: 0, y: 0, z: -1 });
    expect(hit).not.toBeNull();
    expect(hit!.bodyId).toBe(box.id);
    expect(hit!.distance).toBeCloseTo(95, 4); // front face at z=5
    expect(hit!.point.z).toBeCloseTo(5, 4);
  });

  it('returns null when the ray misses', () => {
    const box = createBox(10, 10, 10);
    expect(pickBody([box], { x: 100, y: 100, z: 100 }, { x: 0, y: 0, z: -1 })).toBeNull();
  });

  it('returns the nearest of several bodies along the ray', () => {
    const near = translateBody(createBox(10, 10, 10), { x: 0, y: 0, z: 40 }); // front face z=45
    const far = createBox(10, 10, 10); // front face z=5
    const hit = pickBody([far, near], { x: 0, y: 5, z: 100 }, { x: 0, y: 0, z: -1 });
    expect(hit!.bodyId).toBe(near.id); // nearer one wins regardless of array order
    expect(hit!.distance).toBeCloseTo(55, 4);
  });
});
