import { describe, it, expect } from 'vitest';
import { minDistanceBetweenBodies, isPointInsideBody, bodiesInterfere, interferenceVolume, computeSceneMassProperties } from './measure';
import { createBox } from './brep';
import { translateBody } from './operations';

describe('minDistanceBetweenBodies', () => {
  const a = createBox(10, 10, 10); // x,z ∈ [-5,5]

  it('measures the gap between two separated boxes', () => {
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25]
    expect(minDistanceBetweenBodies(a, b)).toBeCloseTo(10, 4);
  });

  it('returns 0 for touching faces', () => {
    const b = translateBody(createBox(10, 10, 10), { x: 10, y: 0, z: 0 }); // shares x=5 face
    expect(minDistanceBetweenBodies(a, b)).toBeCloseTo(0, 4);
  });

  it('measures a diagonal corner gap correctly', () => {
    // Box shifted +20 in both X and Z → nearest corners are √(15²+15²) apart.
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 20 });
    expect(minDistanceBetweenBodies(a, b)).toBeCloseTo(Math.hypot(10, 10), 3);
  });
});

describe('isPointInsideBody', () => {
  const box = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10]
  it('detects inside and outside points', () => {
    expect(isPointInsideBody(box, { x: 0, y: 5, z: 0 })).toBe(true);
    expect(isPointInsideBody(box, { x: 50, y: 5, z: 0 })).toBe(false);
    expect(isPointInsideBody(box, { x: 0, y: 20, z: 0 })).toBe(false);
  });
});

describe('bodiesInterfere', () => {
  const a = createBox(10, 10, 10);
  it('flags overlapping bodies and clears separated ones', () => {
    expect(bodiesInterfere(a, translateBody(createBox(10, 10, 10), { x: 4, y: 4, z: 4 }))).toBe(true);
    expect(bodiesInterfere(a, translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }))).toBe(false);
  });
});

describe('interferenceVolume', () => {
  const a = createBox(10, 10, 10); // x,z ∈ [-5,5]
  it('estimates the overlap volume of two boxes', () => {
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }); // overlap x∈[0,5] → 5·10·10
    expect(interferenceVolume(a, b, 32)).toBeCloseTo(500, -1); // within ~10 of 500
  });
  it('is 0 for separated bodies', () => {
    expect(interferenceVolume(a, translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }))).toBe(0);
  });
});

describe('computeSceneMassProperties', () => {
  it('combines volume, mass and mass-weighted CoM across bodies', () => {
    const a = createBox(10, 10, 10); // com (0,5,0), vol 1000
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // com (20,5,0)
    const s = computeSceneMassProperties([a, b], 1);
    expect(s.bodyCount).toBe(2);
    expect(s.totalVolume).toBeCloseTo(2000, 2);
    expect(s.totalMass).toBeCloseTo(2000, 2);
    expect(s.centerOfMass.x).toBeCloseTo(10, 3);
    expect(s.centerOfMass.y).toBeCloseTo(5, 3);
    expect(s.centerOfMass.z).toBeCloseTo(0, 3);
  });
  it('handles an empty scene', () => {
    const s = computeSceneMassProperties([], 1);
    expect(s.totalMass).toBe(0);
  });
});
