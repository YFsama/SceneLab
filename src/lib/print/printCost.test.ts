import { describe, it, expect } from 'vitest';
import { estimatePrintCost } from './printCost';
import { createBox } from '../geometry';

describe('estimatePrintCost', () => {
  // 20mm cube, solid PLA → 8 cm³ → 9.92 g.
  const box = createBox(20, 20, 20);

  it('computes material cost from mass and price/kg', () => {
    const est = estimatePrintCost(box, { infill: 1, material: 'PLA', pricePerKg: 25 });
    expect(est.filamentMassG).toBeCloseTo(9.92, 1);
    // 9.92 g = 0.00992 kg × 25 = 0.248 → 0.25
    expect(est.materialCost).toBeCloseTo(0.25, 2);
    expect(est.machineCost).toBe(0); // default hourly rate 0
    expect(est.totalCost).toBeCloseTo(0.25, 2);
  });

  it('adds machine time cost when an hourly rate is given', () => {
    const est = estimatePrintCost(box, { infill: 1, hourlyRate: 60 });
    const expectedMachine = Math.round((est.printTimeMinutes / 60) * 60 * 100) / 100;
    expect(est.machineCost).toBeCloseTo(expectedMachine, 2);
    // total is rounded from the unrounded sum, so allow a cent vs summing rounded parts
    expect(est.totalCost).toBeCloseTo(est.materialCost + est.machineCost, 1);
    expect(est.machineCost).toBeGreaterThan(0);
  });

  it('reduces mass with lower infill', () => {
    const solid = estimatePrintCost(box, { infill: 1, material: 'PLA', pricePerKg: 25 });
    const sparse = estimatePrintCost(box, { infill: 0.2, material: 'PLA', pricePerKg: 25 });
    expect(sparse.filamentMassG).toBeLessThan(solid.filamentMassG);
    expect(sparse.materialCost).toBeLessThan(solid.materialCost);
  });

  it('different infill produces different print times', () => {
    const solid = estimatePrintCost(box, { infill: 1, material: 'PLA', pricePerKg: 25 });
    const sparse = estimatePrintCost(box, { infill: 0.2, material: 'PLA', pricePerKg: 25 });
    // Less material = faster print.
    expect(sparse.printTimeMinutes).toBeLessThan(solid.printTimeMinutes);
  });

  it('all costs are non-negative', () => {
    const est = estimatePrintCost(box, { infill: 0.5, material: 'PLA', pricePerKg: 20, hourlyRate: 50 });
    expect(est.materialCost).toBeGreaterThanOrEqual(0);
    expect(est.machineCost).toBeGreaterThanOrEqual(0);
    expect(est.totalCost).toBeGreaterThanOrEqual(0);
    expect(est.filamentMassG).toBeGreaterThanOrEqual(0);
    expect(est.printTimeMinutes).toBeGreaterThanOrEqual(0);
  });
});
