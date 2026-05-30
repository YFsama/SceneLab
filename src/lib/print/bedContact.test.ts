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

  it('counts only the outer boundary when the base is two triangles', () => {
    // A 10×10 base split into two triangles sharing the diagonal, plus a top
    // face so a height exists. The shared diagonal must not count toward the
    // brim perimeter — only the four outer 10mm edges (= 40mm).
    const base: SolidBody = {
      id: 't',
      name: 't',
      vertices: [],
      faces: [
        {
          id: 'b1',
          vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }],
          normal: { x: 0, y: -1, z: 0 },
        },
        {
          id: 'b2',
          vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }],
          normal: { x: 0, y: -1, z: 0 },
        },
        {
          id: 'top',
          vertices: [{ x: 0, y: 5, z: 0 }, { x: 10, y: 5, z: 0 }, { x: 10, y: 5, z: 10 }],
          normal: { x: 0, y: 1, z: 0 },
        },
      ],
      edges: [],
    };
    const r = analyzeBedContact(base);
    expect(r.contactFaces).toBe(2);
    expect(r.contactArea).toBeCloseTo(100, 3); // two 50mm² triangles
    // Diagonal (length √200) shared by both triangles is excluded → 4×10 = 40.
    expect(r.perimeterMm).toBeCloseTo(40, 3);
  });

  it('returns zeros for an empty body', () => {
    const empty: SolidBody = { id: 'e', name: 'e', vertices: [], faces: [], edges: [] };
    const r = analyzeBedContact(empty);
    expect(r.contactArea).toBe(0);
    expect(r.tallness).toBe(0);
  });
});
