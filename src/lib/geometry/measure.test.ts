import { describe, it, expect } from 'vitest';
import { minDistanceBetweenBodies } from './measure';
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
