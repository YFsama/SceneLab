import { describe, it, expect } from 'vitest';
import { createExtrude, createBox, createCylinder, createSphere, computeBoundingBox, computeVolume, createRevolve } from './brep';
import type { Vec3 } from './types';

describe('createExtrude', () => {
  it('should create a box-like extrude from a rectangle profile', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
    ];

    const body = createExtrude({
      profile,
      direction: { x: 0, y: 1, z: 0 },
      distance: 2,
    });

    expect(body.name).toBe('Extrude');
    expect(body.vertices.length).toBe(8);
    expect(body.faces.length).toBe(6); // 2 caps + 4 sides
    expect(body.edges.length).toBe(12); // 4*3 edges
  });

  it('should throw for profile with fewer than 3 points', () => {
    expect(() =>
      createExtrude({
        profile: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
        direction: { x: 0, y: 1, z: 0 },
        distance: 1,
      }),
    ).toThrow('Profile must have at least 3 points');
  });

  it('should throw for distance <= 0', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
    ];
    expect(() =>
      createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 0 }),
    ).toThrow('Distance must be positive');
    expect(() =>
      createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: -5 }),
    ).toThrow('Distance must be positive');
  });

  it('should throw for zero direction vector', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
    ];
    expect(() =>
      createExtrude({ profile, direction: { x: 0, y: 0, z: 0 }, distance: 5 }),
    ).toThrow('Direction vector cannot be zero');
  });

  it('should support symmetric extrude', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
    ];

    const body = createExtrude({
      profile,
      direction: { x: 0, y: 1, z: 0 },
      distance: 2,
      symmetric: true,
    });

    const bb = computeBoundingBox(body);
    // Should be centered around y=0
    expect(bb.min.y).toBeCloseTo(-1);
    expect(bb.max.y).toBeCloseTo(1);
  });
});

describe('createBox', () => {
  it('should create a box with correct dimensions', () => {
    const body = createBox(2, 3, 4);

    const bb = computeBoundingBox(body);
    expect(bb.min.x).toBeCloseTo(-1);
    expect(bb.max.x).toBeCloseTo(1);
    expect(bb.max.y - bb.min.y).toBeCloseTo(3);
    expect(bb.max.z - bb.min.z).toBeCloseTo(4);
  });
});

describe('computeBoundingBox', () => {
  it('should compute correct bounding box', () => {
    const body = createBox(2, 2, 2);
    const bb = computeBoundingBox(body);

    expect(bb.min.x).toBeCloseTo(-1);
    expect(bb.max.x).toBeCloseTo(1);
    expect(bb.min.y).toBeCloseTo(0);
    expect(bb.max.y).toBeCloseTo(2);
  });
});

describe('computeVolume', () => {
  it('should compute correct volume for a box', () => {
    const body = createBox(2, 3, 4);
    const volume = computeVolume(body);
    expect(volume).toBeCloseTo(24, 0); // 2 * 3 * 4
  });
});

describe('createRevolve', () => {
  it('should create a revolved body', () => {
    const profile: Vec3[] = [
      { x: 1, y: -1, z: 0 },
      { x: 2, y: -1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ];

    const body = createRevolve({
      profile,
      axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
      angle: Math.PI * 2,
    });

    expect(body.name).toBe('Revolve');
    expect(body.vertices.length).toBeGreaterThan(0);
    expect(body.faces.length).toBeGreaterThan(0);
  });

  it('should throw for profile with fewer than 2 points', () => {
    expect(() =>
      createRevolve({
        profile: [{ x: 0, y: 0, z: 0 }],
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
        angle: Math.PI,
      }),
    ).toThrow('Profile must have at least 2 points');
  });

  it('should throw for zero angle', () => {
    const profile: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ];
    expect(() =>
      createRevolve({
        profile,
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
        angle: 0,
      }),
    ).toThrow('Revolve angle cannot be zero');
  });

  it('should throw for zero axis direction', () => {
    const profile: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ];
    expect(() =>
      createRevolve({
        profile,
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 } },
        angle: Math.PI,
      }),
    ).toThrow('Axis direction vector cannot be zero');
  });
});

describe('createCylinder', () => {
  it('approximates the analytic volume πr²h', () => {
    const r = 5;
    const h = 10;
    const cyl = createCylinder(r, h, 64);
    const ideal = Math.PI * r * r * h;
    const vol = Math.abs(computeVolume(cyl));
    // An inscribed 64-gon prism is slightly under the true cylinder (<0.5%).
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
    expect(vol).toBeGreaterThan(ideal * 0.99);
  });

  it('has the right bounding box and name', () => {
    const cyl = createCylinder(5, 10, 32);
    const bb = computeBoundingBox(cyl);
    expect(cyl.name).toBe('Cylinder');
    expect(bb.max.y - bb.min.y).toBeCloseTo(10, 5);
    expect(bb.max.x).toBeCloseTo(5, 5);
    expect(bb.min.x).toBeCloseTo(-5, 5);
  });

  it('rejects invalid parameters', () => {
    expect(() => createCylinder(0, 10)).toThrow('Radius');
    expect(() => createCylinder(5, 0)).toThrow('Height');
    expect(() => createCylinder(5, 10, 2)).toThrow('segments');
  });
});

describe('createSphere', () => {
  it('approximates the analytic volume 4/3πr³', () => {
    const r = 5;
    const sphere = createSphere(r, 48);
    const ideal = (4 / 3) * Math.PI * r ** 3;
    const vol = Math.abs(computeVolume(sphere));
    // A UV sphere is inscribed in the true sphere → slightly under, within ~2%.
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
    expect(vol).toBeGreaterThan(ideal * 0.98);
  });

  it('has a 2r bounding box centered at the origin', () => {
    const sphere = createSphere(5, 24);
    const bb = computeBoundingBox(sphere);
    expect(sphere.name).toBe('Sphere');
    expect(bb.max.x - bb.min.x).toBeCloseTo(10, 1);
    expect(bb.max.y).toBeCloseTo(5, 5);
    expect(bb.min.y).toBeCloseTo(-5, 5);
  });

  it('rejects invalid parameters', () => {
    expect(() => createSphere(0)).toThrow('Radius');
    expect(() => createSphere(5, 2)).toThrow('segments');
  });
});
