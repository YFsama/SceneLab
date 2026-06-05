import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine, addCircle, addArc } from './engine';
import {
  measurePointDistance,
  measureLineLength,
  measureRadius,
  measureAngleBetweenLines,
  listDimensions,
  previewDimensionLabel,
} from './dimensions';

describe('previewDimensionLabel', () => {
  const o = { x: 0, y: 0 };
  it('shows a line length and angle', () => {
    expect(previewDimensionLabel('line', o, { x: 3, y: 4 })).toBe('5.0  53°');
    expect(previewDimensionLabel('line', o, { x: 10, y: 0 })).toBe('10.0  0°');
    expect(previewDimensionLabel('line', o, { x: 0, y: 5 })).toBe('5.0  90°');
    // Angle wraps to 0–360 (pointing in -X is 180°).
    expect(previewDimensionLabel('line', o, { x: -4, y: 0 })).toBe('4.0  180°');
  });
  it('shows width × height for a rectangle (absolute, any drag direction)', () => {
    expect(previewDimensionLabel('rect', o, { x: -10, y: 5 })).toBe('10.0 × 5.0');
  });
  it('shows radius for circles and arcs', () => {
    expect(previewDimensionLabel('circle', o, { x: 6, y: 8 })).toBe('R10.0');
    expect(previewDimensionLabel('arc', o, { x: 6, y: 8 })).toBe('R10.0');
  });
  it('shows radius and side count for a polygon', () => {
    expect(previewDimensionLabel('polygon', o, { x: 3, y: 4 }, 5)).toBe('R5.0 · 5');
  });
  it('returns empty for the select tool', () => {
    expect(previewDimensionLabel('select', o, { x: 1, y: 1 })).toBe('');
  });
});

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

  it('lists dimensions for arcs', () => {
    const s = createSketch('xy');
    addArc(s, 0, 0, 5, 0, Math.PI);
    const dims = listDimensions(s);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.kind).toBe('radius');
    expect(dims[0]!.value).toBeCloseTo(5, 6);
  });

  it('returns empty for empty sketch', () => {
    const s = createSketch('xy');
    expect(listDimensions(s)).toHaveLength(0);
  });

  it('lists dimensions for multiple lines', () => {
    const s = createSketch('xy');
    addLine(s, 0, 0, 3, 0); // length 3
    addLine(s, 0, 0, 0, 4); // length 4
    addLine(s, 0, 0, 5, 0); // length 5
    const dims = listDimensions(s);
    expect(dims).toHaveLength(3);
  });

  it('returns empty for a point-only sketch', () => {
    const s = createSketch('xy');
    addPoint(s, 5, 10);
    expect(listDimensions(s)).toHaveLength(0);
  });

  it('measures multiple circles', () => {
    const s = createSketch('xy');
    addCircle(s, 0, 0, 3);
    addCircle(s, 10, 0, 5);
    const dims = listDimensions(s);
    expect(dims).toHaveLength(2);
    expect(dims.every((d) => d.kind === 'radius')).toBe(true);
  });

  it('measures 45° angle between lines', () => {
    const s = createSketch('xy');
    const a = addLine(s, 0, 0, 10, 0);
    const b = addLine(s, 0, 0, 10, 10);
    const d = measureAngleBetweenLines(s, a.id, b.id)!;
    expect(d.value).toBeCloseTo(45, 0);
  });

  it('measures 60° angle between lines', () => {
    const s = createSketch('xy');
    const a = addLine(s, 0, 0, 10, 0);
    const b = addLine(s, 0, 0, 5, 8.66); // ~60°
    const d = measureAngleBetweenLines(s, a.id, b.id)!;
    expect(d.value).toBeCloseTo(60, 0);
  });

  it('measures 0° angle for parallel lines', () => {
    const s = createSketch('xy');
    const a = addLine(s, 0, 0, 10, 0);
    const b = addLine(s, 0, 5, 10, 5);
    const d = measureAngleBetweenLines(s, a.id, b.id)!;
    expect(d.value).toBeCloseTo(0, 0);
  });
});
