import { describe, it, expect } from 'vitest';
import { projectBody, exportDrawingSVG } from './drawing';
import { createBox, createCylinder } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('projectBody', () => {
  const box = createBox(10, 20, 10);

  it('projects every edge to a 2D line with finite bounds', () => {
    const view = projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.lines).toHaveLength(box.edges.length);
    expect(Number.isFinite(view.bounds.min.x)).toBe(true);
    expect(Number.isFinite(view.bounds.max.y)).toBe(true);
    // Front view: width spans X (10), height spans Y (20).
    expect(view.bounds.max.x - view.bounds.min.x).toBeCloseTo(10, 3);
    expect(view.bounds.max.y - view.bounds.min.y).toBeCloseTo(20, 3);
  });

  it('does not mirror the front view: +X projects to +screen-x', () => {
    // A box sitting entirely at positive X must project to positive screen x
    // in a front view (viewDir +Z, up +Y). A flipped right-axis would put it
    // at negative x.
    const shifted = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 });
    const view = projectBody(shifted, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.bounds.min.x).toBeGreaterThan(0);
    expect(view.bounds.max.x).toBeCloseTo(25, 3);
  });

  it('names the view after the body and direction', () => {
    const view = projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.name).toContain('Box');
  });
});

describe('exportDrawingSVG', () => {
  it('emits an SVG with line elements for the projection', () => {
    const view = projectBody(createBox(10, 10, 10), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG(view);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<line');
  });

  it('SVG has valid XML structure', () => {
    const view = projectBody(createBox(10, 10, 10), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG(view);
    expect(svg).toContain('xmlns');
    expect(svg).toContain('viewBox');
    expect(svg).toContain('</svg>');
  });

  it('SVG line count is at least edge count', () => {
    const box = createBox(10, 10, 10);
    const view = projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG(view);
    const lineCount = (svg.match(/<line/g) ?? []).length;
    expect(lineCount).toBeGreaterThanOrEqual(box.edges.length);
  });

  it('SVG has correct viewBox dimensions', () => {
    const view = projectBody(createBox(10, 20, 10), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG(view, 800, 600);
    expect(svg).toContain('viewBox="0 0 800 600"');
  });
});

describe('projectBody different views', () => {
  const box = createBox(10, 20, 30);

  it('top view shows width and depth', () => {
    const view = projectBody(box, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
    expect(view.bounds.max.x - view.bounds.min.x).toBeCloseTo(10, 2);
    expect(view.bounds.max.y - view.bounds.min.y).toBeCloseTo(30, 2);
  });

  it('right view shows depth and height', () => {
    const view = projectBody(box, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(view.bounds.max.x - view.bounds.min.x).toBeCloseTo(30, 2);
    expect(view.bounds.max.y - view.bounds.min.y).toBeCloseTo(20, 2);
  });

  it('projecting a cylinder produces valid lines', () => {
    const cyl = createCylinder(5, 10, 16);
    const view = projectBody(cyl, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.lines.length).toBeGreaterThan(0);
    expect(Number.isFinite(view.bounds.min.x)).toBe(true);
  });

  it('projected lines have finite coordinates', () => {
    const view = projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    for (const line of view.lines) {
      expect(Number.isFinite(line.start.x)).toBe(true);
      expect(Number.isFinite(line.start.y)).toBe(true);
      expect(Number.isFinite(line.end.x)).toBe(true);
      expect(Number.isFinite(line.end.y)).toBe(true);
    }
  });
});
