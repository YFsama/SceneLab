import { describe, it, expect } from 'vitest';
import { createSketch, addLine, addCircle, addConstraint } from './engine';
import { constraintGlyphs, CONSTRAINT_GLYPHS } from './constraintGlyphs';
import type { ConstraintType } from './types';

describe('CONSTRAINT_GLYPHS', () => {
  it('has a badge for every constraint type', () => {
    const types: ConstraintType[] = [
      'horizontal', 'vertical', 'parallel', 'perpendicular', 'coincident',
      'fixed', 'equal', 'distance', 'radius', 'concentric', 'tangent', 'symmetric',
    ];
    for (const t of types) expect(CONSTRAINT_GLYPHS[t].length).toBeGreaterThan(0);
  });
});

describe('constraintGlyphs (viewport badges)', () => {
  it('anchors a line constraint at the line midpoint', () => {
    const s = createSketch('xz');
    const l = addLine(s, 0, 0, 10, 0);
    addConstraint(s, 'horizontal', [l.id]);
    const glyphs = constraintGlyphs(s);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.text).toBe('H');
    expect(glyphs[0]!.x).toBeCloseTo(5, 9);
    expect(glyphs[0]!.y).toBeCloseTo(0, 9);
  });

  it('anchors a radius constraint at the circle centre with the R badge', () => {
    const s = createSketch('xz');
    const c = addCircle(s, 3, 4, 5);
    addConstraint(s, 'radius', [c.id], 5);
    const glyphs = constraintGlyphs(s);
    expect(glyphs[0]!.text).toBe('R');
    expect(glyphs[0]!.x).toBeCloseTo(3, 9);
    expect(glyphs[0]!.y).toBeCloseTo(4, 9);
  });

  it('includes the numeric value on distance constraints', () => {
    const s = createSketch('xz');
    const l = addLine(s, 0, 0, 25, 0);
    addConstraint(s, 'distance', [l.id], 25);
    expect(constraintGlyphs(s)[0]!.text).toBe('D25.0');
  });

  it('skips constraints whose entities are gone', () => {
    const s = createSketch('xz');
    addConstraint(s, 'horizontal', ['missing_id']);
    expect(constraintGlyphs(s)).toHaveLength(0);
  });

  it('emits one glyph per constraint, in sketch order', () => {
    const s = createSketch('xz');
    const a = addLine(s, 0, 0, 10, 0);
    const b = addLine(s, 0, 5, 10, 5);
    addConstraint(s, 'horizontal', [a.id]);
    addConstraint(s, 'parallel', [a.id, b.id]);
    const glyphs = constraintGlyphs(s);
    expect(glyphs.map((g) => g.text)).toEqual(['H', '∥']);
  });
});
