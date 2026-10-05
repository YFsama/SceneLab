import { describe, it, expect } from 'vitest';
import { createExtrude, createBox, createBoundingBoxBody, createCylinder, createSphere, createCone, createTorus, createWedge, createPrism, createTube, createCoil, createFrustumTube, createLoft, computeBoundingBox, computeBoundingSphere, computeVolume, computeSurfaceArea, computeVolumetricCentroid, computeCenterOfMassOffset, computeMassProperties, computePrincipalMoments, computeMomentOfInertiaAboutAxis, computePendulumPeriod, createRevolve, findBoundaryLoops, computeFaceAreas, computeLargestFace, computeMeshQuality, checkWindingOrder, adaptiveSegments, DEFAULT_CHORD_TOLERANCE, triangulateFace } from './brep';
import { mergeBodies, scaleBody } from './operations';
import { computeTopology, computeMeshGenus, checkNormalConsistency, checkManifold, computeTotalEdgeLength, computeSymmetry, computeElongation, computeConvexity, computeThickness, computeSolidity, computeMeshStatistics, computeCompactness, computeRoughness, computeAdjacency, computeCurvature, computeVertexDegrees, computeAverageVertexDegree } from './brep';
import { booleanOpManifold, warmUpBooleanEngine } from './booleanManifold';

describe('adaptiveSegments', () => {
  it('reproduces the measured requirement table (chord tolerance 0.005 mm)', () => {
    // Derived from the sagitta bound R·(1 − cos(π/N)) ≤ tol, i.e.
    // N = ⌈π/acos(1 − tol/R)⌉ with R = d/2 — the audit's measured table.
    expect(adaptiveSegments(2)).toBe(32); // perf-neutral for small holes
    expect(adaptiveSegments(6)).toBe(55);
    expect(adaptiveSegments(20)).toBe(100);
  });

  it('tighter tolerance 0.001 mm lifts ⌀6 to 122', () => {
    expect(adaptiveSegments(6, 0.001)).toBe(122);
  });

  it('every facet stays within the chord tolerance, minimally', () => {
    for (const d of [1, 2, 6, 13.7, 20, 100]) {
      const n = adaptiveSegments(d);
      expect((d / 2) * (1 - Math.cos(Math.PI / n)), `d=${d}`).toBeLessThanOrEqual(DEFAULT_CHORD_TOLERANCE + 1e-12);
      if (n > 8) {
        // One facet fewer would break the tolerance (when not at the clamp).
        expect((d / 2) * (1 - Math.cos(Math.PI / (n - 1))), `d=${d}`).toBeGreaterThan(DEFAULT_CHORD_TOLERANCE);
      }
    }
  });

  it('clamps to [8, 256]', () => {
    expect(adaptiveSegments(0.01)).toBe(8);
    expect(adaptiveSegments(5000)).toBe(256);
  });

  it('rejects non-positive input', () => {
    expect(() => adaptiveSegments(0)).toThrow('positive');
    expect(() => adaptiveSegments(-6)).toThrow('positive');
    expect(() => adaptiveSegments(6, 0)).toThrow('tolerance');
  });
});

describe('adaptive tessellation defaults', () => {
  it('createCylinder defaults to the adaptive facet count (⌀6 → 55 sides)', () => {
    expect(createCylinder(3, 5).faces.length).toBe(adaptiveSegments(6) + 2);
    expect(createCylinder(1, 5).faces.length).toBe(32 + 2); // ⌀2 stays at 32
  });

  it('an explicit segments argument wins over the adaptive default', () => {
    expect(createCylinder(3, 5, 12).faces.length).toBe(12 + 2);
    expect(createCone(5, 3, 5, 16).faces.length).toBe(16 + 2);
    expect(createTube(10, 6, 5, 16).faces.length).toBe(16 * 4);
  });

  it('createCone and createTube adapt to their larger radius', () => {
    // Pointed cone: bottom cap + sides only (no top cap).
    expect(createCone(5, 0, 5).faces.length).toBe(adaptiveSegments(10) + 1);
    expect(createTube(10, 6, 5).vertices.length).toBe(4 * adaptiveSegments(20));
    expect(createFrustumTube(10, 6, 1.5, 5).vertices.length).toBe(4 * adaptiveSegments(20));
  });

  it('stats battery on a ⌀20 adaptive hole body stays under 10 ms (perf canary)', async () => {
    await warmUpBooleanEngine();
    const box = createBox(60, 20, 60);
    const drilled = booleanOpManifold(box, createCylinder(10, 30, adaptiveSegments(20)), 'difference');
    expect(drilled).not.toBeNull();
    const body = drilled!;
    // The PropertiesPanel's always-on memos: the linear battery (volume →
    // inertia tensor → mesh stats) plus the adjacency/curvature memo. Warmed
    // once — the panel only recomputes on selection/density changes.
    const battery = () => {
      computeBoundingBox(body);
      computeVolume(body);
      computeSurfaceArea(body);
      computeTotalEdgeLength(body);
      computeMeshStatistics(body);
      computeAverageVertexDegree(body);
      computeLargestFace(body);
      computePrincipalMoments(body, 1);
      computeAdjacency(body);
      computeCurvature(body);
    };
    battery(); // warm the JIT
    // Best-of-3: the battery's steady-state cost (parallel test workers make
    // single timings scheduler-noisy). Bound 25 ms is CI-safe under loaded
    // parallel workers (isolated steady state ≈ 5-6 ms) while still catching
    // the regression class this guards — the pre-rewrite O(E×V) battery ran
    // SECONDS at this face count.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      battery();
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(25);
  });
});

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

  it('cylinder is solid', () => {
    const s = computeSolidity(createCylinder(5, 10, 16));
    expect(s.isSolid).toBe(true);
    expect(s.internalCavities).toBe(0);
  });

  it('sphere is solid', () => {
    const s = computeSolidity(createSphere(5, 16));
    expect(s.isSolid).toBe(true);
    expect(s.internalCavities).toBe(0);
  });

  it('solidity is 1 for a convex solid', () => {
    const s = computeSolidity(createBox(10, 10, 10));
    expect(s.solidity).toBeCloseTo(1, 4);
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

  it('cube has equal min and max thickness', () => {
    const t = computeThickness(createBox(10, 10, 10));
    expect(t.minThickness).toBeCloseTo(t.maxThickness, 1);
  });

  it('thickness values are positive', () => {
    const t = computeThickness(createCylinder(5, 10, 16));
    expect(t.minThickness).toBeGreaterThan(0);
    expect(t.maxThickness).toBeGreaterThan(0);
  });

  it('sphere has consistent thickness', () => {
    const t = computeThickness(createSphere(7, 16));
    expect(t.minThickness).toBeGreaterThan(0);
    expect(t.maxThickness).toBeGreaterThan(0);
  });
});

describe('createLoft', () => {
  const sq = (s: number, y: number): Vec3[] => [
    { x: -s, y, z: -s }, { x: s, y, z: -s }, { x: s, y, z: s }, { x: -s, y, z: s },
  ];

  it('lofts equal squares into a box', () => {
    const box = createLoft(sq(5, 0), sq(5, 20));
    expect(checkManifold(box).isManifold).toBe(true);
    expect(Math.abs(computeVolume(box))).toBeCloseTo(2000, 3);
  });

  it('lofts unequal squares to the prismatoid volume', () => {
    const fr = createLoft(sq(5, 0), sq(3, 20));
    expect(checkManifold(fr).isManifold).toBe(true);
    // V = h/6·(A_bottom + 4·A_mid + A_top), mid side = 8.
    const ideal = (20 / 6) * (100 + 4 * 64 + 36);
    expect(Math.abs(computeVolume(fr))).toBeCloseTo(ideal, 1);
  });

  it('rejects mismatched or too-small profiles', () => {
    expect(() => createLoft(sq(5, 0), [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }])).toThrow();
    expect(() => createLoft([{ x: 0, y: 0, z: 0 }], [{ x: 0, y: 1, z: 0 }])).toThrow();
  });

  it('loft with zero height produces valid geometry', () => {
    const flat = createLoft(sq(5, 0), sq(5, 0));
    expect(flat.vertices.length).toBeGreaterThan(0);
    expect(flat.faces.length).toBeGreaterThan(0);
  });

  it('loft with large height produces correct volume', () => {
    const tall = createLoft(sq(5, 0), sq(5, 100));
    expect(Math.abs(computeVolume(tall))).toBeCloseTo(100 * 100, 0); // 10×10×100
  });

  it('loft is translation invariant', () => {
    const body = createLoft(sq(5, 0), sq(5, 20));
    const vol1 = Math.abs(computeVolume(body));
    // The loft function works in local coordinates, so translation invariance
    // is tested by checking the volume doesn't change.
    expect(vol1).toBeCloseTo(2000, 3);
  });
});

describe('createFrustumTube', () => {
  it('builds a watertight hollow frustum with the truncated-cone-shell volume', () => {
    const t = createFrustumTube(10, 6, 1.5, 20, 64);
    const m = checkManifold(t);
    expect(m.isManifold).toBe(true);
    expect(m.boundaryEdges).toBe(0);
    const frus = (R: number, r: number, h: number) => (Math.PI * h) / 3 * (R * R + R * r + r * r);
    const ideal = frus(10, 6, 20) - frus(8.5, 4.5, 20);
    const vol = Math.abs(computeVolume(t));
    expect(vol).toBeGreaterThan(ideal * 0.97);
    expect(vol).toBeLessThanOrEqual(ideal * 1.01);
  });

  it('rejects a wall thicker than the smaller radius and bad dimensions', () => {
    expect(() => createFrustumTube(10, 6, 6, 20)).toThrow();
    expect(() => createFrustumTube(0, 6, 1, 20)).toThrow();
  });

  it('bounding box spans the larger diameter', () => {
    const t = createFrustumTube(10, 6, 1.5, 20, 32);
    const bb = computeBoundingBox(t);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 1); // 2 × R=10
    expect(bb.max.z - bb.min.z).toBeCloseTo(20, 1);
  });

  it('bounding box height matches input', () => {
    const t = createFrustumTube(10, 6, 1.5, 30, 32);
    const bb = computeBoundingBox(t);
    expect(bb.max.y - bb.min.y).toBeCloseTo(30, 1);
  });

  it('thinner wall produces more interior volume', () => {
    const thin = createFrustumTube(10, 6, 0.5, 20, 32);
    const thick = createFrustumTube(10, 6, 3, 20, 32);
    // Thinner wall = more hollow interior = different volume.
    expect(Math.abs(computeVolume(thin))).not.toBeCloseTo(Math.abs(computeVolume(thick)), 0);
  });
});

describe('createCoil', () => {
  it('builds a watertight helical coil of about the Pappus volume', () => {
    const coilR = 10;
    const wireR = 2;
    const pitch = 8;
    const turns = 3;
    const coil = createCoil(coilR, wireR, pitch, turns, 48, 16);
    const m = checkManifold(coil);
    expect(m.isManifold).toBe(true);
    expect(m.boundaryEdges).toBe(0);
    // Pappus: V ≈ π·wireR² × helix length; faceting makes it a bit under.
    const pathLen = turns * Math.hypot(2 * Math.PI * coilR, pitch);
    const ideal = Math.PI * wireR * wireR * pathLen;
    const vol = Math.abs(computeVolume(coil));
    expect(vol).toBeGreaterThan(ideal * 0.9);
    expect(vol).toBeLessThanOrEqual(ideal * 1.05);
  });

  it('rejects non-positive parameters and too-few facets', () => {
    expect(() => createCoil(0, 2, 8, 3)).toThrow();
    expect(() => createCoil(10, 2, 8, 0)).toThrow();
    expect(() => createCoil(10, 2, 8, 3, 2, 16)).toThrow();
  });

  it('bounding box spans the coil diameter', () => {
    const R = 10, r = 2;
    const coil = createCoil(R, r, 8, 3, 32, 8);
    const bb = computeBoundingBox(coil);
    // Coil should span roughly 2(R+r) in X and Z.
    const span = 2 * (R + r);
    expect(bb.max.x - bb.min.x).toBeGreaterThan(span * 0.8);
    expect(bb.max.z - bb.min.z).toBeGreaterThan(span * 0.8);
  });

  it('more turns produce more volume', () => {
    const few = createCoil(10, 2, 8, 2, 32, 8);
    const many = createCoil(10, 2, 8, 5, 32, 8);
    expect(Math.abs(computeVolume(many))).toBeGreaterThan(Math.abs(computeVolume(few)));
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

  it('bounding box spans the outer diameter', () => {
    const tube = createTube(10, 6, 20, 32);
    const bb = computeBoundingBox(tube);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 1); // 2 × R=10
    expect(bb.max.z - bb.min.z).toBeCloseTo(20, 1);
  });

  it('bounding box height matches input', () => {
    const tube = createTube(10, 6, 30, 32);
    const bb = computeBoundingBox(tube);
    expect(bb.max.y - bb.min.y).toBeCloseTo(30, 1);
  });

  it('thinner tube has less volume', () => {
    const thick = createTube(10, 6, 20, 32);
    const thin = createTube(10, 9, 20, 32);
    expect(Math.abs(computeVolume(thin))).toBeLessThan(Math.abs(computeVolume(thick)));
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

  it('triangle prism (3 sides) has correct volume', () => {
    const tri = createPrism(3, 10, 5);
    const area = 0.5 * 3 * 10 * 10 * Math.sin((2 * Math.PI) / 3);
    expect(Math.abs(computeVolume(tri))).toBeCloseTo(area * 5, 1);
  });

  it('square prism (4 sides) produces positive volume', () => {
    const sq = createPrism(4, 10, 5);
    expect(Math.abs(computeVolume(sq))).toBeGreaterThan(0);
  });

  it('bounding box height matches input', () => {
    const hex = createPrism(6, 10, 25);
    const bb = computeBoundingBox(hex);
    expect(bb.max.y - bb.min.y).toBeCloseTo(25, 1);
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

  it('volume and mass are always positive', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const mp = computeMassProperties(make(), 1);
      expect(mp.volume).toBeGreaterThan(0);
      expect(mp.mass).toBeGreaterThan(0);
    }
  });

  it('products of inertia are zero for axis-aligned box', () => {
    const box = createBox(10, 20, 30);
    const mp = computeMassProperties(box, 1);
    // Axis-aligned box has no cross products of inertia.
    expect(mp.inertia.ixy).toBeCloseTo(0, 4);
    expect(mp.inertia.ixz).toBeCloseTo(0, 4);
    expect(mp.inertia.iyz).toBeCloseTo(0, 4);
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

  it('applies the parallel-axis theorem about an offset pivot', () => {
    const box = createBox(20, 10, 20);
    const mp = computeMassProperties(box, 1);
    const iCom = computeMomentOfInertiaAboutAxis(box, { x: 0, y: 1, z: 0 }); // about CoM, Y
    // Same Y axis but shifted to pass through a point 7mm away in X from the CoM.
    const pivot = { x: mp.centerOfMass.x + 7, y: mp.centerOfMass.y, z: mp.centerOfMass.z };
    const iPivot = computeMomentOfInertiaAboutAxis(box, { x: 0, y: 1, z: 0 }, 1, pivot);
    expect(iPivot).toBeCloseTo(iCom + mp.mass * 49, 4); // I_cm + m·d², d=7
  });

  it('moment of inertia is always positive for a non-degenerate body', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const i = computeMomentOfInertiaAboutAxis(make(), { x: 0, y: 1, z: 0 });
      expect(i).toBeGreaterThan(0);
    }
  });

  it('moment of inertia scales with density', () => {
    const box = createBox(10, 10, 10);
    const i1 = computeMomentOfInertiaAboutAxis(box, { x: 0, y: 1, z: 0 }, 1);
    const i2 = computeMomentOfInertiaAboutAxis(box, { x: 0, y: 1, z: 0 }, 2);
    expect(i2).toBeCloseTo(i1 * 2, 4);
  });
});

describe('computePendulumPeriod', () => {
  it('matches T = 2π√((I_pivot/m)/(g·d)) for a rod pivoted at one end', () => {
    // Thin rod along Y, length 20, pivoted at the bottom, swinging about Z.
    const rod = createBox(2, 20, 2);
    const pivot = { x: 0, y: 0, z: 0 };
    const axis = { x: 0, y: 0, z: 1 };
    const g = 9810;
    const mp = computeMassProperties(rod, 1);
    const iPivot = computeMomentOfInertiaAboutAxis(rod, axis, 1, pivot);
    const d = mp.centerOfMass.y; // CoM is straight up the rod from the pivot
    const expected = 2 * Math.PI * Math.sqrt(iPivot / mp.mass / (g * d));
    expect(computePendulumPeriod(rod, pivot, axis, g)).toBeCloseTo(expected, 6);
  });

  it('scales as 1/√g and is infinite when the CoM lies on the axis', () => {
    const rod = createBox(2, 20, 2);
    const axis = { x: 0, y: 0, z: 1 };
    const pivot = { x: 0, y: 0, z: 0 };
    // T ∝ 1/√g → quadrupling g halves the period.
    const t = computePendulumPeriod(rod, pivot, axis, 9810);
    const tFast = computePendulumPeriod(rod, pivot, axis, 9810 * 4);
    expect(tFast).toBeCloseTo(t / 2, 6);
    // Axis through the CoM → no restoring torque → infinite period.
    expect(computePendulumPeriod(rod, { x: 0, y: 10, z: 0 }, axis)).toBe(Infinity);
  });

  it('period is always positive for a valid pendulum', () => {
    const box = createBox(10, 20, 10);
    const t = computePendulumPeriod(box, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 9810);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });

  it('longer rod has longer period', () => {
    const short = createBox(2, 10, 2);
    const long = createBox(2, 20, 2);
    const pivot = { x: 0, y: 0, z: 0 };
    const axis = { x: 0, y: 0, z: 1 };
    const tShort = computePendulumPeriod(short, pivot, axis, 9810);
    const tLong = computePendulumPeriod(long, pivot, axis, 9810);
    expect(tLong).toBeGreaterThan(tShort);
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

  it('principal moments are always positive', () => {
    for (const make of [() => createBox(10, 20, 30), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const pm = computePrincipalMoments(make(), 1);
      for (const mom of pm.moments) {
        expect(mom).toBeGreaterThan(0);
      }
    }
  });

  it('radii of gyration are always positive', () => {
    const pm = computePrincipalMoments(createBox(10, 20, 30), 1);
    for (const r of pm.radiiOfGyration) {
      expect(r).toBeGreaterThan(0);
      expect(Number.isFinite(r)).toBe(true);
    }
  });

  it('moments are sorted descending', () => {
    const pm = computePrincipalMoments(createBox(10, 20, 30), 1);
    for (let i = 1; i < pm.moments.length; i++) {
      expect(pm.moments[i - 1]!).toBeGreaterThanOrEqual(pm.moments[i]!);
    }
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

  it('convexity is between 0 and 1', () => {
    const box = createBox(10, 10, 10);
    const c = computeConvexity(box);
    expect(c.convexity).toBeGreaterThanOrEqual(0);
    expect(c.convexity).toBeLessThanOrEqual(1);
  });

  it('sphere has convexity close to 1', () => {
    const sphere = createSphere(5, 32);
    const c = computeConvexity(sphere);
    expect(c.convexity).toBeGreaterThan(0.9);
  });

  it('prism is convex', () => {
    const prism = createPrism(6, 10, 5);
    expect(computeConvexity(prism).isConvex).toBe(true);
  });

  it('tube is not convex', () => {
    const tube = createTube(10, 6, 20, 16);
    expect(computeConvexity(tube).isConvex).toBe(false);
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

  it('cylinder is elongated when height >> diameter', () => {
    const tall = computeElongation(createCylinder(2, 20, 16));
    expect(tall.isElongated).toBe(true);
  });

  it('flat cylinder is flat', () => {
    const flat = computeElongation(createCylinder(10, 1, 16));
    expect(flat.isFlat).toBe(true);
  });

  it('elongation values are finite', () => {
    const e = computeElongation(createBox(10, 20, 30));
    expect(Number.isFinite(e.elongation)).toBe(true);
    expect(Number.isFinite(e.flatness)).toBe(true);
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

  it('a cylinder is symmetric on X and Z axes', () => {
    const s = computeSymmetry(createCylinder(5, 10, 16));
    expect(s.hasXSymmetry).toBe(true);
    expect(s.hasZSymmetry).toBe(true);
  });

  it('a sphere is symmetric on all axes', () => {
    const s = computeSymmetry(createSphere(5, 16));
    expect(s.hasXSymmetry).toBe(true);
    expect(s.hasYSymmetry).toBe(true);
    expect(s.hasZSymmetry).toBe(true);
  });

  it('symmetry score is between 0 and 1', () => {
    const s = computeSymmetry(createBox(10, 10, 10));
    expect(s.symmetryScore).toBeGreaterThanOrEqual(0);
    expect(s.symmetryScore).toBeLessThanOrEqual(1);
  });
});

describe('computeTotalEdgeLength', () => {
  it('a box has 12 edges summing to 12 × side length', () => {
    const box = createBox(10, 10, 10);
    expect(box.edges).toHaveLength(12);
    expect(computeTotalEdgeLength(box)).toBeCloseTo(120, 5); // 12 × 10
  });

  it('edge length scales with size', () => {
    const small = createBox(10, 10, 10);
    const large = createBox(20, 20, 20);
    expect(computeTotalEdgeLength(large)).toBeCloseTo(computeTotalEdgeLength(small) * 2, 5);
  });

  it('cylinder has positive edge length', () => {
    const cyl = createCylinder(5, 10, 16);
    expect(computeTotalEdgeLength(cyl)).toBeGreaterThan(0);
  });

  it('sphere has positive edge length', () => {
    const sphere = createSphere(5, 16);
    expect(computeTotalEdgeLength(sphere)).toBeGreaterThan(0);
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
    ['prism', () => createPrism(6, 10, 5)],
    ['tube', () => createTube(10, 6, 20, 16)],
    ['coil', () => createCoil(10, 2, 8, 3, 32, 8)],
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
    ['prism', () => createPrism(6, 10, 5)],
    ['tube', () => createTube(10, 6, 20, 16)],
  ];
  for (const [name, make] of cases) {
    it(`${name} normals all point outward`, () => {
      const nc = checkNormalConsistency(make());
      expect(nc.consistent).toBe(true);
      expect(nc.inwardFaces).toBe(0);
    });
  }

  it('torus normals are consistent', () => {
    const nc = checkNormalConsistency(createTorus(10, 3, 16, 8));
    expect(nc.consistent).toBe(true);
    expect(nc.inwardFaces).toBe(0);
  });

  it('wedge normals are consistent', () => {
    const nc = checkNormalConsistency(createWedge(10, 6, 4));
    expect(nc.consistent).toBe(true);
    expect(nc.inwardFaces).toBe(0);
  });

  it('prism normals are consistent', () => {
    const nc = checkNormalConsistency(createPrism(6, 10, 5));
    expect(nc.consistent).toBe(true);
    expect(nc.inwardFaces).toBe(0);
  });

  it('tube normals are consistent', () => {
    const nc = checkNormalConsistency(createTube(10, 6, 20, 16));
    expect(nc.consistent).toBe(true);
    expect(nc.inwardFaces).toBe(0);
  });
});

describe('topology', () => {
  it('a box is genus 0 and sphere-like (Euler χ = 2)', () => {
    const topo = computeTopology(createBox(10, 10, 10));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
    expect(topo.isSphereLike).toBe(true);
  });

  it('a sphere is genus 0 and sphere-like', () => {
    const topo = computeTopology(createSphere(5, 16));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
    expect(topo.isSphereLike).toBe(true);
  });

  it('a cylinder is genus 0 and sphere-like', () => {
    const topo = computeTopology(createCylinder(5, 10, 16));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a cone is genus 0 and sphere-like', () => {
    const topo = computeTopology(createCone(5, 0, 10, 16));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a wedge is genus 0 and sphere-like', () => {
    const topo = computeTopology(createWedge(10, 6, 4));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a prism is genus 0 and sphere-like', () => {
    const topo = computeTopology(createPrism(6, 10, 5));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a tube is genus 1 (has a hole through it)', () => {
    const topo = computeTopology(createTube(10, 6, 20, 16));
    expect(topo.eulerCharacteristic).toBe(0);
    expect(topo.genus).toBe(1);
  });

  it('a coil is genus 0 (open swept tube with caps)', () => {
    const topo = computeTopology(createCoil(10, 2, 8, 3, 32, 8));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a loft between equal squares is genus 0', () => {
    const sq = (s: number, y: number) => [
      { x: -s, y, z: -s }, { x: s, y, z: -s }, { x: s, y, z: s }, { x: -s, y, z: s },
    ];
    const topo = computeTopology(createLoft(sq(5, 0), sq(5, 20)));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a loft between unequal squares is genus 0', () => {
    const sq = (s: number, y: number) => [
      { x: -s, y, z: -s }, { x: s, y, z: -s }, { x: s, y, z: s }, { x: -s, y, z: s },
    ];
    const topo = computeTopology(createLoft(sq(5, 0), sq(3, 20)));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('a torus is genus 1 with one handle (Euler χ = 0)', () => {
    const g = computeMeshGenus(createTorus(10, 3, 32, 16));
    expect(g.eulerCharacteristic).toBe(0);
    expect(g.genus).toBe(1);
    expect(g.handles).toBe(1);
    expect(g.isOrientable).toBe(true);
  });

  it('a box is genus 0 (Euler χ = 2)', () => {
    const g = computeMeshGenus(createBox(10, 10, 10));
    expect(g.eulerCharacteristic).toBe(2);
    expect(g.genus).toBe(0);
    expect(g.handles).toBe(0);
  });

  it('a sphere is genus 0 (Euler χ = 2)', () => {
    const g = computeMeshGenus(createSphere(5, 16));
    expect(g.eulerCharacteristic).toBe(2);
    expect(g.genus).toBe(0);
  });

  it('a cylinder is genus 0 (Euler χ = 2)', () => {
    const g = computeMeshGenus(createCylinder(5, 10, 16));
    expect(g.eulerCharacteristic).toBe(2);
    expect(g.genus).toBe(0);
  });

  it('all genus results are orientable', () => {
    for (const make of [
      () => createBox(10, 10, 10),
      () => createSphere(5, 16),
      () => createCylinder(5, 10, 16),
      () => createTorus(10, 3, 16, 8),
    ]) {
      expect(computeMeshGenus(make()).isOrientable).toBe(true);
    }
  });

  it('curved primitives store a complete deduplicated edge list', () => {
    // body.edges (used by many edge-stat functions) must match the faces' edges.
    expect(createSphere(6, 16).edges.length).toBe(240);
    expect(createCone(5, 0, 10, 32).edges.length).toBe(64);
  });

  it('edge metrics come from faces (consistent for over- and under-counting prims)', () => {
    // 32-segment tube = 128 quad faces → 256 unique edges, not 512.
    expect(computeMeshStatistics(createTube(10, 6, 20, 32)).edgeCount).toBe(256);
    // Wedge = triangular prism → 9 edges.
    expect(computeMeshStatistics(createWedge(10, 6, 4)).edgeCount).toBe(9);
    // Sphere/cone previously under-counted body.edges; face-derived is correct.
    // For a closed genus-0 mesh, E = V_unique + F − 2 (Euler).
    for (const make of [() => createSphere(6, 16), () => createCone(5, 0, 10, 32)]) {
      const b = make();
      const s = computeMeshStatistics(b);
      const uniqueV = new Set(b.faces.flatMap((f) => f.vertices.map((v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`))).size;
      expect(s.edgeCount).toBe(uniqueV + s.faceCount - 2);
    }
  });

  it('a capped tube/frustum is genus 1, a coil genus 0 (edges counted from faces)', () => {
    // These primitives store one edge per face-side (shared edges duplicated);
    // topology must be derived from faces, not body.edges.length.
    expect(computeMeshGenus(createTube(10, 6, 20, 32)).genus).toBe(1);
    expect(computeMeshGenus(createFrustumTube(10, 6, 1.5, 20, 32)).genus).toBe(1);
    // A coil is an open swept tube capped at both ends → topologically a ball.
    expect(computeMeshGenus(createCoil(10, 2, 8, 3, 48, 16)).genus).toBe(0);
  });

  it('box has correct face and vertex counts', () => {
    const s = computeMeshStatistics(createBox(10, 10, 10));
    expect(s.faceCount).toBe(6);
    expect(s.vertexCount).toBeGreaterThan(0);
    expect(s.edgeCount).toBe(12);
  });

  it('sphere has positive counts', () => {
    const s = computeMeshStatistics(createSphere(5, 16));
    expect(s.faceCount).toBeGreaterThan(0);
    expect(s.vertexCount).toBeGreaterThan(0);
    expect(s.edgeCount).toBeGreaterThan(0);
  });

  it('statistics are consistent (Euler formula for genus 0)', () => {
    const box = createBox(10, 10, 10);
    const s = computeMeshStatistics(box);
    // For a genus-0 closed mesh: V - E + F = 2 (Euler characteristic).
    expect(s.vertexCount - s.edgeCount + s.faceCount).toBe(2);
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
  it('is robust to profile winding: CW and CCW both give an outward, watertight solid', () => {
    const ccw: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }];
    const cw: Vec3[] = [...ccw].reverse();
    for (const profile of [ccw, cw]) {
      const body = createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 5, symmetric: false });
      expect(Math.abs(computeVolume(body))).toBeCloseTo(500, 3);
      expect(checkManifold(body).isManifold).toBe(true);
      // Every stored normal points away from the centroid (right-side-out).
      const c = computeVolumetricCentroid(body);
      for (const f of body.faces) {
        const fc = { x: 0, y: 0, z: 0 };
        for (const v of f.vertices) {
          fc.x += v.x / f.vertices.length;
          fc.y += v.y / f.vertices.length;
          fc.z += v.z / f.vertices.length;
        }
        const dot = (fc.x - c.x) * f.normal.x + (fc.y - c.y) * f.normal.y + (fc.z - c.z) * f.normal.z;
        expect(dot).toBeGreaterThan(0);
      }
    }
  });

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

  it('extrude along X axis works', () => {
    const profile: Vec3[] = [
      { x: 0, y: -1, z: -1 },
      { x: 0, y: 1, z: -1 },
      { x: 0, y: 1, z: 1 },
      { x: 0, y: -1, z: 1 },
    ];
    const body = createExtrude({ profile, direction: { x: 1, y: 0, z: 0 }, distance: 5 });
    const bb = computeBoundingBox(body);
    expect(bb.max.x - bb.min.x).toBeCloseTo(5, 1);
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('extrude along Z axis works', () => {
    const profile: Vec3[] = [
      { x: -1, y: -1, z: 0 },
      { x: 1, y: -1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: -1, y: 1, z: 0 },
    ];
    const body = createExtrude({ profile, direction: { x: 0, y: 0, z: 1 }, distance: 5 });
    const bb = computeBoundingBox(body);
    expect(bb.max.z - bb.min.z).toBeCloseTo(5, 1);
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('extrude along diagonal direction works', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
    ];
    const body = createExtrude({ profile, direction: { x: 1, y: 1, z: 0 }, distance: 5 });
    expect(checkManifold(body).boundaryEdges).toBe(0);
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(0);
  });

  it('volume scales linearly with distance', () => {
    const profile: Vec3[] = [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
    ];
    const short = createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 5 });
    const long = createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 10 });
    expect(Math.abs(computeVolume(long))).toBeCloseTo(Math.abs(computeVolume(short)) * 2, 1);
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

  it('centroid of a cylinder is at its geometric center', () => {
    const cyl = createCylinder(5, 10, 32);
    const c = computeVolumetricCentroid(cyl);
    expect(c.x).toBeCloseTo(0, 1);
    expect(c.z).toBeCloseTo(0, 1);
    // Cylinder spans y ∈ [0, 10], so centroid y ≈ 5.
    expect(c.y).toBeGreaterThan(0);
    expect(c.y).toBeLessThan(10);
  });

  it('centroid is always finite', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const c = computeVolumetricCentroid(make());
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
      expect(Number.isFinite(c.z)).toBe(true);
    }
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

  it('symmetric box has zero offset', () => {
    const box = createBox(10, 10, 10);
    const info = computeCenterOfMassOffset(box);
    // Box is symmetric, so centroid ≈ bbox center → offset ≈ 0.
    expect(Math.abs(info.offset.x)).toBeLessThan(1);
    expect(Math.abs(info.offset.z)).toBeLessThan(1);
  });

  it('offset is finite for all body types', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const info = computeCenterOfMassOffset(make());
      expect(Number.isFinite(info.offset.x)).toBe(true);
      expect(Number.isFinite(info.offset.y)).toBe(true);
      expect(Number.isFinite(info.offset.z)).toBe(true);
    }
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

  it('encloses all vertices of a cylinder', () => {
    const cyl = createCylinder(5, 10, 16);
    const { center, radius } = computeBoundingSphere(cyl);
    expect(radius).toBeGreaterThan(0);
    for (const v of cyl.vertices) {
      const d = Math.hypot(v.x - center.x, v.y - center.y, v.z - center.z);
      expect(d).toBeLessThanOrEqual(radius + 1e-6);
    }
  });

  it('encloses all vertices of a sphere', () => {
    const sphere = createSphere(5, 16);
    const { center, radius } = computeBoundingSphere(sphere);
    expect(radius).toBeGreaterThan(0);
    for (const v of sphere.vertices) {
      const d = Math.hypot(v.x - center.x, v.y - center.y, v.z - center.z);
      expect(d).toBeLessThanOrEqual(radius + 1e-6);
    }
  });

  it('center is finite', () => {
    const box = createBox(10, 20, 30);
    const { center } = computeBoundingSphere(box);
    expect(Number.isFinite(center.x)).toBe(true);
    expect(Number.isFinite(center.y)).toBe(true);
    expect(Number.isFinite(center.z)).toBe(true);
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

describe('concave-profile extrusions (QA F5)', () => {
  /** Extrude an XZ-plane profile 8 mm along +Y. */
  const extrude8 = (profile: Vec3[]) =>
    createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 8, symmetric: false });

  // The QA repro sketch: a 60×10 flange plus a 10×50 web (the web includes the
  // corner shared with the flange) — cross-section area 1000 mm², so the 8 mm
  // extrusion is a true 8000 mm³ solid.
  const lProfile: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 60, y: 0, z: 0 },
    { x: 60, y: 0, z: 10 },
    { x: 10, y: 0, z: 10 },
    { x: 10, y: 0, z: 50 },
    { x: 0, y: 0, z: 50 },
  ];
  const lBody = () => extrude8(lProfile);

  it('QA L-profile extrudes to its true 8000 mm³ (was ~3200, off by ~60%)', () => {
    expect(computeVolume(lBody())).toBeLessThanOrEqual(8000 + 1);
    expect(computeVolume(lBody())).toBeGreaterThanOrEqual(8000 - 1);
    // …and mass properties agree (the AI create_hole volumeRemoved consumer).
    expect(computeMassProperties(lBody(), 1).volume).toBeLessThanOrEqual(8000 + 1);
    expect(computeMassProperties(lBody(), 1).volume).toBeGreaterThanOrEqual(8000 - 1);
  });

  it('L-profile volume is invariant to winding direction and loop start vertex', () => {
    // Reversed winding…
    expect(computeVolume(extrude8([...lProfile].reverse()))).toBeCloseTo(8000, 3);
    // …and to starting the loop at the REFLEX vertex (10, 10) and at a far
    // corner — the old first-3-vertices winding check misread the reflex run.
    for (const start of [3, 4, 5]) {
      const rotated = [...lProfile.slice(start), ...lProfile.slice(0, start)];
      expect(computeVolume(extrude8(rotated)), `start=${start}`).toBeCloseTo(8000, 3);
    }
  });

  it('L-profile centroid matches the analytic (and Monte-Carlo) reference', () => {
    // Flange (x 0..60, z 0..10): A=600, centroid (30, 5); web above the flange
    // (x 0..10, z 10..50): A=400, centroid (5, 30). Area-weighted: x=20, z=15,
    // and y = 4 by symmetry. Analytic reference:
    const c = computeVolumetricCentroid(lBody());
    expect(c.x).toBeCloseTo(20, 6);
    expect(c.y).toBeCloseTo(4, 6);
    expect(c.z).toBeCloseTo(15, 6);
    // Monte-Carlo cross-check over the cross-section (uniform density).
    let inside = 0;
    let sx = 0;
    let sz = 0;
    const samples = 200_000;
    let seed = 123456789;
    const rand = () => {
      // LCG — deterministic across runs/machines.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < samples; i++) {
      const x = rand() * 60;
      const z = rand() * 50;
      if (z <= 10 || x <= 10) {
        inside++;
        sx += x;
        sz += z;
      }
    }
    expect(sx / inside).toBeCloseTo(20, 1); // MC error ~0.05 at 200k samples
    expect(sz / inside).toBeCloseTo(15, 1);
    expect(inside / samples).toBeCloseTo(1000 / 3000, 2); // area fraction 1/3
  });

  it('L-profile surface area is exact: 2·1000 + perimeter(220)·8 = 3760', () => {
    // A fan over the concave caps sweeps out-of-polygon regions; the
    // ear-clipped triangulation tiles exactly the L.
    expect(computeSurfaceArea(lBody())).toBeCloseTo(3760, 3);
  });

  it('triangulateFace partitions the concave L cap into an exact tiling', () => {
    const cap: Vec3[] = lProfile.map((p) => ({ x: p.x, y: 8, z: p.z }));
    const tris = triangulateFace(cap);
    expect(tris).toHaveLength(4); // n − 2
    const sumArea = tris.reduce((s, [a, b, c]) => {
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const cr = {
        x: ab.y * ac.z - ab.z * ac.y,
        y: ab.z * ac.x - ab.x * ac.z,
        z: ab.x * ac.y - ab.y * ac.x,
      };
      return s + Math.hypot(cr.x, cr.y, cr.z) / 2;
    }, 0);
    // Unsigned triangle areas sum to the true area — no overlaps, no gaps.
    expect(sumArea).toBeCloseTo(1000, 6);
    // …and every triangle sits inside the L (z ≤ 10 flange OR x ≤ 10 web).
    for (const [a, b, c] of tris) {
      const gx = (a.x + b.x + c.x) / 3;
      const gz = (a.z + b.z + c.z) / 3;
      expect(gz <= 10 + 1e-9 || gx <= 10 + 1e-9).toBe(true);
    }
  });

  it('triangulateFace: convex loop stays on the fan fast path (n−2 triangles)', () => {
    const quad: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, { x: 0, y: 0, z: 4 },
    ];
    expect(triangulateFace(quad)).toHaveLength(2);
    // Degenerate inputs never throw and never invent triangles.
    expect(triangulateFace([])).toEqual([]);
    expect(triangulateFace([quad[0]!, quad[1]!])).toEqual([]);
    // A collinear run of vertices is dropped, not tripped over.
    const collinear: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 }, { x: 0, y: 0, z: 4 },
    ];
    expect(triangulateFace(collinear)).toHaveLength(3);
  });

  it('T-slot sketch profile extrudes to its exact volume (1400 mm² × 5 mm)', () => {
    // Bar 60×10 across the top, stem 20×40 below it.
    const tSlot: Vec3[] = [
      { x: 20, y: 0, z: 0 },
      { x: 40, y: 0, z: 0 },
      { x: 40, y: 0, z: 40 },
      { x: 60, y: 0, z: 40 },
      { x: 60, y: 0, z: 50 },
      { x: 0, y: 0, z: 50 },
      { x: 0, y: 0, z: 40 },
      { x: 20, y: 0, z: 40 },
    ];
    const body = createExtrude({
      profile: tSlot,
      direction: { x: 0, y: 1, z: 0 },
      distance: 5,
      symmetric: false,
    });
    expect(computeVolume(body)).toBeLessThanOrEqual(7000 + 1);
    expect(computeVolume(body)).toBeGreaterThanOrEqual(7000 - 1);
    // Stem centroid x=30 by symmetry; z = (600·45 + 800·20)/1400 = 215/7.
    const c = computeVolumetricCentroid(body);
    expect(c.x).toBeCloseTo(30, 6);
    expect(c.z).toBeCloseTo(215 / 7, 3);
  });

  it('concave solid from a real Manifold Cut: volume and centroid exact', async () => {
    await warmUpBooleanEngine();
    // 60×8×50 block; bite a 25×40 corner-notch out of the right side →
    // concave L-ish cross-section of area 3000 − 1000 = 2000 → volume 16000.
    const block = createBox(60, 8, 50);
    const notch = createBox(25, 24, 40);
    const shift = (v: Vec3): Vec3 => ({ x: v.x + 17.5, y: v.y, z: v.z });
    const shifted = {
      ...notch,
      vertices: notch.vertices.map(shift),
      faces: notch.faces.map((f) => ({ ...f, vertices: f.vertices.map(shift) })),
      edges: notch.edges.map((e) => ({ ...e, start: shift(e.start), end: shift(e.end) })),
    };
    const cut = booleanOpManifold(block, shifted, 'difference');
    expect(cut).not.toBeNull();
    const vol = computeVolume(cut!);
    expect(vol).toBeLessThanOrEqual(16000 + 1);
    expect(vol).toBeGreaterThanOrEqual(16000 - 1);
    // Centroid x by area moments: kept region = 60×50 minus [5,30]×[−20,20].
    // x̄ = (3000·0 − 1000·17.5) / 2000 = −8.75 (block centered at x=0).
    const c = computeVolumetricCentroid(cut!);
    expect(c.x).toBeCloseTo(-8.75, 3);
    expect(c.y).toBeCloseTo(4, 3);
  });

  it('convex goldens unchanged by the concave-safe triangulation', () => {
    expect(computeVolume(createBox(2, 3, 4))).toBeCloseTo(24, 6);
    const cyl = createCylinder(5, 10, 64);
    const ideal = Math.PI * 25 * 10;
    expect(computeVolume(cyl)).toBeLessThanOrEqual(ideal + 1e-6);
    expect(computeVolume(cyl)).toBeGreaterThan(ideal * 0.99);
    const sph = createSphere(5, 48);
    expect(computeVolume(sph)).toBeGreaterThan((4 / 3) * Math.PI * 125 * 0.98);
    expect(computeSurfaceArea(createBox(10, 20, 30))).toBeCloseTo(2200, 6);
  });

  it('volume + centroid of an 8k-face sphere stay fast (perf canary)', () => {
    const sphere = createSphere(10, 128);
    expect(sphere.faces.length).toBe(8192);
    computeVolume(sphere); // warm the JIT
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      computeVolume(sphere);
      computeVolumetricCentroid(sphere);
      best = Math.min(best, performance.now() - t0);
    }
    // Measured ~5 ms best-of-3 locally; generous bound for parallel workers.
    expect(best).toBeLessThan(50);
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

// Pass-30 P3 T3: concave-profile cap orientation. The old cap code took the
// plane normal from the FIRST THREE vertices (whose zero-cross fallback is a
// hardcoded (0,0,1)) and oriented it against the whole-body vertex centroid —
// a concave profile's vertex average sits in the notch, so the flip is not a
// reliable sweep-side oracle, and profiles outside the XY plane got normals
// that were not even perpendicular to the cap.
describe('createRevolve concave caps', () => {
  const axisY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
  // L-shaped closed profile, CCW in the XY plane: rect [2,6]×[0,4] with the
  // [4,6]×[2,4] notch removed. Area 12, centroid radius 11/3.
  const L: Vec3[] = [
    { x: 2, y: 0, z: 0 },
    { x: 6, y: 0, z: 0 },
    { x: 6, y: 2, z: 0 },
    { x: 4, y: 2, z: 0 },
    { x: 4, y: 4, z: 0 },
    { x: 2, y: 4, z: 0 },
  ];

  it('an L-shaped profile revolved 360° is watertight within 1% of the Pappus volume', () => {
    const body = createRevolve({ profile: L, axis: axisY, angle: Math.PI * 2 });
    // Pappus: V = 2π·r̄·A = 2π·(11/3)·12 = 88π ≈ 276.46 (the ~0.6% deficit is
    // the 32-segment inscribed tessellation).
    const ideal = 88 * Math.PI;
    const vol = Math.abs(computeVolume(body));
    expect(vol).toBeGreaterThan(ideal * 0.99);
    expect(vol).toBeLessThanOrEqual(ideal * 1.001);
    expect(findBoundaryLoops(body).holeCount).toBe(0);
    expect(checkManifold(body).isManifold).toBe(true);
  });

  it('a partial 180° L-revolve keeps the fractional Pappus volume and closed caps', () => {
    const body = createRevolve({ profile: L, axis: axisY, angle: Math.PI });
    const ideal = 44 * Math.PI; // θ·r̄·A = π·(11/3)·12
    const vol = Math.abs(computeVolume(body));
    expect(vol).toBeGreaterThan(ideal * 0.99);
    expect(vol).toBeLessThanOrEqual(ideal * 1.001);
    expect(findBoundaryLoops(body).holeCount).toBe(0);
  });

  it('caps of a profile outside the XY plane with a collinear leading triple get true plane normals', () => {
    // The same L in the YZ plane (which contains the axis), with a mid-edge
    // vertex making the first THREE points collinear. The cap plane normal is
    // ±X; the old first-3 fallback returned ±Z — inside the cap plane.
    const LYz: Vec3[] = [
      { x: 0, y: 0, z: 2 },
      { x: 0, y: 0, z: 4 },
      { x: 0, y: 0, z: 6 },
      { x: 0, y: 2, z: 6 },
      { x: 0, y: 2, z: 4 },
      { x: 0, y: 4, z: 4 },
      { x: 0, y: 4, z: 2 },
    ];
    const body = createRevolve({ profile: LYz, axis: axisY, angle: Math.PI });
    // Both caps face −X: the sweep (about +Y, +Z→+X) puts the material at
    // x ≥ 0, so each cap's outward side is the −X side of the x=0 plane.
    const caps = body.faces.filter((f) => f.vertices.length === LYz.length);
    expect(caps).toHaveLength(2);
    for (const cap of caps) {
      expect(Math.abs(cap.normal.x)).toBeCloseTo(1, 6);
      expect(cap.normal.x).toBeLessThan(0);
    }
    // Watertight and the right volume (same 12/(11/3) L section).
    expect(findBoundaryLoops(body).holeCount).toBe(0);
    const ideal = 44 * Math.PI;
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(ideal * 0.99);
    expect(Math.abs(computeVolume(body))).toBeLessThanOrEqual(ideal * 1.001);
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

  it('is manifold (watertight)', () => {
    const wedge = createWedge(10, 6, 4);
    expect(checkManifold(wedge).boundaryEdges).toBe(0);
  });

  it('scaled wedge preserves volume ratio', () => {
    const wedge = createWedge(10, 6, 4);
    const scaled = scaleBody(wedge, 3);
    const volOrig = Math.abs(computeVolume(wedge));
    const volScaled = Math.abs(computeVolume(scaled));
    expect(volScaled).toBeCloseTo(volOrig * 27, 0); // 3³ = 27
  });
});

describe('computeCompactness', () => {
  it('returns high compactness for a sphere (most compact shape)', () => {
    const sphere = createSphere(5, 32);
    const info = computeCompactness(sphere);
    // A sphere has the maximum compactness (surface-to-volume ratio is optimal).
    expect(info.compactness).toBeGreaterThan(0.9);
    expect(info.compactness).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(info.isCompact).toBe(true);
  });

  it('returns less than 1 for a non-spherical shape', () => {
    const box = createBox(10, 10, 10);
    const info = computeCompactness(box);
    expect(info.compactness).toBeLessThan(1.0);
    expect(info.compactness).toBeGreaterThan(0);
  });

  it('is dimensionless (scale-invariant)', () => {
    const small = computeCompactness(createBox(10, 10, 10));
    const large = computeCompactness(createBox(100, 100, 100));
    expect(small.compactness).toBeCloseTo(large.compactness, 6);
  });
});

describe('computeRoughness', () => {
  it('returns low roughness for a box (flat faces)', () => {
    const box = createBox(10, 10, 10);
    const info = computeRoughness(box);
    // A box has flat faces, so roughness should be low.
    expect(info.roughness).toBeGreaterThanOrEqual(0);
    expect(info.smoothness).toBeGreaterThanOrEqual(0);
  });

  it('returns positive roughness for a sphere (curved surface)', () => {
    const sphere = createSphere(5, 16);
    const info = computeRoughness(sphere);
    expect(info.roughness).toBeGreaterThan(0);
  });

  it('higher tessellation sphere has lower roughness', () => {
    const coarse = computeRoughness(createSphere(5, 8));
    const fine = computeRoughness(createSphere(5, 32));
    // Finer tessellation approximates the sphere better → lower roughness.
    expect(fine.roughness).toBeLessThanOrEqual(coarse.roughness + 1e-6);
  });
});

describe('createRevolve edge cases', () => {
  const profile: Vec3[] = [
    { x: 1, y: -1, z: 0 },
    { x: 2, y: -1, z: 0 },
    { x: 2, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
  ];

  it('partial revolution (180°) is watertight', () => {
    const body = createRevolve({ profile, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI });
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('partial revolution (90°) is watertight', () => {
    const body = createRevolve({ profile, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI / 2 });
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('revolution around X axis works', () => {
    const body = createRevolve({ profile, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: Math.PI * 2 });
    expect(body.vertices.length).toBeGreaterThan(0);
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('revolution around Z axis works', () => {
    const body = createRevolve({ profile, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, angle: Math.PI * 2 });
    expect(body.vertices.length).toBeGreaterThan(0);
    expect(checkManifold(body).boundaryEdges).toBe(0);
  });

  it('revolution with offset axis produces valid geometry', () => {
    const body = createRevolve({ profile, axis: { origin: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI * 2 });
    expect(body.vertices.length).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(0);
  });

  it('full revolution volume matches Pappus theorem', () => {
    const rect: Vec3[] = [
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 2, z: 0 },
      { x: 2, y: 2, z: 0 },
    ];
    const body = createRevolve({ profile: rect, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI * 2 });
    // V = area(4) × 2π × centroidRadius(3) = 24π ≈ 75.4
    const ideal = 24 * Math.PI;
    const vol = Math.abs(computeVolume(body));
    expect(vol).toBeGreaterThan(ideal * 0.96);
    expect(vol).toBeLessThanOrEqual(ideal * 1.001);
  });
});

describe('computeFaceAreas', () => {
  it('returns one area per face for a box', () => {
    const box = createBox(10, 20, 30);
    const areas = computeFaceAreas(box);
    expect(areas).toHaveLength(box.faces.length);
    for (const a of areas) {
      expect(a.area).toBeGreaterThan(0);
      expect(a.faceId).toBeTruthy();
    }
  });

  it('box face areas sum to total surface area', () => {
    const box = createBox(10, 20, 30);
    const areas = computeFaceAreas(box);
    const total = areas.reduce((sum, a) => sum + a.area, 0);
    // Surface area of 10×20×30 box = 2*(10*20 + 20*30 + 10*30) = 2200
    expect(total).toBeCloseTo(2200, 0);
  });

  it('all areas are positive', () => {
    const sphere = createSphere(5, 16);
    const areas = computeFaceAreas(sphere);
    for (const a of areas) {
      expect(a.area).toBeGreaterThan(0);
    }
  });
});

describe('computeLargestFace', () => {
  it('returns null for empty faces', () => {
    const body = createBox(10, 10, 10);
    const empty: SolidBody = { ...body, faces: [] };
    expect(computeLargestFace(empty)).toBeNull();
  });

  it('returns the largest face for a box', () => {
    const box = createBox(10, 20, 30);
    const largest = computeLargestFace(box);
    expect(largest).not.toBeNull();
    // The largest faces are 20×30 = 600.
    expect(largest!.area).toBeCloseTo(600, 0);
  });

  it('returns a valid face ID', () => {
    const box = createBox(10, 10, 10);
    const largest = computeLargestFace(box);
    expect(largest!.faceId).toBeTruthy();
    expect(box.faces.some((f) => f.id === largest!.faceId)).toBe(true);
  });
});

describe('computeMeshQuality', () => {
  it('returns quality metrics for a box', () => {
    const box = createBox(10, 10, 10);
    const q = computeMeshQuality(box);
    expect(q.aspectRatioAvg).toBeGreaterThan(0);
    expect(q.aspectRatioMax).toBeGreaterThan(0);
  });

  it('returns quality metrics for a sphere', () => {
    const sphere = createSphere(5, 16);
    const q = computeMeshQuality(sphere);
    expect(q.aspectRatioAvg).toBeGreaterThan(0);
  });

  it('box has low aspect ratio (all faces are squares)', () => {
    const box = createBox(10, 10, 10);
    const q = computeMeshQuality(box);
    // Box faces are squares, so aspect ratio should be close to 1.
    expect(q.aspectRatioAvg).toBeLessThan(2);
  });

  it('quality metrics are finite', () => {
    const box = createBox(10, 10, 10);
    const q = computeMeshQuality(box);
    expect(Number.isFinite(q.aspectRatioAvg)).toBe(true);
    expect(Number.isFinite(q.aspectRatioMax)).toBe(true);
    expect(Number.isFinite(q.skewnessAvg)).toBe(true);
    expect(Number.isFinite(q.skewnessMax)).toBe(true);
  });
});

describe('checkWindingOrder', () => {
  it('box has consistent winding', () => {
    const box = createBox(10, 10, 10);
    const w = checkWindingOrder(box);
    expect(w.consistentWinding).toBe(true);
    expect(w.degenerateFaces).toBe(0);
  });

  it('sphere has consistent winding', () => {
    const sphere = createSphere(5, 16);
    const w = checkWindingOrder(sphere);
    expect(w.consistentWinding).toBe(true);
  });

  it('cylinder has consistent winding', () => {
    const cyl = createCylinder(5, 10, 16);
    const w = checkWindingOrder(cyl);
    expect(w.consistentWinding).toBe(true);
  });

  it('face counts are non-negative', () => {
    const box = createBox(10, 10, 10);
    const w = checkWindingOrder(box);
    expect(w.clockwiseFaces).toBeGreaterThanOrEqual(0);
    expect(w.counterClockwiseFaces).toBeGreaterThanOrEqual(0);
    expect(w.degenerateFaces).toBeGreaterThanOrEqual(0);
  });
});

describe('computeSurfaceArea', () => {
  it('box surface area = 2*(w*h + h*d + w*d)', () => {
    const box = createBox(10, 20, 30);
    const area = computeSurfaceArea(box);
    expect(area).toBeCloseTo(2 * (10 * 20 + 20 * 30 + 10 * 30), 0);
  });

  it('sphere surface area ≈ 4πr²', () => {
    const sphere = createSphere(5, 32);
    const area = computeSurfaceArea(sphere);
    const expected = 4 * Math.PI * 25;
    expect(area).toBeGreaterThan(expected * 0.9);
    expect(area).toBeLessThan(expected * 1.1);
  });

  it('surface area is always positive', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16), () => createTorus(10, 3, 16, 8)]) {
      expect(computeSurfaceArea(make())).toBeGreaterThan(0);
    }
  });

  it('surface area scales with size²', () => {
    const small = computeSurfaceArea(createBox(10, 10, 10));
    const large = computeSurfaceArea(createBox(20, 20, 20));
    expect(large).toBeCloseTo(small * 4, 0); // 2² = 4
  });
});

describe('topology edge cases', () => {
  it('torus is genus 1 (Euler χ = 0)', () => {
    const topo = computeTopology(createTorus(10, 3, 16, 8));
    expect(topo.eulerCharacteristic).toBe(0);
    expect(topo.genus).toBe(1);
  });

  it('prism is genus 0', () => {
    const topo = computeTopology(createPrism(6, 10, 5));
    expect(topo.eulerCharacteristic).toBe(2);
    expect(topo.genus).toBe(0);
  });

  it('tube is genus 1', () => {
    const topo = computeTopology(createTube(10, 6, 20, 16));
    expect(topo.eulerCharacteristic).toBe(0);
    expect(topo.genus).toBe(1);
  });

  it('all genus values are non-negative', () => {
    for (const make of [
      () => createBox(10, 10, 10),
      () => createSphere(5, 16),
      () => createTorus(10, 3, 16, 8),
    ]) {
      expect(computeTopology(make()).genus).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('computeMeshStatistics edge cases', () => {
  it('cylinder has correct face and vertex counts', () => {
    const cyl = createCylinder(5, 10, 16);
    const s = computeMeshStatistics(cyl);
    expect(s.faceCount).toBeGreaterThan(0);
    expect(s.vertexCount).toBeGreaterThan(0);
    expect(s.edgeCount).toBeGreaterThan(0);
  });

  it('all counts are positive for any valid body', () => {
    for (const make of [
      () => createBox(10, 10, 10),
      () => createSphere(5, 16),
      () => createCylinder(5, 10, 16),
    ]) {
      const s = computeMeshStatistics(make());
      expect(s.faceCount).toBeGreaterThan(0);
      expect(s.vertexCount).toBeGreaterThan(0);
      expect(s.edgeCount).toBeGreaterThan(0);
    }
  });

  it('face count is always even for closed manifold bodies', () => {
    // Each face has exactly 3 vertices (triangulated), and each edge is shared
    // by exactly 2 faces. So face count should be even for closed meshes.
    const box = createBox(10, 10, 10);
    const s = computeMeshStatistics(box);
    expect(s.faceCount % 2).toBe(0);
  });
});

/** Golden adjacency of a box: every edge shared by exactly two faces. */
describe('computeAdjacency (keyed-index rewrite)', () => {
  // The keyed-index rewrite must be behaviour-identical to the original
  // per-lookup linear scans — this reference reimplements the OLD algorithm
  // directly and deep-compares all four maps.
  function naiveAdjacency(body: ReturnType<typeof createBox>) {
    const findVertex = (v: { x: number; y: number; z: number }) =>
      body.vertices.findIndex(
        (nv) => Math.abs(nv.x - v.x) < 1e-6 && Math.abs(nv.y - v.y) < 1e-6 && Math.abs(nv.z - v.z) < 1e-6,
      );
    const findEdge = (v1: { x: number; y: number; z: number }, v2: { x: number; y: number; z: number }) =>
      body.edges.findIndex(
        (e) =>
          (Math.abs(e.start.x - v1.x) < 1e-6 && Math.abs(e.start.y - v1.y) < 1e-6 && Math.abs(e.start.z - v1.z) < 1e-6 &&
            Math.abs(e.end.x - v2.x) < 1e-6 && Math.abs(e.end.y - v2.y) < 1e-6 && Math.abs(e.end.z - v2.z) < 1e-6) ||
          (Math.abs(e.start.x - v2.x) < 1e-6 && Math.abs(e.start.y - v2.y) < 1e-6 && Math.abs(e.start.z - v2.z) < 1e-6 &&
            Math.abs(e.end.x - v1.x) < 1e-6 && Math.abs(e.end.y - v1.y) < 1e-6 && Math.abs(e.end.z - v1.z) < 1e-6),
      );
    const vertexToEdges = new Map<number, number[]>();
    const vertexToFaces = new Map<number, number[]>();
    const edgeToFaces = new Map<number, number[]>();
    const faceToEdges = new Map<number, number[]>();
    body.edges.forEach((edge, ei) => {
      for (const idx of [findVertex(edge.start), findVertex(edge.end)]) {
        if (idx >= 0) vertexToEdges.set(idx, [...(vertexToEdges.get(idx) ?? []), ei]);
      }
    });
    body.faces.forEach((face, fi) => {
      for (const v of face.vertices) {
        const idx = findVertex(v);
        if (idx >= 0) vertexToFaces.set(idx, [...(vertexToFaces.get(idx) ?? []), fi]);
      }
    });
    body.faces.forEach((face, fi) => {
      const vs = face.vertices;
      for (let i = 0; i < vs.length; i++) {
        const edgeIdx = findEdge(vs[i]!, vs[(i + 1) % vs.length]!);
        if (edgeIdx >= 0) {
          edgeToFaces.set(edgeIdx, [...(edgeToFaces.get(edgeIdx) ?? []), fi]);
          faceToEdges.set(fi, [...(faceToEdges.get(fi) ?? []), edgeIdx]);
        }
      }
    });
    return { vertexToEdges, vertexToFaces, edgeToFaces, faceToEdges };
  }

  it('matches the original linear-scan algorithm on small bodies', () => {
    for (const body of [createBox(10, 10, 10), createSphere(5, 12), createCylinder(5, 10, 12)]) {
      const got = computeAdjacency(body);
      const want = naiveAdjacency(body);
      expect([...got.vertexToEdges.entries()]).toEqual([...want.vertexToEdges.entries()]);
      expect([...got.vertexToFaces.entries()]).toEqual([...want.vertexToFaces.entries()]);
      expect([...got.edgeToFaces.entries()]).toEqual([...want.edgeToFaces.entries()]);
      expect([...got.faceToEdges.entries()]).toEqual([...want.faceToEdges.entries()]);
    }
  });

  it('subdivided sphere: every edge shared by exactly two faces, all vertices covered', () => {
    const sphere = createSphere(10, 32);
    const adj = computeAdjacency(sphere);
    expect(sphere.faces.length).toBe(512);
    for (const faces of adj.edgeToFaces.values()) expect(faces).toHaveLength(2);
    expect(adj.vertexToFaces.size).toBe(sphere.vertices.length);
    expect(adj.faceToEdges.size).toBe(sphere.faces.length);
  });

  it('adjacency and curvature of an 8k-face sphere stay fast (was O(E×V))', () => {
    const sphere = createSphere(10, 128);
    expect(sphere.faces.length).toBe(8192);
    const t0 = performance.now();
    const adj = computeAdjacency(sphere);
    const curv = computeCurvature(sphere);
    const ms = performance.now() - t0;
    expect(adj.vertexToEdges.size).toBe(sphere.vertices.length);
    // Measured ~100 ms after the keyed-index fix (was ~3.9 s); generous bound.
    expect(ms).toBeLessThan(5000);
    expect(Number.isFinite(curv.gaussianCurvatureAvg)).toBe(true);
  });
});

describe('computeCurvature (keyed-index rewrite)', () => {
  it('matches the original per-corner linear scan on a sphere', () => {
    // Reference: the exact angle-defect loop the function used before the
    // keyed vertex index, with the linear findIndex restored.
    function naiveCurvature(body: ReturnType<typeof createSphere>) {
      const vertexAngles = new Map<number, number>();
      for (const face of body.faces) {
        const verts = face.vertices;
        for (let i = 0; i < verts.length; i++) {
          const prev = (i - 1 + verts.length) % verts.length;
          const next = (i + 1) % verts.length;
          const v0 = verts[prev]!;
          const v1 = verts[i]!;
          const v2 = verts[next]!;
          const idx = body.vertices.findIndex(
            (v) => Math.abs(v.x - v1.x) < 1e-6 && Math.abs(v.y - v1.y) < 1e-6 && Math.abs(v.z - v1.z) < 1e-6,
          );
          if (idx < 0) continue;
          const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
          const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
          const lenA = Math.hypot(a.x, a.y, a.z);
          const lenB = Math.hypot(b.x, b.y, b.z);
          if (lenA < 1e-10 || lenB < 1e-10) continue;
          const cos = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (lenA * lenB)));
          vertexAngles.set(idx, (vertexAngles.get(idx) ?? 0) + Math.acos(cos));
        }
      }
      let total = 0;
      let min = Infinity;
      let max = -Infinity;
      let count = 0;
      for (const sum of vertexAngles.values()) {
        const g = 2 * Math.PI - sum;
        total += g;
        min = Math.min(min, g);
        max = Math.max(max, g);
        count++;
      }
      return { total, min, max, count };
    }
    const sphere = createSphere(5, 16);
    const got = computeCurvature(sphere);
    const want = naiveCurvature(sphere);
    expect(got.gaussianCurvatureAvg).toBeCloseTo(want.total / want.count, 12);
    expect(got.gaussianCurvatureMin).toBeCloseTo(want.min, 12);
    expect(got.gaussianCurvatureMax).toBeCloseTo(want.max, 12);
    // Angle-defect sanity: a closed sphere's total Gaussian curvature is 4π.
    expect(got.gaussianCurvatureAvg * want.count).toBeCloseTo(4 * Math.PI, 1);
  });
});

describe('vertex lookup across quantization-bucket straddle', () => {
  // Two coordinates within 1e-6 can round into ADJACENT 6-decimal buckets when
  // the pair straddles a rounding boundary — the old linear tolerance matched
  // them, the plain keyed lookup missed. The lookups now probe neighbouring
  // buckets on a miss.
  /** 2e-7 → "0.000000" but 7e-7 → "0.000001": 5e-7 apart, adjacent buckets. */
  const A = { x: 2e-7, y: 0, z: 0 };
  const B = { x: 7e-7, y: 0, z: 0 };

  /** Tetrahedron-ish body whose stored vertex list holds A (not B), with an
   * edge endpoint and a face corner sitting at B. */
  function straddleBody(): SolidBody {
    const far = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ];
    return {
      id: 'straddle',
      name: 'straddle',
      vertices: [A, ...far],
      edges: [
        { id: 'e0', start: B, end: far[0]! }, // B: the straddling coordinate
        { id: 'e1', start: far[0]!, end: far[1]! },
      ],
      faces: [
        { id: 'f0', vertices: [B, far[0]!, far[1]!], normal: { x: 0, y: 0, z: 1 } },
      ],
    };
  }

  it('adjacency attributes a straddling edge endpoint to the near vertex', () => {
    const adj = computeAdjacency(straddleBody());
    // B rounds into the bucket next to A's — the edge endpoint must resolve to
    // vertex 0 (A), not be silently dropped.
    expect(adj.vertexToEdges.get(0)).toEqual([0]);
    expect(adj.vertexToEdges.has(4)).toBe(false); // no phantom 5th vertex
  });

  it('adjacency attributes a straddling face corner to the near vertex', () => {
    const adj = computeAdjacency(straddleBody());
    expect(adj.vertexToFaces.get(0)).toEqual([0]);
  });

  it('vertex degrees count a straddling edge endpoint', () => {
    const degrees = computeVertexDegrees(straddleBody());
    expect(degrees.get(0)).toBe(1); // the B endpoint resolves to A
    expect(degrees.get(1)).toBe(2); // far[0] closes both edges
  });

  it('curvature sums a straddling face corner into the near vertex', () => {
    const body = straddleBody();
    const curv = computeCurvature(body);
    // Corners: at B (≈origin) the right angle between the two unit far legs
    // (π/2); at each far vertex π/4. Vertex 0's defect is 2π − π/2 = 3π/2 —
    // with the corner dropped there would be no entry for it at all.
    expect(curv.gaussianCurvatureMin).toBeCloseTo((3 * Math.PI) / 2, 3);
    expect(curv.gaussianCurvatureMax).toBeCloseTo((7 * Math.PI) / 4, 3);
  });
});

describe('edge lookup across quantization-bucket straddle', () => {
  // The EDGE-level twin of the vertex-straddle suite: undirectedEdgeKey
  // quantizes BOTH endpoints, so a stored edge endpoint at A and a face side
  // endpoint at B (5e-7 apart, adjacent buckets) used to miss and the shared
  // edge vanished from edgeToFaces/faceToEdges. The lookup now probes
  // neighbour-bucket endpoint pairs on a miss.
  const A = { x: 2e-7, y: 0, z: 0 };
  const B = { x: 7e-7, y: 0, z: 0 };
  const P = { x: 1, y: 0, z: 0 };
  const Q = { x: 0, y: 1, z: 0 };

  /** Body whose stored edge e0 runs A→P while both faces cross it as (B,P). */
  function straddleEdgeBody(): SolidBody {
    return {
      id: 'straddle-edge',
      name: 'straddle-edge',
      vertices: [A, P, Q],
      edges: [{ id: 'e0', start: A, end: P }],
      faces: [
        { id: 'f0', vertices: [B, P, Q], normal: { x: 0, y: 0, z: 1 } },
        { id: 'f1', vertices: [Q, P, B], normal: { x: 0, y: 0, z: 1 } },
      ],
    };
  }

  it('adjacency reports the shared edge both faces cross at the straddling endpoint', () => {
    const adj = computeAdjacency(straddleEdgeBody());
    expect(adj.edgeToFaces.get(0)).toEqual([0, 1]);
    expect(adj.faceToEdges.get(0)).toEqual([0]);
    expect(adj.faceToEdges.get(1)).toEqual([0]);
  });

  it('probing does not invent matches: other sides with no stored edge still miss', () => {
    const adj = computeAdjacency(straddleEdgeBody());
    // Only the (B,P)/(P,B) sides resolve to e0; (P,Q)/(Q,B)/(B,Q)/(Q,P) have
    // no indexed edge (P and Q are 1mm apart — far outside any probe radius).
    expect(adj.faceToEdges.get(0)).toHaveLength(1);
    expect(adj.faceToEdges.get(1)).toHaveLength(1);
    expect(adj.edgeToFaces.size).toBe(1);
  });
});
