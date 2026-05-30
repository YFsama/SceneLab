import { describe, it, expect } from 'vitest';
import { assessPrintReadiness } from './readiness';
import { createBox } from '../geometry';
import { exportSTLBinary, importSTLBinary } from '../io';
import type { SolidBody } from '../geometry/types';

describe('print readiness on imported meshes', () => {
  it('a re-imported, welded box is watertight and ready', () => {
    const imported = importSTLBinary(exportSTLBinary(createBox(10, 10, 10)));
    const r = assessPrintReadiness(imported, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(r.ready).toBe(true);
    expect(r.issues.some((i) => i.code === 'not-watertight')).toBe(false);
  });
});

describe('assessPrintReadiness', () => {
  it('a watertight box that fits is ready with no issues', () => {
    const box = createBox(10, 10, 10);
    const r = assessPrintReadiness(box, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(r.ready).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('flags a part that exceeds the build volume as an error', () => {
    const big = createBox(300, 300, 300);
    const r = assessPrintReadiness(big, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.code === 'too-big' && i.severity === 'error')).toBe(true);
  });

  it('flags a non-watertight mesh as an error', () => {
    const sliver: SolidBody = {
      id: 's',
      name: 's',
      vertices: [],
      faces: [
        {
          id: 'f',
          vertices: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 0, z: 0 },
            { x: 0, y: 0, z: 1 },
          ],
          normal: { x: 0, y: 1, z: 0 },
        },
      ],
      edges: [],
    };
    const r = assessPrintReadiness(sliver);
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.code === 'not-watertight')).toBe(true);
  });
});
