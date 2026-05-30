import { describe, it, expect } from 'vitest';
import { createSketch, addLine, addCircle, addArc } from './engine';
import {
  measurePointDistance,
  measureLineLength,
  measureRadius,
  measureAngleBetweenLines,
  listDimensions,
} from './dimensions';

describe('sketch dimensions', () => {
  it('measures a line length', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 3, 4);
    const d = measureLineLength(s, line.id)!;
    expect(d.kind).toBe('length');
    expect(d.value).toBeCloseTo(5, 6);
    expect(d.label).toContain('mm');
  });

  it('measures the distance between two points (line endpoints)', () => {
    const s = createSketch('xy');
    const line = addLine(s, 1, 1, 4, 5);
    const d = measurePointDistance(s, line.p1Id, line.p2Id)!;
    expect(d.kind).toBe('distance');
    expect(d.value).toBeCloseTo(5, 6);
  });

  it('measures circle radius and diameter', () => {
    const s = createSketch('xy');
    const c = addCircle(s, 0, 0, 7);
    expect(measureRadius(s, c.id)!.value).toBeCloseTo(7, 6);
    const dia = measureRadius(s, c.id, true)!;
    expect(dia.kind).toBe('diameter');
    expect(dia.value).toBeCloseTo(14, 6);
    expect(dia.label).toContain('⌀');
  });

  it('measures arc radius', () => {
    const s = createSketch('xy');
    const a = addArc(s, 0, 0, 5, 0, Math.PI / 2);
    expect(measureRadius(s, a.id)!.value).toBeCloseTo(5, 6);
  });

  it('measures the angle between two lines (perpendicular → 90°)', () => {
    const s = createSketch('xy');
    const h = addLine(s, 0, 0, 10, 0);
    const v = addLine(s, 0, 0, 0, 10);
    const d = measureAngleBetweenLines(s, h.id, v.id)!;
    expect(d.kind).toBe('angle');
    expect(d.value).toBeCloseTo(90, 6);
  });

  it('angle is direction-independent (0–180)', () => {
    const s = createSketch('xy');
    const a = addLine(s, 0, 0, 10, 0);
    const b = addLine(s, 10, 0, 0, 0); // reversed, same line
    expect(measureAngleBetweenLines(s, a.id, b.id)!.value).toBeCloseTo(0, 6);
  });

  it('returns null for mismatched entity kinds', () => {
    const s = createSketch('xy');
    const line = addLine(s, 0, 0, 1, 0);
    const circle = addCircle(s, 0, 0, 2);
    expect(measureLineLength(s, circle.id)).toBeNull();
    expect(measureRadius(s, line.id)).toBeNull();
    expect(measureAngleBetweenLines(s, line.id, circle.id)).toBeNull();
    expect(measurePointDistance(s, line.id, circle.id)).toBeNull();
  });

  it('lists auto dimensions for every line and circle', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 3, 4); // length 5
    addCircle(s, 0, 0, 2); // radius 2
    const dims = listDimensions(s);
    expect(dims).toHaveLength(2);
    expect(dims.some((d) => d.kind === 'length' && Math.abs(d.value - 5) < 1e-6)).toBe(true);
    expect(dims.some((d) => d.kind === 'radius' && Math.abs(d.value - 2) < 1e-6)).toBe(true);
  });
});
