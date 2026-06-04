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
});
