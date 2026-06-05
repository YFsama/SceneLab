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

  it('hits from the top (ray along -Y)', () => {
    const box = createBox(10, 10, 10); // y ∈ [0,10]
    const hit = pickBody([box], { x: 0, y: 100, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.bodyId).toBe(box.id);
    expect(hit!.distance).toBeCloseTo(90, 4); // top face at y=10
  });

  it('hits from the side (ray along -X)', () => {
    const box = createBox(10, 10, 10); // x ∈ [-5,5]
    const hit = pickBody([box], { x: 100, y: 5, z: 0 }, { x: -1, y: 0, z: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.bodyId).toBe(box.id);
    expect(hit!.distance).toBeCloseTo(95, 4); // right face at x=5
  });

  it('returns null for empty body list', () => {
    expect(pickBody([], { x: 0, y: 0, z: 100 }, { x: 0, y: 0, z: -1 })).toBeNull();
  });

  it('hit point is on the body surface', () => {
    const box = createBox(10, 10, 10);
    const hit = pickBody([box], { x: 0, y: 5, z: 100 }, { x: 0, y: 0, z: -1 });
    expect(hit).not.toBeNull();
    // Hit point should be on the front face (z=5).
    expect(hit!.point.z).toBeCloseTo(5, 4);
    expect(hit!.point.x).toBeGreaterThanOrEqual(-5);
    expect(hit!.point.x).toBeLessThanOrEqual(5);
    expect(hit!.point.y).toBeGreaterThanOrEqual(0);
    expect(hit!.point.y).toBeLessThanOrEqual(10);
  });
});
