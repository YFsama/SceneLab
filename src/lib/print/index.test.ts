import { describe, it, expect } from 'vitest';
import {
  analyzeOverhangs,
  estimateMass,
  estimateMassForMaterial,
  checkBuildVolume,
  analyzePrintability,
  MATERIAL_DENSITIES,
} from './index';
import type { SolidBody, Face, Vec3 } from '../geometry/types';
import { createBox } from '../geometry';

/** A 1×1 square face with an explicit normal, for overhang tests. */
function squareFace(id: string, verts: [Vec3, Vec3, Vec3, Vec3], normal: Vec3): Face {
  return { id, vertices: verts, normal };
}

function bodyOf(faces: Face[]): SolidBody {
  return { id: 'b', name: 'test', vertices: [], faces, edges: [] };
}

describe('analyzeOverhangs', () => {
  // Build axis is +Y by default.
  const ceiling = squareFace(
    'ceiling',
    [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 }],
    { x: 0, y: -1, z: 0 }, // faces straight down
  );
  const floor = squareFace(
    'floor',
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }],
    { x: 0, y: 1, z: 0 }, // faces up
  );
  const wall = squareFace(
    'wall',
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 }],
    { x: 1, y: 0, z: 0 }, // vertical wall
  );

  it('flags a horizontal downward face (bridge) as needing support', () => {
    const report = analyzeOverhangs(bodyOf([ceiling]));
    const f = report.faces.find((x) => x.faceId === 'ceiling')!;
    expect(f.needsSupport).toBe(true);
    expect(f.angleDeg).toBeCloseTo(0, 5);
    expect(report.overhangArea).toBeCloseTo(1, 5);
  });

  it('does not flag up-facing or vertical faces', () => {
    const report = analyzeOverhangs(bodyOf([floor, wall]));
    expect(report.faces.find((x) => x.faceId === 'floor')!.needsSupport).toBe(false);
    expect(report.faces.find((x) => x.faceId === 'wall')!.needsSupport).toBe(false);
    expect(report.overhangArea).toBeCloseTo(0, 5);
  });

  it('respects a steeper threshold', () => {
    // A 45° downward face: normal halfway between down and sideways.
    const ramp = squareFace(
      'ramp',
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 }],
      { x: 0, y: -1, z: 1 },
    );
    const at60 = analyzeOverhangs(bodyOf([ramp]), { thresholdDeg: 60 });
    const at30 = analyzeOverhangs(bodyOf([ramp]), { thresholdDeg: 30 });
    const f60 = at60.faces.find((x) => x.faceId === 'ramp')!;
    expect(f60.angleDeg).toBeCloseTo(45, 4);
    expect(f60.needsSupport).toBe(true); // 45 < 60
    expect(at30.faces.find((x) => x.faceId === 'ramp')!.needsSupport).toBe(false); // 45 > 30
  });

  it('reports the worst (shallowest) overhang angle, 90 when none', () => {
    // Body with a bed + a flat downward ledge above it → worst = 0 (a bridge).
    const bed = squareFace('bed',
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }],
      { x: 0, y: -1, z: 0 });
    const ledge = squareFace('ledge',
      [{ x: 0, y: 5, z: 0 }, { x: 1, y: 5, z: 0 }, { x: 1, y: 5, z: 1 }, { x: 0, y: 5, z: 1 }],
      { x: 0, y: -1, z: 0 });
    const body: SolidBody = { id: 'b', name: 'b',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 0 }], faces: [bed, ledge], edges: [] };
    expect(analyzeOverhangs(body).worstAngleDeg).toBeCloseTo(0, 4);

    // A box has no overhangs → worst stays 90.
    expect(analyzeOverhangs(createBox(10, 10, 10)).worstAngleDeg).toBe(90);
  });

  it('does not count the bed-resting bottom face of a box', () => {
    const box = createBox(10, 10, 10); // bottom face is flat & downward, on the plate
    const excluded = analyzeOverhangs(box);
    expect(excluded.overhangArea).toBeCloseTo(0, 5); // bottom is on the bed → no support

    const included = analyzeOverhangs(box, { includeBaseFaces: true });
    expect(included.overhangArea).toBeCloseTo(100, 0); // now the 10×10 bottom counts
  });
});

describe('estimateMass', () => {
  it('computes mass from volume and density', () => {
    const box = createBox(10, 10, 10); // 1000 mm³ = 1 cm³
    const est = estimateMass(box, 1.24);
    expect(est.volumeMm3).toBeCloseTo(1000, 3);
    expect(est.volumeCm3).toBeCloseTo(1, 5);
    expect(est.massGrams).toBeCloseTo(1.24, 5);
  });

  it('estimateMassForMaterial uses the material density', () => {
    const box = createBox(10, 10, 10);
    const est = estimateMassForMaterial(box, 'ABS');
    expect(est.density).toBe(MATERIAL_DENSITIES.ABS);
    expect(est.massGrams).toBeCloseTo(MATERIAL_DENSITIES.ABS, 5);
  });
});

describe('checkBuildVolume', () => {
  it('fits inside a large build volume', () => {
    const box = createBox(10, 10, 10);
    const check = checkBuildVolume(box, { x: 200, y: 200, z: 200 });
    expect(check.fits).toBe(true);
    expect(check.size.x).toBeCloseTo(10, 3);
  });

  it('reports overage when the part is too big', () => {
    const box = createBox(10, 10, 10);
    const check = checkBuildVolume(box, { x: 5, y: 5, z: 5 });
    expect(check.fits).toBe(false);
    expect(check.overage.x).toBeCloseTo(5, 3);
  });
});

describe('analyzePrintability', () => {
  it('combines overhang, mass, and build-volume reports', () => {
    const box = createBox(10, 10, 10);
    const report = analyzePrintability(box, { buildVolume: { x: 200, y: 200, z: 200 } });
    expect(report.mass.massGrams).toBeCloseTo(MATERIAL_DENSITIES.PLA, 5);
    expect(report.buildVolume?.fits).toBe(true);
    expect(report.overhangs.faces.length).toBe(box.faces.length);
  });
});
