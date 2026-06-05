import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { createBox, createCylinder, createSphere } from '../geometry/brep';

describe('exportSTEP', () => {
  it('produces a valid STEP file header', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('HEADER');
    expect(step).toContain('FILE_DESCRIPTION');
    expect(step).toContain('FILE_SCHEMA');
    expect(step).toContain('ENDSEC');
    expect(step).toContain('END-ISO-10303-21');
  });

  it('contains CARTESIAN_POINT entities for vertices', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('CARTESIAN_POINT');
    expect(step).toContain('VERTEX_POINT');
  });

  it('contains ADVANCED_FACE entities for faces', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    expect(step).toContain('PLANE');
  });

  it('contains EDGE_CURVE and ORIENTED_EDGE', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('EDGE_CURVE');
    expect(step).toContain('ORIENTED_EDGE');
    expect(step).toContain('EDGE_LOOP');
  });

  it('includes the body name in the product', () => {
    const box = createBox(10, 10, 10);
    box.name = 'TestPart';
    const step = exportSTEP(box);
    expect(step).toContain('TestPart');
  });

  it('has correct entity count for a box (6 faces)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Count ADVANCED_FACE entities — should be 6 for a box.
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBe(6);
  });

  it('contains AXIS2_PLACEMENT_3D for each face plane', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const axisCount = (step.match(/AXIS2_PLACEMENT_3D/g) ?? []).length;
    expect(axisCount).toBe(6); // one per face
  });

  it('has MANIFOLD_SURFACE_SHAPE_REPRESENTATION', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
  });

  it('has SHAPE_REPRESENTATION_RELATIONSHIP', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('SHAPE_REPRESENTATION_RELATIONSHIP');
  });

  it('contains LINE entities for edges', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('LINE');
  });

  it('contains DIRECTION entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('DIRECTION');
  });

  it('contains VECTOR entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('VECTOR');
  });

  it('produces valid file structure with DATA section', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const lines = step.split('\n');
    expect(lines[0]).toBe('ISO-10303-21;');
    expect(step).toContain('HEADER;');
    expect(step).toContain('DATA;');
    expect(step).toContain('ENDSEC;');
    expect(step).toContain('END-ISO-10303-21;');
  });

  it('has valid entity references (no dangling #N)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Extract all entity definitions (#N=...).
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      defined.add(parseInt(match[1]!));
    }
    // Extract all entity references (#N).
    const refs = new Set<number>();
    const refUsePattern = /#(\d+)/g;
    while ((match = refUsePattern.exec(step)) !== null) {
      refs.add(parseInt(match[1]!));
    }
    // All referenced entities should be defined.
    for (const r of refs) {
      expect(defined.has(r)).toBe(true);
    }
  });

  it('has consistent entity count (no duplicates)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      const eid = parseInt(match[1]!);
      expect(defined.has(eid)).toBe(false); // no duplicate definitions
      defined.add(eid);
    }
    expect(defined.size).toBeGreaterThan(10); // reasonable entity count
  });

  it('exports a cylinder with valid structure', () => {
    const cyl = createCylinder(5, 10, 16);
    const step = exportSTEP(cyl);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6); // cylinder has more faces than box
  });

  it('exports a sphere with valid structure', () => {
    const sphere = createSphere(5, 16);
    const step = exportSTEP(sphere);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6);
  });

  it('all exported bodies have valid entity references', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const step = exportSTEP(make());
      const defined = new Set<number>();
      const defPattern = /#(\d+)=/g;
      let m;
      while ((m = defPattern.exec(step)) !== null) defined.add(parseInt(m[1]!));
      const refPattern = /#(\d+)/g;
      while ((m = refPattern.exec(step)) !== null) {
        expect(defined.has(parseInt(m[1]!))).toBe(true);
      }
    }
  });
});
