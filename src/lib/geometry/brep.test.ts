import { describe, it, expect } from 'vitest';
import { createExtrude, createBox, createBoundingBoxBody, createCylinder, createSphere, createCone, createTorus, createWedge, createPrism, createTube, computeBoundingBox, computeBoundingSphere, computeVolume, computeVolumetricCentroid, computeCenterOfMassOffset, computeMassProperties, computePrincipalMoments, computeMomentOfInertiaAboutAxis, createRevolve, findBoundaryLoops } from './brep';
import { mergeBodies } from './operations';
import { computeTopology, computeMeshGenus, checkNormalConsistency, checkManifold, computeTotalEdgeLength, computeSymmetry, computeElongation, computeConvexity, computeThickness, computeSolidity } from './brep';

describe('computeSolidity', () => {
  it('reports convex solids as fully solid with no cavities', () => {
    for (const make of [
      () => createBox(10, 10, 10),
      () => createSphere(5, 24),
      () => createCylinder(5, 10, 32),
    ]) {
      const s = computeSolidity(make());
      expect(s.solidity).toBeCloseTo(1, 6);
      expect(s.isSolid).toBe(true);
      expect(s.voidRatio).toBeCloseTo(0, 6);
      expect(s.internalCavities).toBe(0);
    }
  });

  it('keeps solidity in [0,1] for a non-convex part with no phantom cavities', () => {
    const s = computeSolidity(createTorus(10, 3, 32, 16));
    expect(s.solidity).toBeGreaterThan(0);
    expect(s.solidity).toBeLessThanOrEqual(1);
    // A torus is one connected surface — no enclosed voids.
    expect(s.internalCavities).toBe(0);
  });
});

describe('computeThickness', () => {
  it('measures wall-to-wall distance by inward ray casting', () => {
    // Solid 10×20×10: the smallest cross dimension is 10, the largest 20.
    const t = computeThickness(createBox(10, 20, 10));
    expect(t.minThickness).toBeCloseTo(10, 2);
    expect(t.maxThickness).toBeCloseTo(20, 2);
    expect(t.isThin).toBe(false);
  });

  it('flags a thin slab as thin (and finds its true thickness)', () => {
    const t = computeThickness(createBox(1, 50, 50));
    expect(t.minThickness).toBeCloseTo(1, 3); // the 1mm wall, not 50
    expect(t.isThin).toBe(true);
    expect(t.thinRegions).toBeGreaterThan(0);
  });
});

describe('createTube', () => {
  it('builds a watertight tube with the annular-ring volume', () => {
    const outer = 10;
    const inner = 6;
    const height = 5;
    const tube = createTube(outer, inner, height, 64);
    const m = checkManifold(tube);
    expect(m.isManifold).toBe(true);
    expect(m.boundaryEdges).toBe(0);
    // V = π(R² − r²)·h, faceted slightly under the ideal.
    const ideal = Math.PI * (outer * outer - inner * inner) * height;
    const vol = Math.abs(computeVolume(tube));
    expect(vol).toBeGreaterThan(ideal * 0.97);
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
  });

  it('rejects inner ≥ outer and non-positive dimensions', () => {
    expect(() => createTube(5, 5, 10)).toThrow();
    expect(() => createTube(5, 8, 10)).toThrow();
    expect(() => createTube(10, 6, 0)).toThrow();
  });
});

describe('createPrism', () => {
  it('builds a watertight regular prism with the polygon-area volume', () => {
    const sides = 6;
    const radius = 10;
    const height = 5;
    const hex = createPrism(sides, radius, height);
    const m = checkManifold(hex);
    expect(m.isManifold).toBe(true);
    expect(m.boundaryEdges).toBe(0);
    // Regular polygon area = ½·n·r²·sin(2π/n).
    const area = 0.5 * sides * radius * radius * Math.sin((2 * Math.PI) / sides);
    expect(Math.abs(computeVolume(hex))).toBeCloseTo(area * height, 3);
  });

  it('rejects fewer than 3 sides and non-positive dimensions', () => {
    expect(() => createPrism(2, 10, 5)).toThrow();
    expect(() => createPrism(6, 0, 5)).toThrow();
    expect(() => createPrism(6, 10, -1)).toThrow();
  });
});

describe('computeMassProperties', () => {
  it('matches the closed-form inertia tensor of a solid box', () => {
    const dx = 20;
    const dy = 10;
    const dz = 20;
    const mp = computeMassProperties(createBox(dx, dy, dz), 1);
    const m = dx * dy * dz; // density 1
    expect(mp.volume).toBeCloseTo(m, 4);
    expect(mp.mass).toBeCloseTo(m, 4);
    // Closed form for a centered box: Ixx = m(dy²+dz²)/12, etc.
    expect(mp.inertia.ixx).toBeCloseTo((m * (dy * dy + dz * dz)) / 12, 2);
    expect(mp.inertia.iyy).toBeCloseTo((m * (dx * dx + dz * dz)) / 12, 2);
    expect(mp.inertia.izz).toBeCloseTo((m * (dx * dx + dy * dy)) / 12, 2);
    // Symmetric box → no products of inertia.
    expect(mp.inertia.ixy).toBeCloseTo(0, 4);
    expect(mp.inertia.iyz).toBeCloseTo(0, 4);
    expect(mp.inertia.ixz).toBeCloseTo(0, 4);
  });

  it('scales mass and inertia linearly with density', () => {
    const box = createBox(10, 10, 10);
    const a = computeMassProperties(box, 1);
    const b = computeMassProperties(box, 2.5);
    expect(b.mass).toBeCloseTo(a.mass * 2.5, 4);
    expect(b.inertia.ixx).toBeCloseTo(a.inertia.ixx * 2.5, 2);
  });

  it('inertia about the CoM is invariant under translation', () => {
    const box = createBox(8, 12, 6);
    const at0 = computeMassProperties(box, 1);
    const moved = {
      ...box,
      vertices: box.vertices.map((v) => ({ x: v.x + 100, y: v.y - 50, z: v.z + 7 })),
      faces: box.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => ({ x: v.x + 100, y: v.y - 50, z: v.z + 7 })) })),
    };
    const shifted = computeMassProperties(moved, 1);
    expect(shifted.inertia.ixx).toBeCloseTo(at0.inertia.ixx, 2);
    expect(shifted.inertia.izz).toBeCloseTo(at0.inertia.izz, 2);
  });
});

describe('computeMomentOfInertiaAboutAxis', () => {
  it('matches the inertia-tensor diagonal for the coordinate axes', () => {
    const box = createBox(20, 10, 20);
    const i = computeMassProperties(box, 1).inertia;
    expect(computeMomentOfInertiaAboutAxis(box, { x: 1, y: 0, z: 0 })).toBeCloseTo(i.ixx, 4);
    expect(computeMomentOfInertiaAboutAxis(box, { x: 0, y: 1, z: 0 })).toBeCloseTo(i.iyy, 4);
    expect(computeMomentOfInertiaAboutAxis(box, { x: 0, y: 0, z: 1 })).toBeCloseTo(i.izz, 4);
    // Axis length shouldn't matter — only direction.
    expect(computeMomentOfInertiaAboutAxis(box, { x: 0, y: 5, z: 0 })).toBeCloseTo(i.iyy, 4);
  });

  it('returns 0 for a zero-length axis', () => {
    expect(computeMomentOfInertiaAboutAxis(createBox(10, 10, 10), { x: 0, y: 0, z: 0 })).toBe(0);
  });
});

describe('computePrincipalMoments', () => {
  it('an axis-aligned box has principal moments equal to its tensor diagonal', () => {
    const dx = 20;
    const dy = 10;
    const dz = 20;
    const m = dx * dy * dz;
    const pm = computePrincipalMoments(createBox(dx, dy, dz), 1);
    // Sorted descending: iyy is the largest for this box.
    const expected = [
      (m * (dx * dx + dz * dz)) / 12, // iyy
      (m * (dy * dy + dz * dz)) / 12, // ixx
      (m * (dx * dx + dy * dy)) / 12, // izz
    ].sort((a, b) => b - a);
    expect(pm.moments[0]).toBeCloseTo(expected[0]!, 1);
    expect(pm.moments[1]).toBeCloseTo(expected[1]!, 1);
    expect(pm.moments[2]).toBeCloseTo(expected[2]!, 1);
    // Radius of gyration k = sqrt(I/m).
    expect(pm.radiiOfGyration[0]).toBeCloseTo(Math.sqrt(expected[0]! / m), 4);
  });

  it('a cube has three equal principal moments (m·L²/6)', () => {
    const L = 10;
    const m = L ** 3;
    const pm = computePrincipalMoments(createBox(L, L, L), 1);
    const expected = (m * L * L) / 6;
    for (const mom of pm.moments) expect(mom).toBeCloseTo(expected, 1);
  });
});

describe('computeConvexity', () => {
  it('convex primitives are convex, the torus is not', () => {
    for (const make of [
      () => createBox(10, 10, 10),
      () => createSphere(5, 24),
      () => createCylinder(5, 10, 32),
      () => createCone(5, 0, 10, 32),
      () => createWedge(10, 6, 4),
    ]) {
      expect(computeConvexity(make()).isConvex).toBe(true);
    }
    expect(computeConvexity(createTorus(10, 3, 32, 16)).isConvex).toBe(false);
  });
});

describe('computeElongation', () => {
  it('a plate is flat, a rod is elongated (not flat), a cube is neither', () => {
    const plate = computeElongation(createBox(40, 2, 40)); // thin in Y
    expect(plate.isFlat).toBe(true);

    const rod = computeElongation(createBox(40, 10, 10)); // long, square section
    expect(rod.isElongated).toBe(true);
    expect(rod.isFlat).toBe(false);

    const cube = computeElongation(createBox(10, 10, 10));
    expect(cube.isElongated).toBe(false);
    expect(cube.isFlat).toBe(false);
  });
});

describe('computeSymmetry', () => {
  it('a box is symmetric on all three axes', () => {
    const s = computeSymmetry(createBox(10, 20, 10));
    expect(s.hasXSymmetry).toBe(true);
    expect(s.hasYSymmetry).toBe(true);
    expect(s.hasZSymmetry).toBe(true);
    expect(s.symmetryScore).toBeCloseTo(1, 5);
  });

  it('a wedge is symmetric only across the depth (Z) axis', () => {
    const s = computeSymmetry(createWedge(10, 6, 4));
    expect(s.hasZSymmetry).toBe(true);
    expect(s.hasXSymmetry).toBe(false); // the slope breaks X symmetry
    expect(s.hasYSymmetry).toBe(false);
  });
});

describe('computeTotalEdgeLength', () => {
  it('a box has 12 edges summing to 12 × side length', () => {
    const box = createBox(10, 10, 10);
    expect(box.edges).toHaveLength(12);
    expect(computeTotalEdgeLength(box)).toBeCloseTo(120, 5); // 12 × 10
  });
});

describe('primitives are manifold with no isolated vertices', () => {
  const cases: [string, () => import('./types').SolidBody][] = [
    ['box', () => createBox(10, 10, 10)],
    ['cylinder', () => createCylinder(5, 10, 32)],
    ['sphere', () => createSphere(5, 16)],
    ['cone', () => createCone(5, 0, 10, 32)],
    ['torus', () => createTorus(10, 3, 32, 16)],
    ['wedge', () => createWedge(10, 6, 4)],
  ];
  for (const [name, make] of cases) {
    it(`${name} is watertight manifold`, () => {
      const m = checkManifold(make());
      expect(m.isManifold).toBe(true);
      expect(m.boundaryEdges).toBe(0);
      expect(m.nonManifoldEdges).toBe(0);
      expect(m.isolatedVertices).toBe(0); // apex/poles are used by faces
    });
  }
});

describe('primitives have consistent outward normals', () => {
  // Edge-orientation based, so this holds for the non-convex torus too.
  const cases: [string, () => import('./types').SolidBody][] = [
    ['box', () => createBox(10, 10, 10)],
    ['cylinder', () => createCylinder(5, 10, 32)],
    ['sphere', () => createSphere(5, 16)],
    ['cone', () => createCone(5, 0, 10, 32)],
    ['torus', () => createTorus(10, 3, 32, 16)],
    ['wedge', () => createWedge(10, 6, 4)],
  ];
  for (const [name, make] of cases) {
    it(`${name} normals all point outward`, () => {
      const nc = checkNormalConsistency(make());
      expect(nc.consistent).toBe(true);
      expect(nc.inwardFaces).toBe(0);
    });
  }
});

describe('topology', () => {
  it('a box is genus 0 and sphere-like (Euler χ = 2)', () => {
    const topo = computeTopology(createBox(10, 10, 10));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
    expect(topo.isSphereLike).toBe(true);
  });

  it('a torus is genus 1 with one handle (Euler χ = 0)', () => {
    const g = computeMeshGenus(createTorus(10, 3, 32, 16));
    expect(g.eulerCharacteristic).toBe(0);
    expect(g.genus).toBe(1);
    expect(g.handles).toBe(1);
    expect(g.isOrientable).toBe(true);
  });
});
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

  it('rejects non-positive or non-finite dimensions', () => {
    expect(() => createBox(0, 1, 1)).toThrow('positive');
    expect(() => createBox(-1, 1, 1)).toThrow('positive');
    expect(() => createBox(NaN, 1, 1)).toThrow('positive');
    expect(() => createBox(Infinity, 1, 1)).toThrow('positive');
  });
});

describe('createBoundingBoxBody', () => {
  it('encloses the body with the given margin', () => {
    const part = createBox(10, 20, 30);
    const stock = createBoundingBoxBody(part, 2);
    const bb = computeBoundingBox(stock);
    expect(stock.name).toBe('Stock');
    expect(bb.max.x - bb.min.x).toBeCloseTo(14, 5); // 10 + 2·2
    expect(bb.max.y - bb.min.y).toBeCloseTo(24, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(34, 5);
    // The stock fully contains the part's bounding box.
    const pb = computeBoundingBox(part);
    expect(bb.min.x).toBeLessThanOrEqual(pb.min.x);
    expect(bb.max.y).toBeGreaterThanOrEqual(pb.max.y);
  });

  it('rejects a negative margin', () => {
    expect(() => createBoundingBoxBody(createBox(1, 1, 1), -1)).toThrow('Margin');
  });
});

describe('computeVolumetricCentroid', () => {
  it('equals the geometric center for a symmetric box', () => {
    const c = computeVolumetricCentroid(createBox(10, 10, 10));
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.y).toBeCloseTo(5, 5); // box spans y∈[0,10]
    expect(c.z).toBeCloseTo(0, 5);
  });

  it('is mass-weighted across unequal merged bodies', () => {
    // 20³ box at origin (V=8000) + 10³ box centered at x=100 (V=1000).
    const big = createBox(20, 20, 20); // x∈[-10,10], centroid x=0
    const small = createBox(10, 10, 10);
    const shifted = {
      ...small,
      vertices: small.vertices.map((v) => ({ ...v, x: v.x + 100 })),
      faces: small.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => ({ ...v, x: v.x + 100 })) })),
    };
    const merged = mergeBodies([big, shifted]);
    const c = computeVolumetricCentroid(merged);
    // Mass-weighted: (0·8000 + 100·1000) / 9000 ≈ 11.1 (not the 50 a vertex avg gives).
    expect(c.x).toBeCloseTo((100 * 1000) / 9000, 1);
  });
});

describe('computeCenterOfMassOffset (volumetric)', () => {
  it('places a cone CoM at h/4 from the base, below the bbox center', () => {
    const cone = createCone(5, 0, 12, 64); // base y=0, apex y=12
    const info = computeCenterOfMassOffset(cone);
    // Solid cone CoM is h/4 = 3 above the base; bbox center is at y=6.
    expect(info.centroid.y).toBeGreaterThan(2.8);
    expect(info.centroid.y).toBeLessThan(3.2);
    expect(info.offset.y).toBeCloseTo(-3, 0); // 3 - 6
  });
});

describe('computeBoundingSphere', () => {
  it('encloses all vertices; exact half-diagonal for a centered box', () => {
    const box = createBox(10, 10, 10); // corners at (±5,±5,±5)
    const { center, radius } = computeBoundingSphere(box);
    expect(center.x).toBeCloseTo(0, 5);
    expect(radius).toBeCloseTo(Math.sqrt(75), 5); // √(5²·3)
    for (const v of box.vertices) {
      const d = Math.hypot(v.x - center.x, v.y - center.y, v.z - center.z);
      expect(d).toBeLessThanOrEqual(radius + 1e-9);
    }
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

  it('a full revolution welds its seam into a manifold mesh', () => {
    // The seam ring must reuse ring 0 rather than a coincident duplicate, or
    // the start/end profile edges are each used by a single face (non-manifold).
    const full = checkManifold(createRevolve({ profile: rect, axis: axisY, angle: Math.PI * 2 }));
    expect(full.isManifold).toBe(true);
    expect(full.boundaryEdges).toBe(0);
    // A partial revolution stays manifold too (its open ends are capped).
    const half = checkManifold(createRevolve({ profile: rect, axis: axisY, angle: Math.PI }));
    expect(half.isManifold).toBe(true);
    expect(half.boundaryEdges).toBe(0);
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
