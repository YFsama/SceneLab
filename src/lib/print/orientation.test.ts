import { describe, it, expect } from 'vitest';
import { recommendOrientation } from './orientation';
import { createBox } from '../geometry';
import type { SolidBody } from '../geometry/types';

describe('recommendOrientation', () => {
  it('a box needs no support in any axis-aligned orientation', () => {
    const box = createBox(10, 20, 10); // tallest along Y
    const report = recommendOrientation(box);
    expect(report.candidates).toHaveLength(6);
    // No overhangs: every orientation has zero support (bed face excluded).
    expect(report.candidates.every((c) => c.supportArea === 0)).toBe(true);
    // Tie broken by build height → a 10-tall orientation wins, not the 20-tall Y.
    expect(report.best.buildHeight).toBeCloseTo(10, 5);
    expect(report.best.label === '+X' || report.best.label === '-X' ||
           report.best.label === '+Z' || report.best.label === '-Z').toBe(true);
  });

  it('prefers the orientation that turns an overhang upward', () => {
    // Bed square at y=0 plus a downward-facing flat face floating at y=5.
    const body: SolidBody = {
      id: 'over',
      name: 'over',
      vertices: [
        { x: -5, y: 0, z: -5 },
        { x: 5, y: 0, z: -5 },
        { x: 5, y: 0, z: 5 },
        { x: -5, y: 0, z: 5 },
        { x: -2, y: 5, z: -2 },
        { x: 2, y: 5, z: -2 },
        { x: 2, y: 5, z: 2 },
        { x: -2, y: 5, z: 2 },
      ],
      faces: [
        {
          id: 'bed',
          vertices: [
            { x: -5, y: 0, z: -5 },
            { x: 5, y: 0, z: -5 },
            { x: 5, y: 0, z: 5 },
            { x: -5, y: 0, z: 5 },
          ],
          normal: { x: 0, y: -1, z: 0 },
        },
        {
          id: 'ledge',
          vertices: [
            { x: -2, y: 5, z: -2 },
            { x: 2, y: 5, z: -2 },
            { x: 2, y: 5, z: 2 },
            { x: -2, y: 5, z: 2 },
          ],
          normal: { x: 0, y: -1, z: 0 }, // downward, floating above the bed
        },
      ],
      edges: [],
    };

    const report = recommendOrientation(body);

    const plusY = report.candidates.find((c) => c.label === '+Y')!;
    const minusY = report.candidates.find((c) => c.label === '-Y')!;
    // +Y: the floating ledge is a downward overhang needing support.
    expect(plusY.supportArea).toBeGreaterThan(0);
    // Support volume = projected area (16) × drop (5) = 80.
    expect(plusY.supportVolume).toBeCloseTo(80, 4);
    // -Y: flipping makes that face point up → no support.
    expect(minusY.supportArea).toBe(0);
    expect(minusY.supportVolume).toBe(0);
    // The recommended orientation has no support.
    expect(report.best.supportArea).toBe(0);
    expect(report.best.supportVolume).toBe(0);
  });

  it('reports bed contact area and prefers it as a tie-break', () => {
    // Box 10(X)×20(Y)×10(Z): the four 10-tall orientations tie on support(0)
    // and height(10); each rests on a 20×10 = 200 mm² face.
    const report = recommendOrientation(createBox(10, 20, 10));
    expect(report.best.buildHeight).toBeCloseTo(10, 5);
    expect(report.best.bedContactArea).toBeCloseTo(200, 0);

    // A flat slab is best laid down (+/-Y), resting on its 40×40 face.
    const slab = recommendOrientation(createBox(40, 5, 40));
    expect(slab.best.buildHeight).toBeCloseTo(5, 5);
    expect(slab.best.bedContactArea).toBeCloseTo(1600, 0);
  });

  it('handles an empty body gracefully', () => {
    const body: SolidBody = { id: 'e', name: 'e', vertices: [], faces: [], edges: [] };
    const report = recommendOrientation(body);
    expect(report.candidates).toHaveLength(6);
    expect(report.best.supportArea).toBe(0);
  });
});
