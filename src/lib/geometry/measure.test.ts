import { describe, it, expect } from 'vitest';
import { minDistanceBetweenBodies, isPointInsideBody, bodiesInterfere, interferenceVolume, computeSceneMassProperties, angleBetweenRays, polygonArea3D, faceAreaAndCentroid, computeMeasureReadout } from './measure';
import { createBox } from './brep';
import { translateBody } from './operations';
import type { SolidBody, Vec3 } from './types';

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

  it('mass scales with density', () => {
    const box = createBox(10, 10, 10);
    const s1 = computeSceneMassProperties([box], 1);
    const s2 = computeSceneMassProperties([box], 2);
    expect(s2.totalMass).toBeCloseTo(s1.totalMass * 2, 0);
  });

  it('mass scales with volume', () => {
    const small = createBox(10, 10, 10);
    const large = createBox(20, 20, 20);
    const s1 = computeSceneMassProperties([small], 1);
    const s2 = computeSceneMassProperties([large], 1);
    // Volume scales by 8× (2³).
    expect(s2.totalMass).toBeCloseTo(s1.totalMass * 8, 0);
  });

  it('center of mass is at the geometric center for a single symmetric body', () => {
    const box = createBox(10, 20, 30);
    const s = computeSceneMassProperties([box], 1);
    // Box is centered at origin in X/Z, bottom at Y=0.
    expect(s.centerOfMass.x).toBeCloseTo(0, 1);
    expect(s.centerOfMass.z).toBeCloseTo(0, 1);
  });
});

describe('angleBetweenRays (measure.ts)', () => {
  it('returns 90 for perpendicular rays', () => {
    expect(angleBetweenRays({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(90, 9);
  });

  it('works away from the origin', () => {
    expect(angleBetweenRays({ x: 1, y: 2, z: 3 }, { x: 4, y: 2, z: 3 }, { x: 1, y: 5, z: 3 })).toBeCloseTo(90, 9);
  });

  it('returns 180 for opposite collinear rays and 0 for same-direction ones', () => {
    const v = { x: 0, y: 0, z: 0 };
    expect(angleBetweenRays(v, { x: 1, y: 0, z: 0 }, { x: -2, y: 0, z: 0 })).toBeCloseTo(180, 9);
    expect(angleBetweenRays(v, { x: 1, y: 0, z: 0 }, { x: 5, y: 0, z: 0 })).toBeCloseTo(0, 9);
  });

  it('guards zero-length rays', () => {
    const v = { x: 1, y: 1, z: 1 };
    expect(angleBetweenRays(v, v, { x: 2, y: 1, z: 1 })).toBe(0);
    expect(angleBetweenRays(v, { x: 2, y: 1, z: 1 }, v)).toBe(0);
  });

  it('measures an exact 60° between in-plane rays', () => {
    const b = { x: Math.cos(Math.PI / 3), y: Math.sin(Math.PI / 3), z: 0 };
    expect(angleBetweenRays({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, b)).toBeCloseTo(60, 9);
  });
});

describe('polygonArea3D', () => {
  const unitSquare: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 },
  ];

  it('computes the unit square area', () => {
    expect(polygonArea3D(unitSquare)).toBeCloseTo(1, 9);
  });

  it('returns 0 for fewer than 3 points', () => {
    expect(polygonArea3D([])).toBe(0);
    expect(polygonArea3D([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])).toBe(0);
  });

  it('is invariant under 3D rotation', () => {
    // Rotate the square 45° about X then 30° about Y — area must stay 1.
    const a = (45 * Math.PI) / 180;
    const b = (30 * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const rotX = (p: Vec3): Vec3 => ({ x: p.x, y: p.y * ca - p.z * sa, z: p.y * sa + p.z * ca });
    const rotY = (p: Vec3): Vec3 => ({ x: p.x * cb + p.z * sb, y: p.y, z: -p.x * sb + p.z * cb });
    expect(polygonArea3D(unitSquare.map((p) => rotY(rotX(p))))).toBeCloseTo(1, 9);
  });

  it('matches the shoelace formula for a regular pentagon', () => {
    const r = 2;
    const pent = Array.from({ length: 5 }, (_, i) => {
      const t = (2 * Math.PI * i) / 5;
      return { x: r * Math.cos(t), y: r * Math.sin(t), z: 0 };
    });
    const shoelace = 0.5 * pent.reduce((s, p, i) => {
      const q = pent[(i + 1) % 5]!;
      return s + p.x * q.y - q.x * p.y;
    }, 0);
    expect(polygonArea3D(pent)).toBeCloseTo(shoelace, 9);
    // Closed form (5/2)·r²·sin(72°) keeps the reference honest.
    expect(shoelace).toBeCloseTo(2.5 * r * r * Math.sin((2 * Math.PI) / 5), 9);
  });
});

describe('faceAreaAndCentroid', () => {
  const regularPentagon = (): Vec3[] =>
    Array.from({ length: 5 }, (_, i) => {
      const t = (2 * Math.PI * i) / 5;
      return { x: 2 * Math.cos(t), y: 2 * Math.sin(t), z: 0 };
    });

  it('returns null for an unknown face id', () => {
    expect(faceAreaAndCentroid(createBox(10, 10, 10), 'nope')).toBeNull();
  });

  it('returns null for a face with fewer than 3 vertices', () => {
    const body: SolidBody = {
      id: 'b', name: 'B',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
      faces: [{ id: 'f', vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], normal: { x: 0, y: 1, z: 0 } }],
      edges: [],
    };
    expect(faceAreaAndCentroid(body, 'f')).toBeNull();
  });

  it('computes a box cap face area and its centre', () => {
    const box = createBox(10, 20, 30); // bottom/top caps are 10×30 = 300
    const bottom = box.faces.find((f) => f.vertices.every((v) => Math.abs(v.y) < 1e-9))!;
    const r = faceAreaAndCentroid(box, bottom.id)!;
    expect(r.area).toBeCloseTo(300, 6);
    expect(r.centroid.x).toBeCloseTo(0, 6);
    expect(r.centroid.y).toBeCloseTo(0, 6);
    expect(r.centroid.z).toBeCloseTo(0, 6);
  });

  it('agrees with Newell area on every face of a box', () => {
    const box = createBox(10, 20, 30);
    for (const f of box.faces) {
      expect(faceAreaAndCentroid(box, f.id)!.area).toBeCloseTo(polygonArea3D(f.vertices), 6);
    }
  });

  it('fan-triangulates a pentagon face to the shoelace area, centroid at the centre', () => {
    const pent = regularPentagon();
    const shoelace = 0.5 * pent.reduce((s, p, i) => {
      const q = pent[(i + 1) % 5]!;
      return s + p.x * q.y - q.x * p.y;
    }, 0);
    const body: SolidBody = {
      id: 'p', name: 'P', vertices: pent,
      faces: [{ id: 'pf', vertices: pent, normal: { x: 0, y: 0, z: 1 } }],
      edges: [],
    };
    const r = faceAreaAndCentroid(body, 'pf')!;
    expect(r.area).toBeCloseTo(shoelace, 9);
    expect(r.centroid.x).toBeCloseTo(0, 9);
    expect(r.centroid.y).toBeCloseTo(0, 9);
  });

  it('area-weights the centroid (differs from the vertex average)', () => {
    // Quad (0,0),(4,0),(4,1),(0,3): fan areas 2 and 6 → weighted centroid
    // (5/3, 13/12), unlike the vertex average (2, 1).
    const quad: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 1, z: 0 },
      { x: 0, y: 3, z: 0 },
    ];
    const body: SolidBody = {
      id: 'q', name: 'Q', vertices: quad,
      faces: [{ id: 'qf', vertices: quad, normal: { x: 0, y: 0, z: 1 } }],
      edges: [],
    };
    const r = faceAreaAndCentroid(body, 'qf')!;
    expect(r.area).toBeCloseTo(8, 9);
    expect(r.centroid.x).toBeCloseTo(5 / 3, 9);
    expect(r.centroid.y).toBeCloseTo(13 / 12, 9);
  });
});

describe('computeMeasureReadout', () => {
  it('distance: two points give the length, anchored at the midpoint', () => {
    const r = computeMeasureReadout('distance', [{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }], null, [])!;
    expect(r.text).toBe('5.0 mm');
    expect(r.anchor.x).toBeCloseTo(1.5, 9);
    expect(r.anchor.y).toBeCloseTo(2, 9);
    expect(r.anchor.z).toBeCloseTo(0, 9);
  });

  it('distance: three points chain the picked path', () => {
    const r = computeMeasureReadout('distance', [{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, { x: 3, y: 4, z: 5 }], null, [])!;
    expect(r.text).toBe('10.0 mm');
  });

  it('distance: null until two points are picked', () => {
    expect(computeMeasureReadout('distance', [], null, [])).toBeNull();
    expect(computeMeasureReadout('distance', [{ x: 0, y: 0, z: 0 }], null, [])).toBeNull();
  });

  it('angle: three points give the angle at the middle point, anchored there', () => {
    const r = computeMeasureReadout('angle', [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], null, [])!;
    expect(r.text).toBe('∠ 90.0°');
    expect(r.anchor).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('angle: null until three points are picked', () => {
    expect(computeMeasureReadout('angle', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], null, [])).toBeNull();
  });

  it('area: the picked face gives the area text, anchored at the centroid', () => {
    const box = createBox(10, 20, 30);
    const bottom = box.faces.find((f) => f.vertices.every((v) => Math.abs(v.y) < 1e-9))!;
    const r = computeMeasureReadout('area', [], { bodyId: box.id, faceId: bottom.id }, [box])!;
    expect(r.text).toBe('A 300.0 mm²');
    expect(r.anchor.x).toBeCloseTo(0, 6);
    expect(r.anchor.y).toBeCloseTo(0, 6);
    expect(r.anchor.z).toBeCloseTo(0, 6);
  });

  it('area: null with no pick, a missing body, or an unknown face', () => {
    const box = createBox(10, 10, 10);
    expect(computeMeasureReadout('area', [], null, [box])).toBeNull();
    expect(computeMeasureReadout('area', [], { bodyId: 'gone', faceId: 'f' }, [box])).toBeNull();
    expect(computeMeasureReadout('area', [], { bodyId: box.id, faceId: 'gone' }, [box])).toBeNull();
  });
});
