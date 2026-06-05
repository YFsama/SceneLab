import { describe, it, expect } from 'vitest';
import { export3MF } from './threemf';
import { createBox, createCylinder, createSphere } from '../geometry/brep';
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

  it('exports a cylinder with vertices and triangles', () => {
    const xml = export3MF([createCylinder(5, 10, 16)]);
    expect(xml).toContain('<vertices>');
    expect(xml).toContain('<triangles>');
    expect((xml.match(/<vertex /g) ?? []).length).toBeGreaterThan(0);
    expect((xml.match(/<triangle /g) ?? []).length).toBeGreaterThan(0);
  });

  it('exports a sphere with vertices and triangles', () => {
    const xml = export3MF([createSphere(5, 16)]);
    expect(xml).toContain('<vertices>');
    expect(xml).toContain('<triangles>');
    expect((xml.match(/<vertex /g) ?? []).length).toBeGreaterThan(0);
    expect((xml.match(/<triangle /g) ?? []).length).toBeGreaterThan(0);
  });

  it('exports multiple bodies in one file', () => {
    const box = createBox(10, 10, 10);
    const cyl = translateBody(createCylinder(5, 10, 16), { x: 20, y: 0, z: 0 });
    const xml = export3MF([box, cyl]);
    expect((xml.match(/<object /g) ?? []).length).toBe(2);
    expect((xml.match(/<vertices>/g) ?? []).length).toBe(2);
    expect((xml.match(/<triangles>/g) ?? []).length).toBe(2);
  });

  it('all triangle indices are valid for multiple bodies', () => {
    const box = createBox(10, 10, 10);
    const sphere = createSphere(5, 8);
    const xml = export3MF([box, sphere]);
    // No -1 indices (which would indicate missing vertices).
    expect(xml).not.toContain('"-1"');
  });
});
