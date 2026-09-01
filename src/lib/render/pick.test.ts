import { describe, it, expect } from 'vitest';
import { pickBody, pickEdge } from './pick';
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

describe('pickEdge', () => {
  const box = createBox(10, 10, 10);

  it('hits the vertical edge nearest the ray', () => {
    // Ray looking straight down the Y axis, passing next to the corner column.
    const hit = pickEdge([box], { x: 5.1, y: 20, z: -5 }, { x: 0, y: -1, z: 0 }, 0.5);
    expect(hit).not.toBeNull();
    expect(hit!.bodyId).toBe(box.id);
    expect(hit!.edgeId).toBeTruthy();
  });

  it('misses when the ray is far from every edge', () => {
    // (2.5, 2.5) is the centre of a top-face quadrant, clear of the mid and
    // boundary edges of the subdivided face.
    expect(pickEdge([box], { x: 2.5, y: 20, z: 2.5 }, { x: 0, y: -1, z: 0 }, 0.5)).toBeNull();
  });

  it('misses when the closest approach is behind the origin', () => {
    expect(pickEdge([box], { x: 5.1, y: -20, z: -5 }, { x: 0, y: -1, z: 0 }, 0.5)).toBeNull();
  });

  it('picks the closest of two bodies', () => {
    const far = translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 });
    const hit = pickEdge([far, box], { x: 5.1, y: 20, z: -5 }, { x: 0, y: -1, z: 0 }, 0.5);
    expect(hit!.bodyId).toBe(box.id);
  });
});
