import { describe, it, expect } from 'vitest';
import { estimatePrintJob } from './printJob';
import { createBox } from '../geometry';

describe('estimatePrintJob', () => {
  // 20mm cube: volume 8000 mm³, surface area 2400 mm².
  // wall (1.2mm) = min(8000, 2400*1.2=2880) = 2880; interior = 5120.
  const box = createBox(20, 20, 20);

  it('computes material volume from walls + infilled interior', () => {
    const est = estimatePrintJob(box, { infill: 0.2, wallThickness: 1.2 });
    expect(est.solidVolumeMm3).toBeCloseTo(8000, 0);
    // 2880 + 5120 * 0.2 = 3904
    expect(est.materialVolumeMm3).toBeCloseTo(3904, 0);
  });

  it('solid infill (1.0) uses the whole volume', () => {
    const est = estimatePrintJob(box, { infill: 1 });
    expect(est.materialVolumeMm3).toBeCloseTo(8000, 0);
    expect(est.filamentMassG).toBeCloseTo(8 * 1.24, 1); // PLA
  });

  it('zero infill leaves only the walls', () => {
    const est = estimatePrintJob(box, { infill: 0, wallThickness: 1.2 });
    expect(est.materialVolumeMm3).toBeCloseTo(2880, 0);
  });

  it('derives filament length, mass and time consistently', () => {
    const est = estimatePrintJob(box, { infill: 0.2, wallThickness: 1.2, volumetricSpeed: 8 });
    // length = 3904 / (π·0.875²)=2.4053 → ~1623mm → ~1.62m
    expect(est.filamentLengthM).toBeCloseTo(1.623, 1);
    expect(est.filamentMassG).toBeCloseTo(3.904 * 1.24, 1);
    // time = 3904 / (8*60) ≈ 8.13 min
    expect(est.printTimeMinutes).toBeCloseTo(8.13, 1);
  });

  it('reports layer count from the build-axis height and layer height', () => {
    const est = estimatePrintJob(box, { layerHeight: 0.2 }); // 20mm tall / 0.2
    expect(est.heightMm).toBeCloseTo(20, 5);
    expect(est.layerHeight).toBe(0.2);
    expect(est.layerCount).toBe(100);

    const coarse = estimatePrintJob(box, { layerHeight: 0.3 }); // ceil(20/0.3)=67
    expect(coarse.layerCount).toBe(67);
  });

  it('clamps infill to [0,1] and honors material', () => {
    const over = estimatePrintJob(box, { infill: 5 });
    expect(over.infill).toBe(1);
    const abs = estimatePrintJob(box, { infill: 1, material: 'ABS' });
    expect(abs.filamentMassG).toBeCloseTo(8 * 1.04, 1);
  });
});
