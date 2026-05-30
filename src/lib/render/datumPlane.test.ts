import { describe, it, expect } from 'vitest';
import { datumPlaneCorners, datumPlaneTriangles, datumPlaneOutline } from './datumPlane';
import { makePlane } from '../geometry/referenceGeometry';

describe('datumPlaneCorners', () => {
  it('places four corners around the origin spanning u/v at ±size/2', () => {
    // XY plane (normal +Z): makePlane picks u along +X, v along +Y.
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const corners = datumPlaneCorners(plane, 4);
    expect(corners).toHaveLength(4);
    // All corners lie in the z=0 plane.
    for (const c of corners) expect(c.z).toBeCloseTo(0, 6);
    // Each corner is at distance 2 from the origin along both axes (half-extent).
    for (const c of corners) {
      expect(Math.abs(c.x)).toBeCloseTo(2, 6);
      expect(Math.abs(c.y)).toBeCloseTo(2, 6);
    }
  });

  it('centres on a non-origin plane origin', () => {
    const plane = makePlane({ x: 10, y: 5, z: -2 }, { x: 0, y: 0, z: 1 });
    const corners = datumPlaneCorners(plane, 2);
    const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
    const cy = corners.reduce((s, c) => s + c.y, 0) / 4;
    const cz = corners.reduce((s, c) => s + c.z, 0) / 4;
    expect(cx).toBeCloseTo(10, 6);
    expect(cy).toBeCloseTo(5, 6);
    expect(cz).toBeCloseTo(-2, 6);
  });

  it('lies in the plane (every corner has zero signed distance to the normal)', () => {
    const plane = makePlane({ x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 1 });
    for (const c of datumPlaneCorners(plane, 6)) {
      const d =
        plane.normal.x * (c.x - plane.origin.x) +
        plane.normal.y * (c.y - plane.origin.y) +
        plane.normal.z * (c.z - plane.origin.z);
      expect(d).toBeCloseTo(0, 6);
    }
  });
});

describe('datumPlaneTriangles', () => {
  it('emits two triangles (6 vertices, 18 numbers)', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(datumPlaneTriangles(plane, 4)).toHaveLength(18);
  });
});

describe('datumPlaneOutline', () => {
  it('is a closed loop of 5 points (first == last)', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const out = datumPlaneOutline(plane, 4);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(out[4]);
  });
});
