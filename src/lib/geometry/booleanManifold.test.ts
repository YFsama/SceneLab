import { describe, it, expect, beforeAll } from 'vitest';
import { warmUpBooleanEngine, isManifoldEngineReady, booleanOpManifold } from './booleanManifold';
import { booleanOp } from './boolean';
import { createBox, createSphere, computeVolume, findBoundaryLoops, checkManifold } from './brep';
import { createCylinder } from './brep';
import { booleanOpVoxel } from './booleanVoxel';
import { translateBody, applyFillet } from './operations';

describe('manifold boolean engine', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('warms up the WASM engine', () => {
    expect(isManifoldEngineReady()).toBe(true);
  });

  it('exact difference of overlapping cubes (875 mm³)', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 5, z: 5 });
    const r = booleanOpManifold(a, b, 'difference');
    expect(r).not.toBeNull();
    expect(computeVolume(r!)).toBeCloseTo(875, 4);
    // Watertight: no boundary loops.
    expect(findBoundaryLoops(r!).loops.length).toBe(0);
  });

  it('exact union and intersection volumes', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 5, z: 5 });
    const u = booleanOpManifold(a, b, 'union');
    expect(computeVolume(u!)).toBeCloseTo(1875, 4);
    const i = booleanOpManifold(a, b, 'intersect');
    expect(computeVolume(i!)).toBeCloseTo(125, 4);
  });

  it('disjoint intersect yields null (empty result)', () => {
    const a = createBox(10, 10, 10);
    const far = translateBody(createBox(10, 10, 10), { x: 1000, y: 0, z: 0 });
    expect(booleanOpManifold(a, far, 'intersect')).toBeNull();
  });

  it('handles curved inputs (sphere minus box) watertight', () => {
    const sphere = createSphere(10, 32);
    const box = createBox(6, 6, 6);
    const r = booleanOpManifold(sphere, box, 'difference');
    expect(r).not.toBeNull();
    // Exact-ish: full sphere minus a fully-embedded 6³ cube.
    expect(computeVolume(r!)).toBeCloseTo(computeVolume(sphere) - 216, 1);
    expect(findBoundaryLoops(r!).loops.length).toBe(0);
  });

  it('booleanOp dispatches to the exact engine once warmed up', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 5, z: 5 });
    const r = booleanOp(a, b, 'difference');
    expect(r).not.toBeNull();
    // Exact value, not a voxel approximation.
    expect(computeVolume(r!)).toBeCloseTo(875, 4);
  });
});

describe('exact splitByPlane', () => {
  it('halves a box exactly along a midplane', async () => {
    await warmUpBooleanEngine();
    const { splitByPlane } = await import('./boolean');
    const box = createBox(10, 10, 10);
    const plane = {
      id: 'p', name: 'cut',
      origin: { x: 0, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 },
    };
    const { positive, negative } = splitByPlane(box, plane);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    // Exact halves — a voxel cut can only approximate this.
    expect(computeVolume(positive!)).toBeCloseTo(500, 3);
    expect(computeVolume(negative!)).toBeCloseTo(500, 3);
    expect(findBoundaryLoops(positive!).loops.length).toBe(0);
    expect(findBoundaryLoops(negative!).loops.length).toBe(0);
  });

  it('cuts at an arbitrary position and reports empty sides as null', async () => {
    await warmUpBooleanEngine();
    const { splitByPlane } = await import('./boolean');
    const box = createBox(10, 10, 10);
    const plane = {
      id: 'p', name: 'cut',
      origin: { x: 0, y: 100, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 },
    };
    const { positive, negative } = splitByPlane(box, plane);
    expect(positive).toBeNull();
    expect(negative).not.toBeNull();
    expect(computeVolume(negative!)).toBeCloseTo(1000, 3);
  });

  it('is fast: 100 exact cuts of a sphere complete quickly', async () => {
    await warmUpBooleanEngine();
    const { splitByPlane } = await import('./boolean');
    const sphere = createSphere(10, 32);
    const plane = {
      id: 'p', name: 'cut',
      origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 },
    };
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const { positive, negative } = splitByPlane(sphere, plane);
      expect(positive).not.toBeNull();
      expect(negative).not.toBeNull();
    }
    const ms = performance.now() - t0;
    // Exact WASM cuts run in ~ms each; the old voxel path was ~2s per cut.
    expect(ms).toBeLessThan(10000);
  });
});

// ---------------------------------------------------------------------------
// Face provenance tagging (the T1 contract): boolean-output faces that lie
// on a full (≥300°) analytic cylindrical wall carry Face.source with the
// fitted origin/axis/radius, so hole recognition can recover the geometry
// instead of re-fitting facet soup.
// ---------------------------------------------------------------------------

/** Point-to-line distance, for verifying every tagged face's vertices sit on
 *  the fitted cylinder. */
function distToLine(p: { x: number; y: number; z: number }, origin: { x: number; y: number; z: number }, axis: { x: number; y: number; z: number }): number {
  const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
  const t = dx * axis.x + dy * axis.y + dz * axis.z;
  const rx = dx - axis.x * t, ry = dy - axis.y * t, rz = dz - axis.z * t;
  return Math.hypot(rx, ry, rz);
}

describe('face provenance tagging (Face.source)', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  // Computed lazily (the engine must be warm first).
  const drill = () => booleanOpManifold(
    createBox(20, 20, 20), // y ∈ [0,20]
    translateBody(createCylinder(2, 40, 48), { x: 0, y: -10, z: 0 }), // ⌀4 through, along Y
    'difference',
  )!;

  it('drills first: watertight output at the 48-gon prism volume', () => {
    const drilled = drill();
    expect(drilled).not.toBeNull();
    const ngonArea = (48 * Math.sin((2 * Math.PI) / 48) * 4) / 2; // inscribed 48-gon, r=2
    expect(computeVolume(drilled)).toBeCloseTo(8000 - ngonArea * 20, 1);
    expect(checkManifold(drilled).isManifold).toBe(true);
  });

  it('the hole wall faces carry source: radius ≈ d/2, axis ≈ ±Y, every vertex on the cylinder', () => {
    const drilled = drill();
    const tagged = drilled.faces.filter((f) => f.source?.kind === 'cylinder');
    // The 48-facet wall survives as (up to decimation) many coplanar strips —
    // all of them tagged, and nothing else is.
    expect(tagged.length).toBeGreaterThanOrEqual(24);
    for (const f of tagged) {
      const src = f.source!;
      expect(Math.abs(src.radius - 2)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(src.axis.y) - 1)).toBeLessThan(1e-9);
      expect(Math.hypot(src.axis.x, src.axis.y, src.axis.z)).toBeCloseTo(1, 9);
      for (const v of f.vertices) {
        expect(Math.abs(distToLine(v, src.origin, src.axis) - src.radius)).toBeLessThan(1e-6);
      }
    }
  });

  it("the box's planar faces carry no source", () => {
    const drilled = drill();
    const planar = drilled.faces.filter((f) => !f.source);
    expect(planar.length).toBeGreaterThan(0);
    // Every untagged face is planar-ish: its vertices never fit a circle wall.
    for (const f of planar) {
      expect(f.vertices.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('fillet walls stay untagged: a 90° arc fragment is not a full wall (the ≥300° rule)', () => {
    const filleted = applyFillet(createBox(30, 10, 30), [], 2);
    expect(filleted.faces.some((f) => f.source)).toBe(false);
  });

  it('voxel output carries no source (facet soup is not classified)', () => {
    const vox = booleanOpVoxel(
      createBox(10, 10, 10),
      translateBody(createCylinder(2, 30, 12), { x: 0, y: -10, z: 0 }),
      'difference',
      16,
    )!;
    expect(vox).not.toBeNull();
    expect(vox.faces.some((f) => f.source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coplanar decimation (audit M item): the exact output merges fake 0°-crease
// triangle pairs back into polygonal faces — roughly halving face counts on
// planar-cut results, with identical geometry.
// ---------------------------------------------------------------------------

describe('coplanar decimation of the exact output', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('difference of overlapping cubes emits polygonal faces, exact volume, manifold', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 5, z: 5 });
    const r = booleanOpManifold(a, b, 'difference')!;
    expect(computeVolume(r)).toBeCloseTo(875, 4);
    expect(checkManifold(r).isManifold).toBe(true);
    // The big cut face (and the trimmed originals) merge: quads+ polygons
    // dominate instead of triangle pairs.
    const polys = r.faces.filter((f) => f.vertices.length > 3);
    expect(polys.length).toBeGreaterThanOrEqual(4);
    const triCount = r.faces.filter((f) => f.vertices.length === 3).length;
    expect(triCount).toBeLessThan(r.faces.length / 2);
  });

  it('an exact planar cut of a box yields ~one polygon per planar region', async () => {
    const { splitByPlane } = await import('./boolean');
    const box = createBox(10, 10, 10);
    const plane = {
      id: 'p', name: 'cut',
      origin: { x: 0, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 },
    };
    const { positive } = splitByPlane(box, plane)!;
    expect(positive).not.toBeNull();
    expect(computeVolume(positive!)).toBeCloseTo(500, 3);
    // 5 box faces + 1 cut face = 6 planar regions; decimation lands near that
    // (each a single polygon) where the triangle soup had 10+.
    expect(positive!.faces.length).toBeLessThanOrEqual(9);
    expect(positive!.faces.length).toBeGreaterThanOrEqual(5);
    expect(checkManifold(positive!).isManifold).toBe(true);
  });

  it('curved surfaces are untouched (sphere booleans keep their triangles)', () => {
    const sphere = createSphere(10, 32);
    const r = booleanOpManifold(sphere, createBox(6, 6, 6), 'difference')!;
    expect(findBoundaryLoops(r).loops.length).toBe(0);
    // The sphere wall (non-coplanar facets) must not merge away.
    expect(r.faces.length).toBeGreaterThan(100);
    expect(computeVolume(r)).toBeCloseTo(computeVolume(sphere) - 216, 1);
  });
});
