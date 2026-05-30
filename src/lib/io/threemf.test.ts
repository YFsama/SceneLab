import { describe, it, expect } from 'vitest';
import { export3MF } from './threemf';
import { createBox } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('export3MF', () => {
  it('emits a 3MF model with vertices and triangles for a box', () => {
    const xml = export3MF([createBox(10, 10, 10)]);
    expect(xml).toContain('<model');
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('<vertices>');
    expect(xml).toContain('<triangles>');
    // A box: 8 vertices and 6 quads → 12 triangles.
    expect((xml.match(/<vertex /g) ?? []).length).toBe(8);
    expect((xml.match(/<triangle /g) ?? []).length).toBe(12);
  });

  it('includes an object per body', () => {
    const xml = export3MF([createBox(2, 2, 2), createBox(3, 3, 3)]);
    expect((xml.match(/<object /g) ?? []).length).toBe(2);
  });

  it('emits valid triangle indices for a transformed body', () => {
    // Operations rebuild face vertices as separate objects from body.vertices,
    // so reference-identity indexing would yield invalid -1 indices here.
    const xml = export3MF([translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 })]);
    expect(xml).not.toContain('"-1"');
    expect((xml.match(/<vertex /g) ?? []).length).toBe(8);
    expect((xml.match(/<triangle /g) ?? []).length).toBe(12);
    // Every triangle index must reference an emitted vertex (0..7).
    for (const m of xml.matchAll(/v[123]="(-?\d+)"/g)) {
      const idx = Number(m[1]);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
    }
  });
});
