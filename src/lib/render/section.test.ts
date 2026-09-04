import { describe, it, expect } from 'vitest';
import { sectionPlane } from './section';
import * as THREE from 'three';

describe('sectionPlane (live section analysis math)', () => {
  it('Z axis at offset 0 clips through the origin horizontally', () => {
    const p = sectionPlane({ active: true, axis: 'z', offset: 0, flip: false });
    expect(p.normal.x).toBeCloseTo(0, 9);
    expect(p.normal.y).toBeCloseTo(0, 9);
    expect(p.normal.z).toBeCloseTo(1, 9);
    expect(p.constant).toBeCloseTo(0, 9);
    // A point above the plane (normal side) is kept (distance > 0).
    expect(p.distanceToPoint(new THREE.Vector3(0, 0, 5))).toBeGreaterThan(0);
  });

  it('offset shifts the plane along the axis', () => {
    const p = sectionPlane({ active: true, axis: 'x', offset: 10, flip: false });
    expect(p.normal).toEqual(new THREE.Vector3(1, 0, 0));
    // The plane passes through (10, *, *).
    expect(p.distanceToPoint(new THREE.Vector3(10, 0, 0))).toBeCloseTo(0, 9);
    expect(p.distanceToPoint(new THREE.Vector3(12, 0, 0))).toBeCloseTo(2, 9);
  });

  it('flip negates the normal so the other half is kept', () => {
    const a = sectionPlane({ active: true, axis: 'y', offset: 4, flip: false });
    const b = sectionPlane({ active: true, axis: 'y', offset: 4, flip: true });
    expect(b.normal.x).toBeCloseTo(-a.normal.x, 9);
    // Both pass through the same point on the axis.
    expect(b.distanceToPoint(new THREE.Vector3(0, 4, 0))).toBeCloseTo(0, 9);
  });

  it('works for every axis', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const p = sectionPlane({ active: true, axis, offset: 3, flip: false });
      const point = new THREE.Vector3(axis === 'x' ? 3 : 0, axis === 'y' ? 3 : 0, axis === 'z' ? 3 : 0);
      expect(p.distanceToPoint(point)).toBeCloseTo(0, 9);
    }
  });
});
