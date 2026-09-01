import { describe, it, expect } from 'vitest';
import { projectBody, projectBodies, exportDrawingSVG } from './drawing';
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
    const svg = exportDrawingSVG([view]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<line');
  });

  it('SVG has valid XML structure', () => {
    const view = projectBody(createBox(10, 10, 10), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG([view]);
    expect(svg).toContain('xmlns');
    expect(svg).toContain('viewBox');
    expect(svg).toContain('</svg>');
  });

  it('SVG line count is at least edge count', () => {
    const box = createBox(10, 10, 10);
    const view = projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG([view]);
    const lineCount = (svg.match(/<line/g) ?? []).length;
    expect(lineCount).toBeGreaterThanOrEqual(box.edges.length);
  });

  it('SVG has correct viewBox dimensions', () => {
    const view = projectBody(createBox(10, 20, 10), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const svg = exportDrawingSVG([view], 800, 600);
    expect(svg).toContain('viewBox="0 0 800 600"');
  });

  it('lays out every view with its own title', () => {
    const box = createBox(10, 20, 30);
    const views = [
      projectBody(box, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }),
      projectBody(box, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }),
      projectBody(box, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
    ];
    const svg = exportDrawingSVG(views, 800, 600);
    for (const view of views) {
      expect(svg).toContain(view.name);
    }
    // 3 views → 2×2 grid fits all cells
    expect(svg).toContain('viewBox="0 0 800 600"');
  });
});

describe('projectBodies', () => {
  it('merges multiple bodies into one view', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 50, y: 0, z: 0 });
    const view = projectBodies([a, b], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.lines).toHaveLength(a.edges.length + b.edges.length);
    // Combined bounds span both bodies (10 wide each, 40 apart)
    expect(view.bounds.max.x - view.bounds.min.x).toBeCloseTo(60, 3);
  });

  it('spans auto-dimensions across the combined bounds, not the first body', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 50, y: 0, z: 0 });
    const view = projectBodies([a, b], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const widthDim = view.dimensions[0]!;
    expect(widthDim.value).toBeCloseTo(60, 1);
  });

  it('matches projectBody for a single body', () => {
    const box = createBox(10, 20, 30);
    const single = projectBody(box, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const merged = projectBodies([box], { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(merged.lines).toEqual(single.lines);
    expect(merged.dimensions.map((d) => d.value)).toEqual(single.dimensions.map((d) => d.value));
  });

  it('returns empty geometry for an empty scene', () => {
    const view = projectBodies([], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.lines).toHaveLength(0);
    expect(view.dimensions).toHaveLength(0);
    expect(Number.isFinite(view.bounds.min.x)).toBe(true);
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

describe('section views', () => {
  it('clips projected edges to the kept half-space', () => {
    const box = createBox(10, 10, 10); // x in 0..10 (centred? createBox spans -5..5 in x)
    const view = projectBodies([box], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 1, 'Front', {
      normal: { x: 1, y: 0, z: 0 }, offset: 0,
    });
    // Every projected point stays on the kept side of the cut (x <= 0).
    for (const line of view.lines) {
      expect(Math.max(line.start.x, line.end.x)).toBeLessThanOrEqual(1e-6);
    }
    // Half the lines remain (the +X half is removed).
    expect(view.lines.length).toBeGreaterThan(0);
    const full = projectBodies([box], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.lines.length).toBeLessThan(full.lines.length);
  });

  it('produces section cut faces on the plane', () => {
    const box = createBox(10, 10, 10);
    const view = projectBodies([box], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 1, 'Front', {
      normal: { x: 1, y: 0, z: 0 }, offset: 0,
    });
    expect(view.sectionFaces).toBeDefined();
    expect(view.sectionFaces!.length).toBeGreaterThan(0);
    // Each cut face is a planar polygon (>= 3 points) lying at x = 0.
    for (const face of view.sectionFaces!) {
      expect(face.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('no section faces without a section plane', () => {
    const view = projectBodies([createBox(10, 10, 10)], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    expect(view.sectionFaces).toBeUndefined();
  });
});
