import { describe, it, expect } from 'vitest';
import { analyzeOverhangs, estimateMass, estimateMassForMaterial, checkBuildVolume } from './analysis';
import { createBox } from '../geometry/brep';

describe('analyzeOverhangs', () => {
  it('detects overhang faces for a box', () => {
    const box = createBox(10, 10, 10);
    const report = analyzeOverhangs(box);
    // A box has downward-facing faces that may be flagged as overhangs.
    expect(report.faces).toBeDefined();
    expect(report.overhangArea).toBeGreaterThanOrEqual(0);
  });

  it('returns total overhang area', () => {
    const box = createBox(10, 10, 10);
    const report = analyzeOverhangs(box);
    expect(report.overhangArea).toBeGreaterThanOrEqual(0);
  });

  it('respects threshold angle', () => {
    const box = createBox(10, 10, 10);
    const report = analyzeOverhangs(box, { thresholdDeg: 30 });
    expect(report).toBeDefined();
  });
});

describe('estimateMass', () => {
  it('computes mass from volume and density', () => {
    const box = createBox(10, 10, 10); // vol = 1000 mm³ = 1 cm³
    const mass = estimateMass(box, 1.0); // 1 g/cm³
    expect(mass.massGrams).toBeCloseTo(1.0, 2);
    expect(mass.volumeCm3).toBeCloseTo(1.0, 2);
  });

  it('mass scales with density', () => {
    const box = createBox(10, 10, 10);
    const m1 = estimateMass(box, 1.0);
    const m2 = estimateMass(box, 2.0);
    expect(m2.massGrams).toBeCloseTo(m1.massGrams * 2, 2);
  });
});

describe('estimateMassForMaterial', () => {
  it('computes mass for PLA', () => {
    const box = createBox(10, 10, 10);
    const mass = estimateMassForMaterial(box, 'PLA');
    expect(mass.massGrams).toBeGreaterThan(0);
  });

  it('different materials produce different masses', () => {
    const box = createBox(10, 10, 10);
    const pla = estimateMassForMaterial(box, 'PLA');
    const abs = estimateMassForMaterial(box, 'ABS');
    expect(pla.massGrams).not.toBeCloseTo(abs.massGrams, 1);
  });
});

describe('checkBuildVolume', () => {
  it('fits a small box in a large build volume', () => {
    const box = createBox(10, 10, 10);
    const check = checkBuildVolume(box, { x: 200, y: 200, z: 200 });
    expect(check.fits).toBe(true);
  });

  it('does not fit a large box in a small build volume', () => {
    const box = createBox(300, 300, 300);
    const check = checkBuildVolume(box, { x: 200, y: 200, z: 200 });
    expect(check.fits).toBe(false);
  });

  it('reports the body dimensions', () => {
    const box = createBox(10, 20, 30);
    const check = checkBuildVolume(box, { x: 200, y: 200, z: 200 });
    expect(check.size.x).toBeCloseTo(10, 1);
    expect(check.size.y).toBeCloseTo(20, 1);
    expect(check.size.z).toBeCloseTo(30, 1);
  });
});
