import { describe, it, expect } from 'vitest';
import { runGeometryOp, __disableWorkerForTests } from './geometryWorkerClient';
import { asyncBooleanOp, asyncHollowBody, booleanOp } from '../geometry/boolean';
import { booleanOpVoxel } from '../geometry/booleanVoxel';
import { createBox, computeVolume } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('geometry worker client', () => {
  it('falls back to synchronous kernels when Workers are unavailable', async () => {
    __disableWorkerForTests();
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 });
    const result = await runGeometryOp(
      'voxelBoolean',
      { a, b, op: 'union', resolution: 16 },
      () => booleanOpVoxel(a, b, 'union', 16),
    );
    expect(result).not.toBeNull();
    // Voxel approximation of the 1875 union volume (coarse res 16).
    expect(computeVolume(result as never)).toBeGreaterThanOrEqual(1400);
    expect(computeVolume(result as never)).toBeLessThan(2300);
  });

  it('asyncBooleanOp produces the same result as the sync entry point (cold engine)', async () => {
    __disableWorkerForTests();
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 5, z: 5 });
    const sync = booleanOp(a, b, 'difference');
    const async = await asyncBooleanOp(a, b, 'difference');
    expect(computeVolume(async!)).toBeCloseTo(computeVolume(sync!), 5);
  });

  it('asyncHollowBody removes material', async () => {
    __disableWorkerForTests();
    const box = createBox(20, 20, 20);
    const shell = await asyncHollowBody(box, 2, 24);
    expect(shell).not.toBeNull();
    expect(Math.abs(computeVolume(shell!))).toBeLessThan(8000 * 0.75);
  });
});
