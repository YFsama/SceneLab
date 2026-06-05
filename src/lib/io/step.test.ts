import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { createBox } from '../geometry/brep';

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
});
