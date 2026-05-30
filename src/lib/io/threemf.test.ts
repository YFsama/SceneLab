import { describe, it, expect } from 'vitest';
import { export3MF } from './threemf';
import { createBox } from '../geometry/brep';

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
});
