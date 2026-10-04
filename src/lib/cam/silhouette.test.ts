import { describe, it, expect } from 'vitest';
import { topSilhouette, offsetPolygon, polygonArea } from './silhouette';
import { createBox, createCylinder, createTube, createExtrude } from '../geometry/brep';
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
