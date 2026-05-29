import { describe, it, expect } from 'vitest';
import { analyzeBedContact } from './bedContact';
import { createBox } from '../geometry';
import type { SolidBody } from '../geometry/types';

describe('analyzeBedContact', () => {
  it('measures the bottom face of a box as the contact area', () => {
    const box = createBox(10, 20, 10); // 10×10 base, 20 tall (Y up)
    const r = analyzeBedContact(box);
    expect(r.contactFaces).toBe(1);
    expect(r.contactArea).toBeCloseTo(100, 3); // 10 × 10
    expect(r.perimeterMm).toBeCloseTo(40, 3); // 4 × 10
    expect(r.height).toBeCloseTo(20, 5);
    expect(r.tallness).toBeCloseTo(20 / Math.sqrt(100), 5); // 2.0
  });

  it('reports a higher tallness for a tall, small-footprint part', () => {
    const squat = analyzeBedContact(createBox(40, 5, 40));
    const tall = analyzeBedContact(createBox(5, 40, 5));
    expect(tall.tallness).toBeGreaterThan(squat.tallness);
  });

  it('returns zeros for an empty body', () => {
    const empty: SolidBody = { id: 'e', name: 'e', vertices: [], faces: [], edges: [] };
    const r = analyzeBedContact(empty);
    expect(r.contactArea).toBe(0);
    expect(r.tallness).toBe(0);
  });
});
