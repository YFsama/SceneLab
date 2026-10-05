import { describe, it, expect } from 'vitest';
import { detectCircles } from './drawingCircles';
import { projectBody, projectBodies, exportDrawingSVG, viewTransform, type DrawingView } from './drawing';
import { createBox, createCylinder, createExtrude } from '../geometry/brep';
import { booleanOpManifold, warmUpBooleanEngine } from '../geometry/booleanManifold';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createHoleFeature } from '../features/tree';
import { createSketch, addRectangle } from '../sketch/engine';
import type { SolidBody, Vec3 } from '../geometry/types';

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
    // A 16-gon is coarser than a circular tessellation (relative sagitta
    // 4.3% > 0.5%), so the mark quotes the across-flats incircle radius.
    expect(cyl16.centers![0]!.radius).toBeCloseTo(5 * Math.cos(Math.PI / 16) * SCALE, 6);

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
    // 24 facets at r=3: relative sagitta 0.86% > 0.5% → inscribed radius.
    expect(d.centers[0]!.radius).toBeCloseTo(3 * Math.cos(Math.PI / 24), 6);
  });
});

describe('detectCircles — honest radii and closure', () => {
  /** A regular n-gon ring of circumradius r as a segment soup (model units). */
  function ringLines(n: number, r: number) {
    const vertex = (i: number) => ({
      x: r * Math.cos((i / n) * Math.PI * 2),
      y: r * Math.sin((i / n) * Math.PI * 2),
    });
    return Array.from({ length: n }, (_, i) => ({ start: vertex(i), end: vertex(i + 1) }));
  }

  it('a ⌀6 hole tessellated by the adaptive kernel (N=55) reports r within 0.002 of 3.0', () => {
    // The T1 default lifted ⌀6 cutters from 32 to 55 facets; at that density
    // the loop is a circular tessellation, so the mark quotes the nominal
    // radius, not the incircle.
    const d = detectCircles(ringLines(55, 3));
    expect(d.centers).toHaveLength(1);
    expect(Math.abs(d.centers[0]!.radius - 3.0)).toBeLessThan(0.002);
  });

  it('a 16-gon sketch-circle extrusion reports its inscribed radius', () => {
    const d = detectCircles(ringLines(16, 3));
    expect(d.centers).toHaveLength(1);
    expect(d.centers[0]!.radius).toBeCloseTo(3 * Math.cos(Math.PI / 16), 6);
  });

  it('closes a loop whose final vertex quantizes to "-0.000000"', () => {
    // The last segment recomputes the start vertex: sin(2π) = −2.4e-16
    // formats as "-0.000000" while the start point's y = 0 formats as
    // "0.000000". Pre-fix the joint failed the closure check and the circle
    // downgraded to a full-turn arc (drawingCircles.ts:54).
    const n = 32;
    const r = 3;
    const lines = Array.from({ length: n }, (_, i) => ({
      start: { x: r * Math.cos((i / n) * Math.PI * 2), y: r * Math.sin((i / n) * Math.PI * 2) },
      end: { x: r * Math.cos(((i + 1) / n) * Math.PI * 2), y: r * Math.sin(((i + 1) / n) * Math.PI * 2) },
    }));
    const d = detectCircles(lines);
    expect(d.centers).toHaveLength(1);
    expect(d.arcs).toHaveLength(0);
    expect(d.centers[0]!.radius).toBeCloseTo(3, 6);
  });
});

describe('detectCircles — boolean-processed bodies (QA F7)', () => {
  /** Translate every position of a body (same helper style as brep tests). */
  const shift = (body: SolidBody, d: Vec3): SolidBody => {
    const t = (p: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
    return {
      ...body,
      vertices: body.vertices.map(t),
      faces: body.faces.map((f) => ({ ...f, vertices: f.vertices.map(t) })),
      edges: body.edges.map((e) => ({ ...e, start: t(e.start), end: t(e.end) })),
    };
  };

  /**
   * The QA repro shape, built through the real boolean kernel: a box, a
   * ⌀20 pocket extrude-cut 10 deep into the front face, then a ⌀6 hole
   * drilled through the pocket floor (axis = the front view direction). The
   * Manifold output's seam triangulation is the point — the annular floor's
   * radial seam spokes land exactly on the hole ring's chord vertices and
   * give them degree ≥ 4, which is where the old first-unused-edge chain
   * walk wandered off down a ~90° spoke and never closed the ring (0 centers
   * on exactly the machined part that needs marks).
   */
  async function machinedBoss(): Promise<SolidBody | null> {
    await warmUpBooleanEngine();
    const box = createBox(60, 20, 40); // x ∈ [−30,30], y ∈ [0,20], z ∈ [−20,20]
    const pocket = shift(cylinderAlongZ(10, 12, 32), { x: 0, y: 10, z: 8 }); // ⌀20, z 8..20
    const boss = booleanOpManifold(box, pocket, 'difference');
    if (!boss) return null;
    const hole = shift(cylinderAlongZ(3, 60, 32), { x: 0, y: 10, z: -30 }); // ⌀6 through the floor
    return booleanOpManifold(boss, hole, 'difference');
  }

  it('front view of the pocketed + drilled boss finds the ⌀6 hole center', async () => {
    const drilled = await machinedBoss();
    expect(drilled).not.toBeNull();
    const view = projectBody(drilled!, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, SCALE);
    // The hole ring vertices really do carry seam spokes (the bug's
    // precondition): projected degree ≥ 4 at the ring's radius.
    const q = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    const deg = new Map<string, number>();
    for (const l of view.lines) {
      for (const side of [l.start, l.end]) {
        deg.set(q(side), (deg.get(q(side)) ?? 0) + 1);
      }
    }
    const cx = 0;
    const cy = 10 * SCALE;
    const ringR = 3 * SCALE;
    const ringDegrees = [...deg.entries()]
      .filter(([k]) => {
        const [x, y] = k.split(',').map(Number) as [number, number];
        return Math.abs(Math.hypot(x - cx, y - cy) - ringR) < 0.05 * SCALE;
      })
      .map(([, d]) => d);
    expect(ringDegrees.length).toBeGreaterThanOrEqual(16); // a real tessellated ring
    expect(Math.max(...ringDegrees)).toBeGreaterThanOrEqual(4); // seam spokes present

    // Detection must find the ⌀6 hole (pre-fix this found NOTHING: the walk
    // took the first unused incident edge and never closed the ring). The
    // turning-angle continuation walks the ~11° chords; the length-consistency
    // band keeps long seam spokes and near-tangential corner spokes out.
    // Pass-30 recorded the ⌀20 pocket MOUTH ring as "defeats the walker"
    // (skip-diagonals interleaved with the 98-unit chords); with the committed
    // length-band + start-closure rules that ring now closes too — and it is a
    // TRUE circle of the front view (the mouth on the viewed face), so the
    // correct expectation is two centers: the mouth (r = 10·SCALE) and the
    // drilled hole (r = 3·SCALE), concentric at the pocket axis.
    const centers = view.centers ?? [];
    expect(centers).toHaveLength(2);
    const sortByR = (a: { radius: number }, b: { radius: number }) => a.radius - b.radius;
    const sorted = [...centers].sort(sortByR);
    for (const c of sorted) {
      expect(c.x).toBeCloseTo(0, 3);
      expect(c.y).toBeCloseTo(10 * SCALE, 3);
    }
    expect(sorted[0]!.radius).toBeCloseTo(3 * SCALE, 2);
    expect(sorted[1]!.radius).toBeCloseTo(10 * SCALE, 2);
  });

  it('a deliberately spoked ring (a radial line on every chord vertex) still chains', () => {
    const n = 32;
    const r = 5;
    const vertex = (i: number) => ({
      x: r * Math.cos((i / n) * Math.PI * 2),
      y: r * Math.sin((i / n) * Math.PI * 2),
    });
    const lines = [
      // The ring chords…
      ...Array.from({ length: n }, (_, i) => ({ start: vertex(i), end: vertex(i + 1) })),
      // …plus a radial spoke from the centre to EVERY ring vertex (degree 3 at
      // each ring vertex, degree 32 at the centre).
      ...Array.from({ length: n }, (_, i) => ({ start: { x: 0, y: 0 }, end: vertex(i) })),
    ];
    const d = detectCircles(lines);
    expect(d.centers).toHaveLength(1);
    expect(d.centers[0]!.x).toBeCloseTo(0, 6);
    expect(d.centers[0]!.y).toBeCloseTo(0, 6);
    expect(d.centers[0]!.radius).toBeCloseTo(5, 4);
  });

  it('a ring entered down a long seam spoke (walked whole, dead-ended) is carved out closed', () => {
    // The real-UI failure shape in miniature: the FIRST segment in the soup
    // is a long cap-fan spoke into one ring vertex, so the first walk enters
    // the ring at v0, walks all 32 chords and dead-ends back at v0 — never
    // closing, because the walk's start is the spoke's far end (pre-fix: the
    // ring emerged as an open chain polluted by the seam, 0 centers).
    const n = 32;
    const r = 5;
    const vertex = (i: number) => ({
      x: r * Math.cos((i / n) * Math.PI * 2),
      y: r * Math.sin((i / n) * Math.PI * 2),
    });
    const lines = [
      // The seam spoke FIRST — it seeds the first walk.
      { start: { x: 40, y: 25 }, end: vertex(0) },
      ...Array.from({ length: n }, (_, i) => ({ start: vertex(i), end: vertex(i + 1) })),
    ];
    const d = detectCircles(lines);
    expect(d.centers).toHaveLength(1);
    expect(d.centers[0]!.x).toBeCloseTo(0, 6);
    expect(d.centers[0]!.y).toBeCloseTo(0, 6);
  });

  it('a chord-length near-tangential escape at the closing vertex loses to start-closure', () => {
    // The plate-corner fan shape: at the LAST ring vertex the closing chord
    // (turn 2π/n) competes with an extra edge of the SAME chord length that
    // continues nearly straight (turn 1°) — the turning-angle + length-band
    // pick takes the escape and the ring never closed (pre-fix). The walker
    // now tries closing at the start vertex first: the loop passes the circle
    // fit, which is definitive.
    const n = 55;
    const r = 3;
    const vertex = (i: number) => ({
      x: r * Math.cos((i / n) * Math.PI * 2),
      y: r * Math.sin((i / n) * Math.PI * 2),
    });
    const last = vertex(n - 1);
    const prev = vertex(n - 2);
    const dir = { x: last.x - prev.x, y: last.y - prev.y };
    const dl = Math.hypot(dir.x, dir.y);
    const a = (1 * Math.PI) / 180; // 1° off collinear with the incoming chord
    const chord = 2 * r * Math.sin(Math.PI / n);
    const escape = {
      x: last.x + ((dir.x / dl) * Math.cos(a) - (dir.y / dl) * Math.sin(a)) * chord,
      y: last.y + ((dir.x / dl) * Math.sin(a) + (dir.y / dl) * Math.cos(a)) * chord,
    };
    const lines = [
      ...Array.from({ length: n }, (_, i) => ({ start: vertex(i), end: vertex(i + 1) })),
      { start: last, end: escape },
    ];
    const d = detectCircles(lines);
    expect(d.centers).toHaveLength(1);
    expect(Math.abs(d.centers[0]!.radius - 3.0)).toBeLessThan(0.002);
  });
});

describe('detectCircles — the real UI path (sketch rect → extrude → Feature Hole)', () => {
  /**
   * The browser repro, built through the real kernel the way tree.ts/store
   * do it: a typed 120×80 rectangle sketched on the ground ('xz') plane,
   * extruded 10 up, then two click-placed Feature→Hole operations (⌀6 near
   * the corner, then ⌀20 further in; through-all, straight down from the
   * top face). The Manifold output's seam soup — duplicated cap segments,
   * zero-length edges, cap-triangulation fan spokes from ring vertices to
   * the plate corner — is the point: its fan structure differs from the
   * synthetic boss above, which is why that test missed the regression.
   */
  async function uiPlate(): Promise<SolidBody | null> {
    await warmUpBooleanEngine();
    const tree = new FeatureTree();
    const sketch = createSketch('xz');
    addRectangle(sketch, -60, -40, 60, 40); // typed 120×80
    const sketchFeat = createSketchFeature(sketch);
    tree.addFeature(sketchFeat);
    const ext = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 10 },
      [sketchFeat.id],
    );
    tree.addFeature(ext);
    tree.recompute();
    const bodyId = tree.getLatestBodies()[0]!.id;
    tree.addFeature(createHoleFeature(
      { center: { x: -45, y: 10, z: -30 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth: null },
      [tree.findFeatureIdForBody(bodyId)!],
    ));
    tree.recompute();
    tree.addFeature(createHoleFeature(
      { center: { x: 30, y: 10, z: 20 }, direction: { x: 0, y: -1, z: 0 }, diameter: 20, depth: null },
      [tree.findFeatureIdForBody(tree.getLatestBodies()[0]!.id)!],
    ));
    tree.recompute();
    const bodies = tree.getLatestBodies();
    return bodies.length === 1 ? bodies[0]! : null;
  }

  it('top view of the real drilled plate finds both hole centers', async () => {
    const plate = await uiPlate();
    expect(plate).not.toBeNull();
    const view = projectBodies([plate!], { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, SCALE, 'Top');

    // The bug's precondition really holds in this soup: every ring vertex
    // sits at degree ≥ 3 after the prefilter (its 2 chords plus cap-fan
    // spokes), the plate interior carries a fan-spoke web whose vertices
    // reach degree ~75, and one walk sweeps that web through the rings.
    const q = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    const deg = new Map<string, number>();
    for (const l of view.lines) {
      for (const side of [l.start, l.end]) {
        deg.set(q(side), (deg.get(q(side)) ?? 0) + 1);
      }
    }
    // Top view maps world (x, z) → view (x, −z).
    for (const [cx, cz, r, n] of [[-45, -30, 3, 55], [30, 20, 10, 100]] as const) {
      const ringDegrees = [...deg.entries()]
        .filter(([k]) => {
          const [x, y] = k.split(',').map(Number) as [number, number];
          return Math.abs(Math.hypot(x - cx * SCALE, y + cz * SCALE) - r * SCALE) < 0.05 * SCALE;
        })
        .map(([, d]) => d);
      expect(ringDegrees.length).toBeGreaterThanOrEqual(n); // a real tessellated ring
      expect(Math.min(...ringDegrees)).toBeGreaterThanOrEqual(3); // spokes present
    }

    // Detection must find both anyway (pre-fix: 0 centers — the first walk
    // swept the plate's fan-spoke web through the rings and the walks never
    // closed).
    const centers = view.centers ?? [];
    expect(centers).toHaveLength(2);
    for (const [cx, cz, r] of [[-45, -30, 3], [30, 20, 10]] as const) {
      const hit = centers.find(
        (c) => Math.abs(c.x - cx * SCALE) < 0.5 && Math.abs(c.y + cz * SCALE) < 0.5,
      );
      expect(hit).toBeDefined();
      // Adaptive tessellation (⌀6 → 55 facets, ⌀20 → 100): both fine enough
      // that the nominal radius is quoted.
      expect(hit!.radius).toBeCloseTo(r * SCALE, 2);
    }
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
