import { describe, it, expect, beforeAll } from 'vitest';
import { warmUpBooleanEngine, isManifoldEngineReady, booleanOpManifold } from './booleanManifold';
import { booleanOp } from './boolean';
import { createBox, createSphere, computeVolume, findBoundaryLoops } from './brep';
import { translateBody } from './operations';

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
