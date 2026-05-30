import { describe, it, expect } from 'vitest';
import { assessPrintReadiness } from './readiness';
import { createBox, createSphere } from '../geometry';
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

  it('warns that a tall narrow box tips easily (stable but marginal)', () => {
    // 4×40×4: CoM inside the base (stable) but topples at atan(2/20) ≈ 5.7°.
    const tall = createBox(4, 40, 4);
    const r = assessPrintReadiness(tall, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(r.issues.some((i) => i.code === 'unstable')).toBe(false);
    expect(r.issues.some((i) => i.code === 'tippy' && i.severity === 'warning')).toBe(true);
    // Tippy is only a warning, so a watertight part that fits is still "ready".
    expect(r.ready).toBe(true);
  });

  it('warns about walls thinner than the printable minimum', () => {
    // A 0.5mm-thick slab is below the 0.8mm default minimum wall.
    const slab = createBox(0.5, 30, 30);
    const r = assessPrintReadiness(slab, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(r.issues.some((i) => i.code === 'thin-walls' && i.severity === 'warning')).toBe(true);
    // A normal 10mm box has no thin-wall issue.
    const ok = assessPrintReadiness(createBox(10, 10, 10), { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(ok.issues.some((i) => i.code === 'thin-walls')).toBe(false);
  });

  it('reports the worst overhang angle in the support warning', () => {
    // A sphere has a downward lower hemisphere → shallow overhangs needing support.
    const r = assessPrintReadiness(createSphere(10, 24), { buildVolume: { x: 200, y: 200, z: 200 } });
    const overhang = r.issues.find((i) => i.code === 'overhangs');
    expect(overhang).toBeDefined();
    expect(overhang!.message).toMatch(/worst \d+° from horizontal/);
    // Also reports a rough support-material volume.
    expect(overhang!.message).toMatch(/[\d.]+ cm³ support/);
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
