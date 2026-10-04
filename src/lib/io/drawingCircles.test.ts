import { describe, it, expect } from 'vitest';
import { detectCircles } from './drawingCircles';
import { projectBody, projectBodies, exportDrawingSVG, viewTransform, type DrawingView } from './drawing';
import { createBox, createCylinder, createExtrude } from '../geometry/brep';

const SCALE = 50; // the sheet's projection scale

/** A cylinder along +Z (createCylinder is along +Y): its cap faces the front view. */
function cylinderAlongZ(radius: number, height: number, segments: number) {
  const profile = Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, z: 0 };
  });
  return createExtrude({ profile, direction: { x: 0, y: 0, z: 1 }, distance: height, symmetric: false });
}

describe('detectCircles — circles from tessellated caps', () => {
  it('front view of a Z-axis cylinder(5,10,32): exactly 1 center, r ≈ 5·scale', () => {
    const view = projectBody(cylinderAlongZ(5, 10, 32), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, SCALE);
    expect(view.centers).toHaveLength(1);
    expect(view.centers![0]!.x).toBeCloseTo(0, 6);
    expect(view.centers![0]!.y).toBeCloseTo(0, 6);
    expect(view.centers![0]!.radius).toBeCloseTo(5 * SCALE, 6);
  });

  it('top view of the default +Y cylinder: the stacked caps dedupe to 1 center', () => {
    const view = projectBody(createCylinder(5, 10, 32), { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, SCALE);
    // Both caps project to the same 32-gon loop; detection sees both.
    expect(view.centers).toHaveLength(1);
    expect(view.centers![0]!.radius).toBeCloseTo(5 * SCALE, 6);
  });

  it('16-gon passes; a box (square loops) produces no centers', () => {
    const cyl16 = projectBody(createCylinder(5, 10, 16), { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, SCALE);
    expect(cyl16.centers).toHaveLength(1);
    expect(cyl16.centers![0]!.radius).toBeCloseTo(5 * SCALE, 6);

    for (const dir of [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0.577, y: 0.577, z: 0.577 }, // iso: caps read as ellipses
    ]) {
      const up = Math.abs(dir.y) > 0.9 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
      const view = projectBody(createBox(10, 20, 10), dir, up, SCALE);
      expect(view.centers ?? []).toHaveLength(0);
      // …and the side view of a cylinder (caps collapse to lines) finds none.
      const side = projectBody(createCylinder(5, 10, 32), dir, up, SCALE);
      expect(side.arcs).toHaveLength(0);
    }
  });

  it('front (side) view of a +Y cylinder: caps collapse to lines, no circle', () => {
    const view = projectBody(createCylinder(5, 10, 32), { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, SCALE);
    expect(view.centers ?? []).toHaveLength(0);
  });

  it('standalone detectCircles dedupes coincident circles', () => {
    // Two identical 24-gon loops (a stacked-cap projection) → one detection.
    const ring = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return { x: Math.cos(a) * 3, y: Math.sin(a) * 3 };
    });
    const lines = ring.map((p, i) => {
      const q = ring[(i + 1) % 24]!;
      return { start: p, end: q };
    });
    const d = detectCircles([...lines, ...lines]);
    expect(d.centers).toHaveLength(1);
    expect(d.centers[0]!.radius).toBeCloseTo(3, 6);
  });
});

describe('detectCircles — arcs from sectioned caps', () => {
  it('sectioned cylinder top view: open half-caps fit arcs, not centers, with the right radius', () => {
    const view = projectBodies(
      [createCylinder(5, 10, 32)],
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: -1 },
      SCALE,
      'Top',
      { normal: { x: 1, y: 0, z: 0 }, offset: 0 },
    );
    expect(view.arcs).toHaveLength(1); // both cut caps fit the same arc → deduped
    expect(view.centers ?? []).toHaveLength(0); // the caps are cut open — no circle
    for (const arc of view.arcs) {
      expect(arc.radius).toBeCloseTo(5 * SCALE, 3);
      expect(arc.center.x).toBeCloseTo(0, 3);
      expect(arc.center.y).toBeCloseTo(0, 3);
    }
  });

  it('draws the fitted arc as an SVG path arc (start/end honored), not a full circle', () => {
    const view = projectBodies(
      [createCylinder(5, 10, 32)],
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: -1 },
      SCALE,
      'Top',
      { normal: { x: 1, y: 0, z: 0 }, offset: 0 },
    );
    const svg = exportDrawingSVG([view]);
    expect(svg).toMatch(/ A \d+(\.\d+)? \d+(\.\d+)? 0 [01] [01] /); // SVG elliptical-arc command
    expect(svg).not.toContain('<circle cx='); // no full-circle fallback for arcs
  });
});

describe('center marks in the SVG export', () => {
  const view = projectBody(createCylinder(5, 10, 32), { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, SCALE);
  // A single view fills the whole 800×600 sheet cell in exportDrawingSVG.
  const transform = viewTransform(view, { x: 0, y: 0, w: 800, h: 600 });

  /** All <line> elements of the SVG as [x1,y1,x2,y2] tuples. */
  function svgLines(svg: string): { x1: number; y1: number; x2: number; y2: number }[] {
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const m of svg.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)) {
      out.push({ x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! });
    }
    return out;
  }

  it('emits the cross near the projected circle center, arms 1.25× the radius', () => {
    const svg = exportDrawingSVG([view]);
    const c = transform.toSheet({ x: view.centers![0]!.x, y: view.centers![0]!.y });
    const arm = view.centers![0]!.radius * transform.scale * 1.25;
    const lines = svgLines(svg);
    // Horizontal arm: midpoint at the center, half-length ≈ arm.
    const h = lines.find(
      (l) =>
        Math.abs(l.y1 - l.y2) < 0.01 &&
        Math.abs((l.y1 + l.y2) / 2 - c.y) < 0.5 &&
        Math.abs((l.x1 + l.x2) / 2 - c.x) < 0.5 &&
        Math.abs((l.x2 - l.x1) / 2 - arm) < 0.5,
    );
    expect(h).toBeDefined();
    // Vertical arm likewise.
    const v = lines.find(
      (l) =>
        Math.abs(l.x1 - l.x2) < 0.01 &&
        Math.abs((l.x1 + l.x2) / 2 - c.x) < 0.5 &&
        Math.abs((l.y1 + l.y2) / 2 - c.y) < 0.5 &&
        Math.abs((l.y2 - l.y1) / 2 - arm) < 0.5,
    );
    expect(v).toBeDefined();
  });

  it('detail views clip the cross arms to the crop circle and skip far-off marks', () => {
    const marked: DrawingView = {
      name: 'Top',
      lines: [],
      arcs: [],
      dimensions: [],
      bounds: { min: { x: -10, y: -10 }, max: { x: 10, y: 10 } },
      centers: [{ x: 0, y: 0, radius: 5 }],
    };
    const detail = (center: { x: number; y: number }) => ({
      id: 'ddetail_1',
      viewIndex: 0,
      center,
      radius: 4, // smaller than the arm reach (6.25) → arms get clipped
      scale: 2,
    });
    const base = exportDrawingSVG([marked], 800, 600, { details: [detail({ x: 0, y: 0 })] });
    expect(base).toContain('DETAIL A (2:1)');
    // The mark's center is inside the crop: its cross appears in the DETAIL
    // panel (arms clipped to r=4) AND over the base view itself — 4 lines
    // over the no-mark baseline (the hatch pattern's 1 line).
    const nearCount = svgLines(base).length;

    const noMark: DrawingView = { ...marked, centers: undefined };
    const noMarkSvg = exportDrawingSVG([noMark], 800, 600, { details: [detail({ x: 0, y: 0 })] });
    expect(nearCount).toBe(svgLines(noMarkSvg).length + 4);

    // A mark wholly outside the crop circle contributes nothing to the panel
    // (only the base view's own cross remains).
    const farSvg = exportDrawingSVG([marked], 800, 600, { details: [detail({ x: 50, y: 50 })] });
    expect(svgLines(farSvg).length).toBe(svgLines(noMarkSvg).length + 2);
  });
});
