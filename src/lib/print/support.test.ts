import { describe, it, expect } from 'vitest';
import { estimateSupportVolume } from './support';
import { createBox } from '../geometry';
import type { SolidBody } from '../geometry/types';

// Bed (10×10 at y=0) plus a 4×4 ledge floating at y=5, facing down.
const ledgeBody: SolidBody = {
  id: 'ledge',
  name: 'ledge',
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
      normal: { x: 0, y: -1, z: 0 },
    },
  ],
  edges: [],
};

describe('estimateSupportVolume', () => {
  it('estimates a floating ledge as area × drop × density', () => {
    // ledge area = 4×4 = 16, drop = 5, density 0.2 → 16
    const est = estimateSupportVolume(ledgeBody, { supportDensity: 0.2 });
    expect(est.supportFaces).toBe(1);
    expect(est.supportVolumeMm3).toBeCloseTo(16 * 5 * 0.2, 4);
  });

  it('scales with support density', () => {
    const est = estimateSupportVolume(ledgeBody, { supportDensity: 1 });
    expect(est.supportVolumeMm3).toBeCloseTo(16 * 5, 4);
  });

  it('a box needs no support', () => {
    const est = estimateSupportVolume(createBox(10, 10, 10));
    expect(est.supportFaces).toBe(0);
    expect(est.supportVolumeMm3).toBe(0);
  });
});
