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
});
