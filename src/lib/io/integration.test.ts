import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { exportSTLAscii } from './stl';
import { exportOBJ } from './obj';
import { export3MF } from './threemf';
import { createBox, createCylinder } from '../geometry/brep';

describe('IO integration — export formats', () => {
  const box = createBox(10, 20, 30);
  const cylinder = createCylinder(5, 10, 16);

  it('STEP export produces valid ISO 10303-21 for a box', () => {
    const step = exportSTEP(box);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step.trim().endsWith('END-ISO-10303-21;')).toBe(true);
    // Should have at least 6 faces.
    expect((step.match(/ADVANCED_FACE/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('STEP export produces valid output for a cylinder', () => {
    const step = exportSTEP(cylinder);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('CLOSED_SHELL');
    // Cylinder has more faces than a box.
    expect((step.match(/ADVANCED_FACE/g) ?? []).length).toBeGreaterThan(6);
  });

  it('STL export produces valid ASCII STL', () => {
    const stl = exportSTLAscii(box);
    expect(stl).toContain('solid');
    expect(stl).toContain('endsolid');
    expect(stl).toContain('facet normal');
    expect(stl).toContain('vertex');
  });

  it('OBJ export produces valid Wavefront OBJ', () => {
    const obj = exportOBJ(box);
    expect(obj).toContain('# SceneLab OBJ export');
    expect(obj).toContain('v '); // vertex
    expect(obj).toContain('f '); // face
  });

  it('3MF export produces valid XML', () => {
    const threemf = export3MF([box]);
    expect(threemf).toContain('<?xml');
    expect(threemf).toContain('<model');
    expect(threemf).toContain('<mesh');
    expect(threemf).toContain('<vertices>');
    expect(threemf).toContain('<triangles>');
  });

  it('all formats produce non-empty output for the same body', () => {
    const formats = [
      { name: 'STEP', content: exportSTEP(box) },
      { name: 'STL', content: exportSTLAscii(box) },
      { name: 'OBJ', content: exportOBJ(box) },
      { name: '3MF', content: export3MF([box]) },
    ];
    for (const f of formats) {
      expect(f.content.length).toBeGreaterThan(100);
    }
  });
});
