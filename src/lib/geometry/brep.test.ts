import { describe, it, expect } from 'vitest';
import { createExtrude, createBox, createCylinder, createSphere, createCone, createTorus, createWedge, computeBoundingBox, computeVolume, createRevolve, findBoundaryLoops } from './brep';
import type { Vec3, SolidBody } from './types';

/** Translate every position of a body by an offset (helper for invariance tests). */
function translate(body: SolidBody, d: Vec3): SolidBody {
  const t = (v: Vec3): Vec3 => ({ x: v.x + d.x, y: v.y + d.y, z: v.z + d.z });
  return {
    ...body,
    vertices: body.vertices.map(t),
    faces: body.faces.map((f) => ({ ...f, vertices: f.vertices.map(t) })),
    edges: body.edges.map((e) => ({ ...e, start: t(e.start), end: t(e.end) })),
  };
}

describe('computeVolume translation invariance', () => {
  const offset = { x: 100, y: -50, z: 37 };
  it('box volume is unchanged after translation', () => {
    const box = createBox(10, 20, 10);
    expect(computeVolume(translate(box, offset))).toBeCloseTo(computeVolume(box), 6);
    expect(computeVolume(box)).toBeCloseTo(2000, 6);
  });
  it('cylinder volume is unchanged after translation', () => {
    const cyl = createCylinder(5, 10, 48);
    expect(computeVolume(translate(cyl, offset))).toBeCloseTo(computeVolume(cyl), 4);
  });
  it('sphere volume is unchanged after translation', () => {
    const sph = createSphere(5, 24);
    expect(computeVolume(translate(sph, offset))).toBeCloseTo(computeVolume(sph), 4);
  });
  it('cone volume is unchanged after translation', () => {
    const cone = createCone(5, 2, 10, 48);
    expect(computeVolume(translate(cone, offset))).toBeCloseTo(computeVolume(cone), 4);
  });
});

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

describe('createCone', () => {
  it('matches the frustum volume formula', () => {
    const Rb = 5, Rt = 2, h = 10;
    const cone = createCone(Rb, Rt, h, 64);
    const ideal = (Math.PI * h / 3) * (Rb * Rb + Rb * Rt + Rt * Rt);
    const vol = Math.abs(computeVolume(cone));
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
    expect(vol).toBeGreaterThan(ideal * 0.98);
  });

  it('matches the cone volume when the top radius is zero', () => {
    const Rb = 4, h = 9;
    const cone = createCone(Rb, 0, h, 64);
    const ideal = (Math.PI * h / 3) * Rb * Rb;
    const vol = Math.abs(computeVolume(cone));
    expect(vol).toBeGreaterThan(ideal * 0.98);
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
  });

  it('has the right bounding box and name', () => {
    const cone = createCone(5, 0, 10, 32);
    const bb = computeBoundingBox(cone);
    expect(cone.name).toBe('Cone');
    expect(bb.max.y - bb.min.y).toBeCloseTo(10, 5);
    expect(bb.max.x).toBeCloseTo(5, 1);
  });

  it('rejects invalid parameters', () => {
    expect(() => createCone(0, 0, 10)).toThrow('radius must be positive');
    expect(() => createCone(5, 2, 0)).toThrow('Height');
    expect(() => createCone(5, 2, 10, 2)).toThrow('segments');
  });
});

describe('createTorus', () => {
  it('matches the analytic volume 2π²·R·r²', () => {
    const R = 10, r = 3;
    const torus = createTorus(R, r, 64, 32);
    const ideal = 2 * Math.PI ** 2 * R * r * r;
    const vol = Math.abs(computeVolume(torus));
    expect(vol).toBeGreaterThan(ideal * 0.97);
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
  });

  it('has the expected bounding box and name', () => {
    const torus = createTorus(10, 3, 32, 16);
    const bb = computeBoundingBox(torus);
    expect(torus.name).toBe('Torus');
    expect(bb.max.x).toBeCloseTo(13, 1); // R + r
    expect(bb.max.y - bb.min.y).toBeCloseTo(6, 1); // 2r
  });

  it('rejects invalid parameters', () => {
    expect(() => createTorus(0, 3)).toThrow('Radius');
    expect(() => createTorus(5, 8)).toThrow('minorRadius');
    expect(() => createTorus(10, 3, 2)).toThrow('segments and sides');
  });
});

describe('createRevolve solid', () => {
  // Rectangle section x∈[2,4], y∈[0,2] in the XY plane.
  const rect: Vec3[] = [
    { x: 2, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 2, z: 0 },
    { x: 2, y: 2, z: 0 },
  ];
  const axisY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };

  it('a full revolution is watertight with the Pappus volume', () => {
    const body = createRevolve({ profile: rect, axis: axisY, angle: Math.PI * 2 });
    // V = area(4) × 2π × centroidRadius(3) = 24π ≈ 75.4
    const ideal = 24 * Math.PI;
    const vol = Math.abs(computeVolume(body));
    expect(vol).toBeGreaterThan(ideal * 0.96);
    expect(vol).toBeLessThanOrEqual(ideal * 1.001);
  });

  it('full-revolution volume is translation invariant', () => {
    const body = createRevolve({ profile: rect, axis: axisY, angle: Math.PI * 2 });
    const t = (v: Vec3) => ({ x: v.x + 30, y: v.y + 5, z: v.z - 12 });
    const moved: SolidBody = {
      ...body,
      vertices: body.vertices.map(t),
      faces: body.faces.map((f) => ({ ...f, vertices: f.vertices.map(t) })),
      edges: body.edges.map((e) => ({ ...e, start: t(e.start), end: t(e.end) })),
    };
    expect(computeVolume(moved)).toBeCloseTo(computeVolume(body), 4);
  });

  it('a partial revolution is watertight with the fractional Pappus volume', () => {
    const body = createRevolve({ profile: rect, axis: axisY, angle: Math.PI });
    // V = area(4) × angle(π) × centroidRadius(3) = 12π ≈ 37.7
    const ideal = 4 * Math.PI * 3;
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(ideal * 0.98);
    expect(Math.abs(computeVolume(body))).toBeLessThanOrEqual(ideal * 1.001);
    expect(findBoundaryLoops(body).holeCount).toBe(0); // caps close the ends
  });
});

describe('primitives are watertight', () => {
  const rect = [
    { x: 2, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 2, z: 0 },
    { x: 2, y: 2, z: 0 },
  ];
  const axisY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
  const cases: [string, () => import('./types').SolidBody][] = [
    ['box', () => createBox(10, 10, 10)],
    ['cylinder', () => createCylinder(5, 10, 32)],
    ['sphere', () => createSphere(5, 16)],
    ['frustum', () => createCone(5, 2, 10, 32)],
    ['cone', () => createCone(5, 0, 10, 32)],
    ['torus', () => createTorus(10, 3, 32, 16)],
    ['wedge', () => createWedge(10, 6, 4)],
    ['revolve-full', () => createRevolve({ profile: rect, axis: axisY, angle: Math.PI * 2 })],
    ['revolve-partial', () => createRevolve({ profile: rect, axis: axisY, angle: Math.PI / 2 })],
  ];

  for (const [name, make] of cases) {
    it(`${name} has no boundary holes`, () => {
      expect(findBoundaryLoops(make()).holeCount).toBe(0);
    });
  }
});

describe('createWedge', () => {
  it('has volume ½·w·h·d', () => {
    const wedge = createWedge(10, 6, 4); // ½·10·6·4 = 120
    expect(Math.abs(computeVolume(wedge))).toBeCloseTo(120, 6);
  });

  it('is translation invariant in volume', () => {
    const w = createWedge(10, 6, 4);
    const t = (v: Vec3) => ({ x: v.x + 50, y: v.y - 20, z: v.z + 7 });
    const moved: SolidBody = {
      ...w,
      vertices: w.vertices.map(t),
      faces: w.faces.map((f) => ({ ...f, vertices: f.vertices.map(t) })),
      edges: w.edges.map((e) => ({ ...e, start: t(e.start), end: t(e.end) })),
    };
    expect(computeVolume(moved)).toBeCloseTo(computeVolume(w), 6);
  });

  it('has the right bounding box and name', () => {
    const wedge = createWedge(10, 6, 4);
    const bb = computeBoundingBox(wedge);
    expect(wedge.name).toBe('Wedge');
    expect(bb.max.x - bb.min.x).toBeCloseTo(10, 6);
    expect(bb.max.y - bb.min.y).toBeCloseTo(6, 6);
    expect(bb.max.z - bb.min.z).toBeCloseTo(4, 6);
  });

  it('rejects invalid parameters', () => {
    expect(() => createWedge(0, 6, 4)).toThrow('positive');
  });
});
