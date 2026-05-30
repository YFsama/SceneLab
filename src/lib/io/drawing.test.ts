import { describe, it, expect } from 'vitest';
import { projectBody, exportDrawingSVG } from './drawing';
import { createBox } from '../geometry/brep';
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
});
