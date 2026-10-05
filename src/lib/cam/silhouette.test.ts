import { describe, it, expect } from 'vitest';
import { topSilhouette, offsetPolygon, polygonArea, pointInPolygon } from './silhouette';
import { createBox, createCylinder, createTube, createExtrude, createSphere, createTorus, createPrism } from '../geometry/brep';
import type { Vec3 } from '../geometry/types';

describe('topSilhouette', () => {
  it('box → one outer loop with the 4 projected corners', () => {
    const sil = topSilhouette(createBox(50, 10, 30));
    expect(sil).not.toBeNull();
    expect(sil!.islands).toHaveLength(0);
    expect(sil!.outer.points).toHaveLength(4);
    expect(sil!.outer.area).toBeCloseTo(50 * 30, 6);
    const us = sil!.outer.points.map((p) => p.u).sort((a, b) => a - b);
    const vs = sil!.outer.points.map((p) => p.v).sort((a, b) => a - b);
    expect(us[0]!).toBeCloseTo(-25, 6);
    expect(us[3]!).toBeCloseTo(25, 6);
    expect(vs[0]!).toBeCloseTo(-15, 6);
    expect(vs[3]!).toBeCloseTo(15, 6);
  });

  it('cylinder → a 32-gon, not a rectangle', () => {
    const sil = topSilhouette(createCylinder(15, 20, 32));
    expect(sil).not.toBeNull();
    expect(sil!.outer.points).toHaveLength(32);
    expect(sil!.islands).toHaveLength(0);
    for (const p of sil!.outer.points) {
      expect(Math.hypot(p.u, p.v)).toBeCloseTo(15, 3);
    }
  });

  it('concave L-shape → outline preserves the notch (no convex hull)', () => {
    // L-shaped extrusion: 30×30 square minus a 20×20 notch.
    const profile: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 0, z: 0 },
      { x: 30, y: 0, z: 10 },
      { x: 10, y: 0, z: 10 },
      { x: 10, y: 0, z: 30 },
      { x: 0, y: 0, z: 30 },
    ];
    const body = createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: 8 });
    const sil = topSilhouette(body);
    expect(sil).not.toBeNull();
    expect(sil!.outer.points).toHaveLength(6); // the hull would drop to 5
    expect(sil!.outer.area).toBeCloseTo(30 * 30 - 20 * 20, 3); // 500, hull would be 900-ish
    // The concave corner survives.
    const concave = sil!.outer.points.some(
      (p) => Math.abs(p.u - 10) < 1e-6 && Math.abs(p.v - 10) < 1e-6,
    );
    expect(concave).toBe(true);
  });

  it('tube → outer loop plus one island at the inner radius', () => {
    const sil = topSilhouette(createTube(15, 6, 20, 32));
    expect(sil).not.toBeNull();
    expect(sil!.outer.points).toHaveLength(32);
    expect(sil!.islands).toHaveLength(1);
    expect(sil!.islands[0]!.points).toHaveLength(32);
    for (const p of sil!.islands[0]!.points) {
      expect(Math.hypot(p.u, p.v)).toBeCloseTo(6, 3);
    }
  });

  it('coverage sampling matches a brute-force full-body scan (index equivalence)', () => {
    // The material probe goes through a precomputed BVH index; re-derive the
    // answer the OLD quadratic code gave (scan every face, fan-triangulate,
    // half-open PNPOLY) on a dense jittered probe grid over the box's
    // projection and require agreement everywhere — inside, outside and
    // boundary-adjacent points included. The box's faces are all convex, so
    // the fan triangulation is exact and the silhouette outline IS the
    // covered set (concave faces fan-over-cover; those are covered by the
    // closed-form battery below instead).
    const bruteCovers = (body: ReturnType<typeof createBox>, u: number, v: number): boolean => {
      for (const face of body.faces) {
        const vs = face.vertices;
        for (let i = 1; i + 1 < vs.length; i++) {
          const tri = [
            { u: vs[0]!.x, v: vs[0]!.z },
            { u: vs[i]!.x, v: vs[i]!.z },
            { u: vs[i + 1]!.x, v: vs[i + 1]!.z },
          ];
          let hit = false;
          for (let k = 0, m = 2; k < 3; m = k++) {
            const p1 = tri[k]!;
            const p2 = tri[m]!;
            if (p1.v > v !== p2.v > v && u < ((p2.u - p1.u) * (v - p1.v)) / (p2.v - p1.v) + p1.u) {
              hit = !hit;
            }
          }
          if (hit) return true;
        }
      }
      return false;
    };
    const box = createBox(20, 10, 14);
    const sil = topSilhouette(box)!;
    expect(sil).not.toBeNull();
    let inside = 0;
    const N = 32;
    // Irrational jitter keeps probes OFF exact vertices/edges — the
    // point-on-boundary tie-break is a convention, not a semantic.
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const u = -12.9937 + (25.9817 * i) / N;
        const v = -8.9937 + (17.9817 * j) / N;
        const loopHit = pointInPolygon({ u, v }, sil.outer.points);
        if (loopHit) inside++;
        expect(loopHit).toBe(bruteCovers(box, u, v));
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan((N + 1) * (N + 1)); // not all covered — empty cells exist
  });

  it('curved-body battery: closed-form projection areas survive the index', () => {
    // The BVH must reproduce the old scanner's classifications on faces far
    // past a single fan triangle's bbox: sphere → disc, torus → annulus
    // (island at the hole radius), hex prism → hexagon. Relative tolerance
    // absorbs the polygonal approximation of the circles.
    const sphere = topSilhouette(createSphere(15, 48))!;
    expect(sphere.islands).toHaveLength(0);
    expect(sphere.outer.area).toBeGreaterThan(0.97 * Math.PI * 15 * 15);
    expect(sphere.outer.area).toBeLessThan(1.03 * Math.PI * 15 * 15);

    const torus = topSilhouette(createTorus(10, 3, 32, 24))!;
    expect(torus.islands).toHaveLength(1);
    expect(torus.outer.area).toBeGreaterThan(0.9 * Math.PI * 13 * 13);
    expect(torus.outer.area).toBeLessThan(1.1 * Math.PI * 13 * 13);
    for (const p of torus.islands[0]!.points) {
      expect(Math.hypot(p.u, p.v)).toBeCloseTo(7, 2); // hole radius R − r
    }

    const prism = topSilhouette(createPrism(6, 9, 5))!; // hexagonal prism
    expect(prism.islands).toHaveLength(0);
    // Regular hexagon of circumradius 9: area = (3√3/2)·r².
    expect(prism.outer.area).toBeCloseTo((3 * Math.sqrt(3) / 2) * 81, 1);
    expect(prism.outer.points).toHaveLength(6);
  });

  it('timing: ~2k-face body stays well under the regression budget', () => {
    // tube(segs) = 2·segs side faces + 2 rings + 2 caps ≈ 4·segs+4 faces and —
    // the historically worst case — ~4·segs walked cells to sample. The old
    // quadratic scan cost O(cells × faces) and hit 245 ms at 6k faces; the
    // precomputed coverage BVH must keep a ~3k-face tube far below 150 ms
    // even on a loaded CI box.
    const body = createTube(15, 6, 20, 768); // 3076 faces
    expect(body.faces.length).toBeGreaterThan(2900);
    const sil = topSilhouette(body);
    expect(sil).not.toBeNull();
    expect(sil!.islands).toHaveLength(1);
    const t0 = performance.now();
    topSilhouette(body);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(150);
  });
});

describe('offsetPolygon', () => {
  const square = [
    { u: 0, v: 0 },
    { u: 10, v: 0 },
    { u: 10, v: 10 },
    { u: 0, v: 10 },
  ];

  it('grows a square outward by the offset distance (mitered corners)', () => {
    const out = offsetPolygon(square, 2)!;
    expect(out).not.toBeNull();
    // True miter: each OFFSET EDGE lies exactly 2 mm from the original side
    // (that is what keeps a cutter off the wall), so the square grows to
    // 14×14 and each corner sits 2√2 from an original corner. The old
    // normalized-bisector version left the edges only 2·cos45° out — a
    // 0.59 mm wall gouge per side that this test used to bless.
    const area = polygonArea(out);
    expect(area).toBeCloseTo(14 * 14, 6);
    for (const p of out) {
      const d = Math.min(
        Math.hypot(p.u - 0, p.v - 0),
        Math.hypot(p.u - 10, p.v - 0),
        Math.hypot(p.u - 10, p.v - 10),
        Math.hypot(p.u - 0, p.v - 10),
      );
      expect(d).toBeCloseTo(2 * Math.SQRT2, 6);
    }
  });

  it('shrinks a square inward by the full offset per side', () => {
    // True miter: every side moves in by exactly 2 mm (the corners meet at
    // the miter), so a 10 mm square becomes 6 mm — not the old normal-averaged
    // 10 − 2·d/√2 which left 0.59 mm of uncut wall per corner.
    const out = offsetPolygon(square, -2)!;
    const side = 10 - 2 * 2;
    expect(polygonArea(out)).toBeCloseTo(side * side, 6);
  });

  it('returns null when a negative offset inverts the polygon', () => {
    // Triangle inradius ≈ 2.93 — a 5 mm inward offset flips the winding.
    const tri = [
      { u: 0, v: 0 },
      { u: 10, v: 0 },
      { u: 0, v: 10 },
    ];
    expect(offsetPolygon(tri, -5)).toBeNull();
    expect(offsetPolygon(tri, -1)).not.toBeNull();
  });

  it('regular 32-gon offsets to the exact radial distance (cutter comp)', () => {
    const gon = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { u: Math.cos(a) * 15, v: Math.sin(a) * 15 };
    });
    const out = offsetPolygon(gon, 3)!;
    expect(out).toHaveLength(32);
    for (const p of out) {
      // True miter: the EDGES sit exactly 3 mm off the flats (apothem
      // 14.928 + 3), so vertices land at (14.928+3)/cos(π/32) ≈ 18.015 —
      // band the vertex radius between the offset circle and the miter.
      const r = Math.hypot(p.u, p.v);
      expect(r).toBeGreaterThan(17.999);
      expect(r).toBeLessThan(18.02);
    }
  });
});
