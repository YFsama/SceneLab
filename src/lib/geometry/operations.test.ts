import { describe, it, expect } from 'vitest';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyGridArray, applyCircularArray, applyMirror, flipBodyNormals, scaleBody, scaleBodyXYZ, scaleBodyToTarget, resizeBody, weldVertices, mergeBodies, translateBody, centerBody, convexHullBody, placeBodyInFrame, sweepBody, maxFilletRadius, maxChamferDistance } from './operations';
import { createBox, createCylinder } from './brep';
import { computeBoundingBox, computeVolume, checkManifold } from './brep';
import { makeCoordinateSystem } from './referenceGeometry';
import type { SolidBody, Vec3, Edge, Face } from './types';

describe('translateBody', () => {
  it('shifts the bounding box by the offset and preserves volume', () => {
    const box = createBox(10, 10, 10);
    const moved = translateBody(box, { x: 50, y: -20, z: 7 });
    const bb = computeBoundingBox(moved);
    expect(bb.min.x).toBeCloseTo(-5 + 50, 5);
    expect(bb.max.y).toBeCloseTo(10 - 20, 5);
    expect(bb.min.z).toBeCloseTo(-5 + 7, 5);
    expect(Math.abs(computeVolume(moved))).toBeCloseTo(Math.abs(computeVolume(box)), 5);
  });
});

describe('scaleBodyToTarget', () => {
  it('scales uniformly so the chosen axis hits the target size', () => {
    const box = createBox(10, 20, 10); // y extent 20
    const tall = scaleBodyToTarget(box, 'y', 40); // factor 2
    const bb = computeBoundingBox(tall);
    expect(bb.max.y - bb.min.y).toBeCloseTo(40, 4);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 4); // aspect preserved (10×2)
  });

  it('rejects a non-positive target', () => {
    expect(() => scaleBodyToTarget(createBox(1, 1, 1), 'x', 0)).toThrow('positive');
  });
});

describe('mergeBodies', () => {
  const shift = (b: SolidBody, d: Vec3): SolidBody => ({
    ...b,
    vertices: b.vertices.map((v) => ({ x: v.x + d.x, y: v.y + d.y, z: v.z + d.z })),
    faces: b.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => ({ x: v.x + d.x, y: v.y + d.y, z: v.z + d.z })) })),
    edges: b.edges.map((e) => ({ ...e, start: { x: e.start.x + d.x, y: e.start.y + d.y, z: e.start.z + d.z }, end: { x: e.end.x + d.x, y: e.end.y + d.y, z: e.end.z + d.z } })),
  });

  it('concatenates geometry and sums volume for disjoint bodies', () => {
    const a = createBox(10, 10, 10);
    const b = shift(createBox(10, 10, 10), { x: 50, y: 0, z: 0 });
    const merged = mergeBodies([a, b]);
    expect(merged.faces).toHaveLength(a.faces.length + b.faces.length);
    expect(merged.vertices).toHaveLength(a.vertices.length + b.vertices.length);
    expect(Math.abs(computeVolume(merged))).toBeCloseTo(2000, 3); // 1000 + 1000
  });

  it('a single-body merge keeps the volume', () => {
    const a = createBox(10, 10, 10);
    expect(Math.abs(computeVolume(mergeBodies([a])))).toBeCloseTo(1000, 3);
  });

  it('merging nothing yields an empty body', () => {
    const merged = mergeBodies([]);
    expect(merged.faces).toHaveLength(0);
    expect(merged.vertices).toHaveLength(0);
  });
});

describe('weldVertices', () => {
  it('merges near-coincident vertices within tolerance', () => {
    // Two triangles whose first vertex differs by 1e-6 (sub-tolerance).
    const body: SolidBody = {
      id: 'b',
      name: 'b',
      vertices: [],
      faces: [
        {
          id: 'f1',
          vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
          normal: { x: 0, y: 0, z: 1 },
        },
        {
          id: 'f2',
          vertices: [{ x: 1e-6, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
          normal: { x: 0, y: 0, z: 1 },
        },
      ],
      edges: [],
    };
    const welded = weldVertices(body, 1e-4);
    expect(welded.vertices).toHaveLength(3); // the two near-dup corners merged
    expect(welded.faces).toHaveLength(2); // both triangles remain valid
  });

  it('leaves a clean box unchanged in vertex count and volume', () => {
    const box = createBox(10, 10, 10);
    const welded = weldVertices(box);
    expect(welded.vertices).toHaveLength(8);
    expect(Math.abs(computeVolume(welded))).toBeCloseTo(Math.abs(computeVolume(box)), 6);
  });

  it('drops faces that collapse below 3 vertices', () => {
    // A "triangle" with two coincident vertices collapses away.
    const body: SolidBody = {
      id: 'b',
      name: 'b',
      vertices: [],
      faces: [
        {
          id: 'f',
          vertices: [{ x: 0, y: 0, z: 0 }, { x: 1e-7, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
          normal: { x: 0, y: 0, z: 1 },
        },
      ],
      edges: [],
    };
    const welded = weldVertices(body, 1e-4);
    expect(welded.faces).toHaveLength(0);
  });
});

describe('scaleBody', () => {
  it('scales dimensions by the factor and volume by factor³', () => {
    const box = createBox(10, 10, 10);
    const scaled = scaleBody(box, 2);
    const bb = computeBoundingBox(scaled);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 5);
    expect(Math.abs(computeVolume(scaled))).toBeCloseTo(8 * Math.abs(computeVolume(box)), 3);
  });

  it('scales about a given origin', () => {
    const box = createBox(10, 10, 10); // centered at origin in X/Z, Y in [0,10]
    const scaled = scaleBody(box, 2, { x: 0, y: 0, z: 0 });
    const bb = computeBoundingBox(scaled);
    // Y was [0,10]; scaling about y=0 by 2 → [0,20].
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(20, 5);
  });

  it('rejects a non-positive factor', () => {
    expect(() => scaleBody(createBox(1, 1, 1), 0)).toThrow('Scale factor');
  });
});

describe('applyFillet', () => {
  it('should return same body when radius is 0', () => {
    const body = createBox(2, 2, 2);
    const result = applyFillet(body, [], 0);
    expect(result.id).toBe(body.id);
    expect(result.faces.length).toBe(body.faces.length);
  });

  it('should modify body when fillet applied', () => {
    const body = createBox(2, 2, 2);
    const edgeIds = body.edges.slice(0, 4).map((e) => e.id);
    const result = applyFillet(body, edgeIds, 0.5);
    expect(result.faces.length).toBeGreaterThanOrEqual(body.faces.length);
  });
});

describe('applyChamfer', () => {
  it('should return same body when distance is 0', () => {
    const body = createBox(2, 2, 2);
    const result = applyChamfer(body, [], 0);
    expect(result.id).toBe(body.id);
  });

  it('produces geometry when a chamfer is applied to edges', () => {
    const body = createBox(10, 10, 10);
    const edgeIds = body.edges.slice(0, 4).map((e) => e.id);
    const result = applyChamfer(body, edgeIds, 0.5);
    expect(result.faces.length).toBeGreaterThan(0);
    expect(result.vertices.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Golden geometry for the pass-30 fillet/chamfer fix. The old fillet put the
// arc center on the OUTWARD bisector and swept π, so every strip floated
// r·√2 outside the part and ended buried inside it: ΔVolume +14.42 at r=1 on
// a 30×10×30 plate (a true fillet REMOVES), 6.93 mm protrusion at r=4.9,
// 49.6° normal kinks. The chamfer buried its whole face inside the solid.
// ---------------------------------------------------------------------------

/** Faces of `body` whose boundary contains `edge` (vertex-ring matching). */
function facesOfEdge(body: SolidBody, edge: Edge): Face[] {
  const eq = (p: Vec3, q: Vec3) => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9 && Math.abs(p.z - q.z) < 1e-9;
  const ringHas = (f: Face) => {
    for (let i = 0; i < f.vertices.length; i++) {
      const a = f.vertices[i]!;
      const b = f.vertices[(i + 1) % f.vertices.length]!;
      if ((eq(a, edge.start) && eq(b, edge.end)) || (eq(a, edge.end) && eq(b, edge.start))) return true;
    }
    return false;
  };
  return body.faces.filter(ringHas);
}

const nrm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const d3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, d3(nrm(a), nrm(b)))));

/** Max distance the body pokes outside `bb`, per axis (negative = inside). */
function protrusionBeyond(body: SolidBody, bb: ReturnType<typeof computeBoundingBox>): number {
  let worst = -Infinity;
  for (const v of body.vertices) {
    worst = Math.max(worst, bb.min.x - v.x, v.x - bb.max.x, bb.min.y - v.y, v.y - bb.max.y, bb.min.z - v.z, v.z - bb.max.z);
  }
  return worst;
}

describe('applyFillet golden geometry (30×10×30 plate)', () => {
  const box = createBox(30, 10, 30); // 9000 mm³, 280 mm of edges
  const bb = computeBoundingBox(box);
  const sumL = 4 * (30 + 10 + 30);
  const SLIVER = 1 - Math.PI / 4; // sliver cross-section per 90° edge, r=1

  // Analytic corner correction, stated formula. A true full-box fillet
  // removes the UNION of the 12 edge slivers; the per-edge sum counts the
  // triple overlaps at the 8 corners twice. Inside one r-cube at a corner
  // (axes along the three meeting edges) each sliver occupies volume
  // (1 − π/4)·r³ — the quarter-square minus the quarter cylinder whose axis
  // is the third edge — and the three overlap in
  //   U·r³ = |{(y−r)²+(z−r)² > r² ∨ (x−r)²+(z−r)² > r² ∨ (x−r)²+(y−r)² > r²}|
  // (by the x→r−x cube symmetry this is the same measure as the y²+z²>1 form
  // quadrature below). The per-corner double-count is D = 3(1−π/4) − U and
  //   V_true(r) = (1 − π/4)·r²·ΣL − 8·D·r³.
  const NQ = 100;
  const U = (() => {
    let hits = 0;
    for (let i = 0; i < NQ; i++) for (let j = 0; j < NQ; j++) for (let k = 0; k < NQ; k++) {
      const x = (i + 0.5) / NQ, y = (j + 0.5) / NQ, z = (k + 0.5) / NQ;
      if (y * y + z * z > 1 || x * x + z * z > 1 || x * x + y * y > 1) hits++;
    }
    return hits / NQ ** 3;
  })();
  const cornerD = 3 * SLIVER - U;

  const removedAt = (r: number) => computeVolume(box) - computeVolume(applyFillet(box, [], r));

  it(`corner quadrature sanity: U=${U.toFixed(4)}, D=3(1−π/4)−U=${cornerD.toFixed(4)}`, () => {
    // Guards the formula inputs: each sliver alone fills 1−π/4 ≈ 0.2146 of
    // the unit cube, the union is between one and three slivers.
    expect(U).toBeGreaterThan(SLIVER);
    expect(U).toBeLessThan(3 * SLIVER);
    expect(cornerD).toBeGreaterThan(0);
  });

  it('never protrudes beyond the original bbox (≤ 0.01 mm) at r = 1 / 2 / 4.9', () => {
    for (const r of [1, 2, 4.9]) {
      const f = applyFillet(box, [], r);
      expect(protrusionBeyond(f, bb)).toBeLessThanOrEqual(0.01);
    }
  });

  it('ΔVolume is negative (material removed) and monotone in r', () => {
    const delta = (r: number) => computeVolume(applyFillet(box, [], r)) - computeVolume(box);
    expect(delta(1)).toBeLessThan(0);
    expect(delta(2)).toBeLessThan(delta(1));
    expect(delta(4.9)).toBeLessThan(delta(2));
  });

  it('removal tracks the analytic sliver union: within 15% at r=1/2, within 25% at r=4.9', () => {
    // The overlay removes the per-edge sliver exactly (plus the ~2.4%
    // chord-vs-arc bulge of the 8-facet polyline), so it over-counts only by
    // the corner double-count 8·D·r³ — 5% at r=1, 9% at r=2, and 20% at
    // r=4.9 where the r³ corner term peaks against the r² edge term at the
    // pass-28 maxFilletRadius bound.
    for (const [r, tol] of [[1, 0.15], [2, 0.15], [4.9, 0.25]] as const) {
      const trueRemoval = SLIVER * r * r * sumL - 8 * cornerD * r ** 3;
      const removed = removedAt(r);
      expect(Math.abs(removed - trueRemoval)).toBeLessThanOrEqual(tol * trueRemoval);
    }
  });

  it('a single edge removes exactly its own sliver: (1 − π/4)·r²·L within 5%', () => {
    const edge = box.edges[0]!; // (−15,0,−15) → (15,0,−15), L = 30
    const f = applyFillet(box, [edge.id], 2);
    const removed = computeVolume(box) - computeVolume(f);
    // Exact sliver 25.75; the inscribed 8-chord polyline adds ~2.4% (0.605),
    // so the closed shell measures 26.36 — inside the 5% band by design.
    expect(removed).toBeLessThan(SLIVER * 4 * 30 * 1.05);
    expect(removed).toBeGreaterThan(SLIVER * 4 * 30 * 0.95);
  });

  it('arc facets: 11.25° steps (≤ 11.5° kink), tangent ends, outward from the material', () => {
    const edge = box.edges[0]!;
    const r = 2;
    const f = applyFillet(box, [edge.id], r);
    const [face1, face2] = facesOfEdge(box, edge);
    expect(face1 && face2).toBeTruthy();
    const n1 = nrm(face1!.normal);
    const n2 = nrm(face2!.normal);
    const edgeDir = nrm({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    const m = nrm({ x: n1.x + n2.x, y: n1.y + n2.y, z: n1.z + n2.z }); // outward bisector
    // In-plane second axis for measuring normal angles around the edge.
    const q = nrm({
      x: edgeDir.y * n1.z - edgeDir.z * n1.y,
      y: edgeDir.z * n1.x - edgeDir.x * n1.z,
      z: edgeDir.x * n1.y - edgeDir.y * n1.x,
    });
    const angleAround = (v: Vec3) => Math.atan2(d3(v, q), d3(v, n1));
    // New quads only (original faces are the same object references).
    const newQuads = f.faces.filter((fc) => !box.faces.includes(fc) && fc.vertices.length === 4);
    // Arc facets point toward the corner (positive on the outward bisector);
    // wall quads point into the material (negative on it).
    const arcFacets = newQuads.filter((fc) => d3(fc.normal, m) > 0).sort((a, b) => angleAround(a.normal) - angleAround(b.normal));
    const walls = newQuads.filter((fc) => d3(fc.normal, m) <= 0);
    expect(arcFacets).toHaveLength(8);
    expect(walls).toHaveLength(2);
    // Consecutive facet normals step exactly one 90°/8 = 11.25° (the old
    // 180° sweep over 8 segments kinked 49.6°).
    for (let i = 1; i < arcFacets.length; i++) {
      const kink = angleBetween(arcFacets[i - 1]!.normal, arcFacets[i]!.normal);
      expect(kink).toBeLessThanOrEqual((11.5 * Math.PI) / 180);
      expect(kink).toBeGreaterThanOrEqual((11 * Math.PI) / 180);
    }
    // The facet fan spans face-to-face: first/last facets are half a step
    // (5.625°) off the face normals — tangency, no seam kink.
    expect(angleBetween(arcFacets[0]!.normal, n1) + angleBetween(arcFacets[0]!.normal, n2)).toBeCloseTo(Math.PI / 2, 6);
    expect(angleBetween(arcFacets[0]!.normal, arcFacets[arcFacets.length - 1]!.normal)).toBeCloseTo((78.75 * Math.PI) / 180, 4);
    // Walls lie flat on the faces they share (normal = −face normal).
    for (const w of walls) {
      const flat = Math.abs(d3(w.normal, n1)) > Math.abs(d3(w.normal, n2)) ? n1 : n2;
      expect(angleBetween(w.normal, flat)).toBeCloseTo(Math.PI, 7);
    }
  });

  it('tangent lines land exactly on the adjacent faces at distance r (90° corner)', () => {
    const edge = box.edges[0]!;
    const r = 2;
    const f = applyFillet(box, [edge.id], r);
    const dir = nrm({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    const [face1, face2] = facesOfEdge(box, edge);
    for (const face of [face1!, face2!]) {
      const n = nrm(face.normal);
      const p0 = face.vertices[0]!;
      // Every new vertex built on this face's plane is on the plane; any that
      // stand off the edge line are the tangent line — exactly r in-plane.
      let sawTangent = false;
      for (const fc of f.faces) {
        if (box.faces.includes(fc)) continue;
        for (const v of fc.vertices) {
          const planeDist = Math.abs(d3({ x: v.x - p0.x, y: v.y - p0.y, z: v.z - p0.z }, n));
          if (planeDist > 1e-9) continue;
          const rel = { x: v.x - edge.start.x, y: v.y - edge.start.y, z: v.z - edge.start.z };
          const along = d3(rel, dir);
          const perp = Math.hypot(rel.x - along * dir.x, rel.y - along * dir.y, rel.z - along * dir.z);
          if (perp > 1e-6) {
            expect(perp).toBeCloseTo(r, 9);
            sawTangent = true;
          }
        }
      }
      expect(sawTangent).toBe(true);
    }
  });

  it('filleted body is honestly non-manifold (spine edges carry 4 faces) — the boolean guardrail keys on this', () => {
    const f = applyFillet(box, [], 1);
    const mc = checkManifold(f);
    expect(mc.isManifold).toBe(false);
    expect(mc.nonManifoldEdges).toBeGreaterThanOrEqual(12); // one per filleted spine
    expect(mc.boundaryEdges).toBe(0); // shells closed: no dangling boundary
  });
});

describe('applyChamfer golden geometry (30×10×30 plate)', () => {
  const box = createBox(30, 10, 30);
  const bb = computeBoundingBox(box);
  const sumL = 4 * (30 + 10 + 30);

  // True full-box chamfer removal = union of the 12 wedges (per edge the
  // right-triangle prism d²L/2). At a corner the three wedges
  // {y+z≤d}, {x+z≤d}, {x+y≤d} overlap; their union fills U_w·d³ of the
  // d-cube (quadrature below), each wedge alone ½d³, so the per-corner
  // double-count is D_w = 3/2 − U_w and
  //   V_true(d) = d²·ΣL/2 − 8·D_w·d³.
  const NQ = 100;
  const Uw = (() => {
    let hits = 0;
    for (let i = 0; i < NQ; i++) for (let j = 0; j < NQ; j++) for (let k = 0; k < NQ; k++) {
      const x = (i + 0.5) / NQ, y = (j + 0.5) / NQ, z = (k + 0.5) / NQ;
      if (y + z <= 1 || x + z <= 1 || x + y <= 1) hits++;
    }
    return hits / NQ ** 3;
  })();
  const cornerDw = 1.5 - Uw;

  it(`wedge corner quadrature sanity: U_w=${Uw.toFixed(4)}, D_w=3/2−U_w=${cornerDw.toFixed(4)}`, () => {
    expect(Uw).toBeGreaterThan(0.5);
    expect(Uw).toBeLessThan(1);
    expect(cornerDw).toBeGreaterThan(0);
  });

  it('never protrudes beyond the original bbox (protrusion stays 0)', () => {
    for (const d of [1, 2, 4.9]) {
      const c = applyChamfer(box, [], d);
      expect(protrusionBeyond(c, bb)).toBeLessThanOrEqual(0.01);
    }
  });

  it('ΔVolume is negative (was nonsense before) and monotone in d', () => {
    const delta = (d: number) => computeVolume(applyChamfer(box, [], d)) - computeVolume(box);
    expect(delta(1)).toBeLessThan(0);
    expect(delta(2)).toBeLessThan(delta(1));
    expect(delta(4.9)).toBeLessThan(delta(2));
  });

  it('removal equals the wedge sum exactly; within 15% of the corner-corrected union at d=1/2, 30% at d=4.9', () => {
    for (const d of [1, 2, 4.9]) {
      const removed = computeVolume(box) - computeVolume(applyChamfer(box, [], d));
      expect(removed).toBeCloseTo((0.5 * d * d * sumL), 6); // exact per-edge wedge sum
      const trueRemoval = 0.5 * d * d * sumL - 8 * cornerDw * d ** 3;
      const tol = d < 3 ? 0.15 : 0.30; // corner double-count grows ∝ d³
      expect(Math.abs(removed - trueRemoval)).toBeLessThanOrEqual(tol * trueRemoval);
    }
  });

  it('chamfer face is a true 45° bevel: equal legs d along both faces', () => {
    const edge = box.edges[0]!;
    const d = 2;
    const c = applyChamfer(box, [edge.id], d);
    const [face1, face2] = facesOfEdge(box, edge);
    const n1 = nrm(face1!.normal);
    const n2 = nrm(face2!.normal);
    const newQuads = c.faces.filter((fc) => !box.faces.includes(fc) && fc.vertices.length === 4);
    // The chamfer quad leans 45° against BOTH faces (walls lie flat on them).
    const lean = newQuads.filter((fc) => {
      const a = Math.abs(d3(fc.normal, n1));
      const b = Math.abs(d3(fc.normal, n2));
      return Math.abs(a - Math.SQRT1_2) < 1e-9 && Math.abs(b - Math.SQRT1_2) < 1e-9;
    });
    expect(lean).toHaveLength(1);
    // Legs: every wall's tangent line sits exactly d in-plane from the edge.
    const dir = nrm({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    for (const face of [face1!, face2!]) {
      const n = nrm(face.normal);
      const p0 = face.vertices[0]!;
      let sawLeg = false;
      for (const fc of c.faces) {
        if (box.faces.includes(fc)) continue;
        for (const v of fc.vertices) {
          const planeDist = Math.abs(d3({ x: v.x - p0.x, y: v.y - p0.y, z: v.z - p0.z }, n));
          if (planeDist < 1e-9) {
            const rel = { x: v.x - edge.start.x, y: v.y - edge.start.y, z: v.z - edge.start.z };
            const along = d3(rel, dir);
            const perp = Math.hypot(rel.x - along * dir.x, rel.y - along * dir.y, rel.z - along * dir.z);
            if (perp > 1e-6) {
              expect(perp).toBeCloseTo(d, 9);
              sawLeg = true;
            }
          }
        }
      }
      expect(sawLeg).toBe(true);
    }
  });

  it('chamfered body is honestly non-manifold (spine edges carry 4 faces)', () => {
    const c = applyChamfer(box, [], 1);
    const mc = checkManifold(c);
    expect(mc.isManifold).toBe(false);
    expect(mc.nonManifoldEdges).toBeGreaterThanOrEqual(12);
    expect(mc.boundaryEdges).toBe(0);
  });
});

describe('maxFilletRadius / maxChamferDistance', () => {
  // Edge runs along Y (vertical) vs lies in an X/Z plane (rim).
  const isVertical = (a: Vec3, b: Vec3) =>
    Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9 && Math.abs(a.y - b.y) > 1e-9;

  it('a 20mm box fillets and chamfers up to 10 on every edge (half the face depth)', () => {
    const box = createBox(20, 20, 20);
    // Omitted/empty edgeIds = every edge.
    const f = maxFilletRadius(box, []);
    expect(f.max).toBeCloseTo(10, 6);
    expect(f.skippedEdges).toBe(0);
    // Explicit all-ids and a single-edge subset give the same bound: every
    // cube edge borders faces whose in-plane depth from the edge is 20.
    expect(maxFilletRadius(box, box.edges.map((e) => e.id)).max).toBeCloseTo(10, 6);
    expect(maxFilletRadius(box, [box.edges[0]!.id]).max).toBeCloseTo(10, 6);
    const c = maxChamferDistance(box, []);
    expect(c.max).toBeCloseTo(10, 6);
    expect(c.skippedEdges).toBe(0);
  });

  it('limits are per edge-subset: rim vs vertical edges of a 40×10×40 box', () => {
    const box = createBox(40, 10, 40);
    const vertical = box.edges.filter((e) => isVertical(e.start, e.end)).map((e) => e.id);
    const rim = box.edges.filter((e) => !isVertical(e.start, e.end)).map((e) => e.id);
    expect(vertical.length + rim.length).toBe(box.edges.length);
    // Vertical edge: both adjacent side faces are 40 deep from it → 20.
    expect(maxFilletRadius(box, vertical).max).toBeCloseTo(20, 6);
    // Rim edge: the 10mm side face is the tight one → 5.
    expect(maxFilletRadius(box, rim).max).toBeCloseTo(5, 6);
    // All edges → the tightest single-edge bound.
    expect(maxFilletRadius(box, []).max).toBeCloseTo(5, 6);
    expect(maxChamferDistance(box, rim).max).toBeCloseTo(5, 6);
    expect(maxChamferDistance(box, vertical).max).toBeCloseTo(20, 6);
  });

  it('cylinder: rim edges take ~apothem, side-seam edges only half a facet', () => {
    const R = 5;
    const H = 20;
    const N = 32;
    const cyl = createCylinder(R, H, N);
    const facet = 2 * R * Math.sin(Math.PI / N); // polygon side length
    const rim = cyl.edges.find((e) => Math.abs(Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z) - facet) < 1e-6)!;
    const seam = cyl.edges.find((e) => Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z) > H - 1e-6)!;
    // Rim: min(cap depth 2·apothem, side depth H)/2 = apothem.
    expect(maxFilletRadius(cyl, [rim.id]).max).toBeCloseTo(R * Math.cos(Math.PI / N), 3);
    expect(maxChamferDistance(cyl, [rim.id]).max).toBeCloseTo(R * Math.cos(Math.PI / N), 3);
    // Vertical seam: each side quad is only one facet wide → facet/2.
    expect(maxFilletRadius(cyl, [seam.id]).max).toBeCloseTo(facet / 2, 3);
    expect(maxChamferDistance(cyl, [seam.id]).max).toBeCloseTo(facet / 2, 3);
  });

  it('edges without two adjacent faces are skipped; all-skipped yields max null', () => {
    const p = (x: number, y: number, z: number) => ({ x, y, z });
    // One edge shared by two triangles, one edge on a single face, one edge on
    // no face at all — only the first is filletable.
    const body: SolidBody = {
      id: 'b', name: 'b',
      vertices: [p(0, 0, 0), p(1, 0, 0), p(0, 1, 0), p(0, 0, 1), p(2, 0, 0)],
      edges: [
        { id: 'shared', start: p(0, 0, 0), end: p(1, 0, 0) },
        { id: 'single', start: p(1, 0, 0), end: p(0, 1, 0) },
        { id: 'free', start: p(0, 0, 1), end: p(2, 0, 0) },
      ],
      faces: [
        { id: 'f0', vertices: [p(0, 0, 0), p(1, 0, 0), p(0, 1, 0)], normal: { x: 0, y: 0, z: 1 } },
        { id: 'f1', vertices: [p(0, 0, 0), p(0, 0, 1), p(1, 0, 0)], normal: { x: 0, y: 1, z: 0 } },
      ],
    };
    const onlyShared = maxFilletRadius(body, ['shared']);
    expect(onlyShared.max).not.toBeNull();
    expect(onlyShared.skippedEdges).toBe(0);
    const all = maxFilletRadius(body, []);
    expect(all.skippedEdges).toBe(2);
    expect(all.max).toBeCloseTo(onlyShared.max!, 9);
    const none = maxFilletRadius(body, ['single', 'free']);
    expect(none.max).toBeNull();
    expect(none.skippedEdges).toBe(2);
    expect(maxChamferDistance(body, ['free']).max).toBeNull();
    expect(maxChamferDistance(body, ['free']).skippedEdges).toBe(1);
  });
});

describe('applyShell', () => {
  it('should return same body when thickness is 0', () => {
    const body = createBox(2, 2, 2);
    const result = applyShell(body, [], 0);
    expect(result.id).toBe(body.id);
  });

  it('should add inner faces when shell applied', () => {
    const body = createBox(2, 2, 2);
    const faceId = body.faces[0]?.id ?? '';
    const result = applyShell(body, [faceId], 0.2);
    expect(result.faces.length).toBeGreaterThan(body.faces.length);
  });
});

describe('applyLinearArray', () => {
  it('should create count copies', () => {
    const body = createBox(1, 1, 1);
    const results = applyLinearArray(body, { x: 1, y: 0, z: 0 }, 3, 2);
    expect(results.length).toBe(3);
    expect(results[0]?.name).toContain('[0]');
    expect(results[2]?.name).toContain('[2]');
  });

  it('should offset each copy', () => {
    const body = createBox(1, 1, 1);
    const results = applyLinearArray(body, { x: 1, y: 0, z: 0 }, 3, 5);
    // Second copy should be offset by 5 in X
    const bb0 = results[0]!.vertices[0]!;
    const bb1 = results[1]!.vertices[0]!;
    expect(bb1.x - bb0.x).toBeCloseTo(5, 0);
  });

  it('should throw for count <= 0', () => {
    const body = createBox(1, 1, 1);
    expect(() => applyLinearArray(body, { x: 1, y: 0, z: 0 }, 0, 5))
      .toThrow('Array count must be positive');
  });

  it('should throw for spacing <= 0', () => {
    const body = createBox(1, 1, 1);
    expect(() => applyLinearArray(body, { x: 1, y: 0, z: 0 }, 3, 0))
      .toThrow('Array spacing must be positive');
  });
});

describe('applyCircularArray', () => {
  it('should create count copies', () => {
    const body = createBox(1, 1, 1);
    const results = applyCircularArray(body, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, 4);
    expect(results.length).toBe(4);
  });

  it('should throw for count <= 0', () => {
    const body = createBox(1, 1, 1);
    expect(() => applyCircularArray(body, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, 0))
      .toThrow('Array count must be positive');
  });
});

describe('applyLinearArray positions', () => {
  it('spaces instances evenly along the direction', () => {
    const part = createBox(10, 10, 10); // centred at x=0
    const instances = applyLinearArray(part, { x: 1, y: 0, z: 0 }, 3, 20);
    expect(instances).toHaveLength(3);
    const centersX = instances.map((b) => {
      const bb = computeBoundingBox(b);
      return (bb.min.x + bb.max.x) / 2;
    });
    expect(centersX[1]! - centersX[0]!).toBeCloseTo(20, 5);
    expect(centersX[2]! - centersX[0]!).toBeCloseTo(40, 5);
  });

  it('honors spacing as mm even when the direction is not a unit vector', () => {
    const part = createBox(10, 10, 10);
    // Direction magnitude 10; spacing must still be 5mm, not 50mm.
    const instances = applyLinearArray(part, { x: 10, y: 0, z: 0 }, 3, 5);
    const centersX = instances.map((b) => {
      const bb = computeBoundingBox(b);
      return (bb.min.x + bb.max.x) / 2;
    });
    expect(centersX[1]! - centersX[0]!).toBeCloseTo(5, 5);
    expect(centersX[2]! - centersX[0]!).toBeCloseTo(10, 5);
  });

  it('rejects a zero-length array direction', () => {
    expect(() => applyLinearArray(createBox(1, 1, 1), { x: 0, y: 0, z: 0 }, 3, 5)).toThrow('direction');
  });
});

describe('applyCircularArray positions', () => {
  it('places instances on a circle around the axis', () => {
    // A box centered at x=10, arrayed around the Y axis through the origin.
    const part = translateBody(createBox(2, 2, 2), { x: 10, y: 0, z: 0 });
    const instances = applyCircularArray(part, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, 4);
    expect(instances).toHaveLength(4);
    const centers = instances.map((b) => computeBoundingBox(b)).map((bb) => ({
      x: (bb.min.x + bb.max.x) / 2,
      z: (bb.min.z + bb.max.z) / 2,
    }));
    // Every instance centre sits ~10mm from the axis (radius preserved).
    for (const c of centers) {
      expect(Math.hypot(c.x, c.z)).toBeCloseTo(10, 3);
    }
    // The four instances occupy distinct positions.
    const distinct = new Set(centers.map((c) => `${c.x.toFixed(2)},${c.z.toFixed(2)}`));
    expect(distinct.size).toBe(4);
  });
});

describe('flipBodyNormals', () => {
  it('negates every face normal and reverses its winding, keeping id and geometry', () => {
    const body = createBox(10, 10, 10);
    const r = flipBodyNormals(body);
    expect(r.id).toBe(body.id); // in-place edit
    expect(r.vertices).toEqual(body.vertices); // points unchanged
    expect(r.faces.length).toBe(body.faces.length);
    r.faces.forEach((f, i) => {
      const o = body.faces[i]!;
      expect(f.normal).toEqual({ x: -o.normal.x, y: -o.normal.y, z: -o.normal.z });
      expect(f.vertices).toEqual([...o.vertices].reverse());
    });
    // Flipping twice restores the original orientation.
    const back = flipBodyNormals(r);
    expect(back.faces[0]!.normal).toEqual(body.faces[0]!.normal);
  });
});

describe('applyMirror', () => {
  it('should create a mirrored copy', () => {
    const body = createBox(1, 1, 1);
    const result = applyMirror(body, { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } });
    expect(result.name).toContain('mirror');
    expect(result.vertices.length).toBe(body.vertices.length);
    expect(result.faces.length).toBe(body.faces.length);
  });

  it('should flip X coordinates when mirroring across YZ plane', () => {
    const body = createBox(2, 2, 2);
    // Body is centered at x=0, extends from x=-1 to x=1
    const result = applyMirror(body, { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } });
    // Mirrored body should also extend from x=-1 to x=1 (reflection of x is -x)
    const origX = body.vertices[0]!.x;
    const mirX = result.vertices[0]!.x;
    expect(mirX).toBeCloseTo(-origX, 5);
  });

  it('keeps stored normals consistent with the winding (right-side-out)', () => {
    // Mirror across a tilted plane: a reflection flips winding, so the result
    // must reverse face order and reflect (not negate) normals.
    const result = applyMirror(createBox(10, 6, 4), {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 1, z: 0 },
    });
    for (const f of result.faces) {
      const v0 = f.vertices[0]!;
      const v1 = f.vertices[1]!;
      const v2 = f.vertices[2]!;
      const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
      const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
      const wn = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
      const dot = wn.x * f.normal.x + wn.y * f.normal.y + wn.z * f.normal.z;
      // Stored normal must agree with the winding-derived normal, not oppose it.
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('resizeBody', () => {
  it('resizes to exact per-axis dimensions, staying watertight', () => {
    const r = resizeBody(createBox(10, 10, 10), { x: 50, y: 30, z: 10 });
    const bb = computeBoundingBox(r);
    expect(bb.max.x - bb.min.x).toBeCloseTo(50, 5);
    expect(bb.max.y - bb.min.y).toBeCloseTo(30, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(10, 5);
    expect(Math.abs(computeVolume(r))).toBeCloseTo(50 * 30 * 10, 3);
    expect(checkManifold(r).isManifold).toBe(true);
  });

  it('keeps normals consistent with the winding under non-uniform scale', () => {
    const r = resizeBody(createBox(10, 10, 10), { x: 40, y: 5, z: 20 });
    for (const f of r.faces) {
      const v0 = f.vertices[0]!;
      const v1 = f.vertices[1]!;
      const v2 = f.vertices[2]!;
      const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
      const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
      const wn = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
      expect(wn.x * f.normal.x + wn.y * f.normal.y + wn.z * f.normal.z).toBeGreaterThan(0);
    }
  });

  it('rejects non-positive target dimensions', () => {
    expect(() => resizeBody(createBox(1, 1, 1), { x: 0, y: 5, z: 5 })).toThrow();
  });
});

describe('centerBody', () => {
  it('moves the bounding-box center to the origin and preserves volume', () => {
    const off = translateBody(createBox(10, 20, 30), { x: 100, y: -50, z: 7 });
    const centered = centerBody(off);
    const bb = computeBoundingBox(centered);
    expect((bb.min.x + bb.max.x) / 2).toBeCloseTo(0, 6);
    expect((bb.min.y + bb.max.y) / 2).toBeCloseTo(0, 6);
    expect((bb.min.z + bb.max.z) / 2).toBeCloseTo(0, 6);
    expect(Math.abs(computeVolume(centered))).toBeCloseTo(Math.abs(computeVolume(off)), 4);
  });

  it('returns an already-centered body unchanged', () => {
    const box = createBox(10, 10, 10); // centered in X/Z, Y in [0,10] → center (0,5,0)
    const c = centerBody(box);
    const bb = computeBoundingBox(c);
    expect((bb.min.y + bb.max.y) / 2).toBeCloseTo(0, 6); // Y now centered
  });
});

describe('convexHullBody', () => {
  it('hulls a convex box back to itself (watertight, same volume)', () => {
    const h = convexHullBody(createBox(10, 10, 10));
    expect(checkManifold(h).isManifold).toBe(true);
    expect(Math.abs(computeVolume(h))).toBeCloseTo(1000, 3);
  });

  it('wraps a non-convex (disjoint) shape, enclosing more than the parts', () => {
    const dumbbell = mergeBodies([
      createBox(10, 10, 10),
      translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }),
    ]);
    const h = convexHullBody(dumbbell);
    expect(checkManifold(h).isManifold).toBe(true);
    // Spans x∈[-5,35]=40, y10, z10 → 4000, > the 2000 of the two parts.
    expect(Math.abs(computeVolume(h))).toBeCloseTo(4000, 1);
  });
});

describe('applyGridArray', () => {
  it('produces count1 × count2 copies at the expected offsets', () => {
    const part = createBox(2, 2, 2); // centred at origin
    const grid = applyGridArray(part, { x: 1, y: 0, z: 0 }, 3, 10, { x: 0, y: 0, z: 1 }, 2, 20);
    expect(grid).toHaveLength(6);
    // The (2,1) copy sits at +20 in X and +20 in Z.
    const centre = (b: ReturnType<typeof createBox>) => {
      const bb = computeBoundingBox(b);
      return { x: (bb.min.x + bb.max.x) / 2, z: (bb.min.z + bb.max.z) / 2 };
    };
    const last = grid.find((b) => b.name.includes('[2,1]'))!;
    expect(centre(last).x).toBeCloseTo(20, 5);
    expect(centre(last).z).toBeCloseTo(20, 5);
  });

  it('honors spacing in mm for non-unit directions and rejects bad input', () => {
    const g = applyGridArray(createBox(1, 1, 1), { x: 5, y: 0, z: 0 }, 2, 4, { x: 0, y: 5, z: 0 }, 2, 4);
    const xs = g.map((b) => {
      const bb = computeBoundingBox(b);
      return (bb.min.x + bb.max.x) / 2;
    }).sort((a, b) => a - b);
    expect(xs[xs.length - 1]! - xs[0]!).toBeCloseTo(4, 5); // 4mm gap, not 20
    expect(() => applyGridArray(createBox(1, 1, 1), { x: 0, y: 0, z: 0 }, 2, 4, { x: 0, y: 1, z: 0 }, 2, 4)).toThrow();
    expect(() => applyGridArray(createBox(1, 1, 1), { x: 1, y: 0, z: 0 }, 0, 4, { x: 0, y: 1, z: 0 }, 2, 4)).toThrow();
  });
});

describe('placeBodyInFrame', () => {
  const box = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10], vol 1000

  it('the identity frame leaves the body unchanged', () => {
    const cs = makeCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const placed = placeBodyInFrame(box, cs);
    const bb0 = computeBoundingBox(box);
    const bb1 = computeBoundingBox(placed);
    expect(bb1.min.x).toBeCloseTo(bb0.min.x, 6);
    expect(bb1.max.y).toBeCloseTo(bb0.max.y, 6);
    expect(Math.abs(computeVolume(placed))).toBeCloseTo(1000, 4);
  });

  it('a translated frame shifts the body and preserves volume', () => {
    const cs = makeCoordinateSystem({ x: 10, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const placed = placeBodyInFrame(box, cs);
    const bb = computeBoundingBox(placed);
    expect(bb.min.x).toBeCloseTo(5, 5); // -5 + 10
    expect(bb.max.x).toBeCloseTo(15, 5);
    expect(Math.abs(computeVolume(placed))).toBeCloseTo(1000, 4);
  });

  it('a rotated frame is a rigid transform (volume + watertightness preserved)', () => {
    // Primary +Y, secondary -X → a 90° rotation about Z.
    const cs = makeCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 });
    const placed = placeBodyInFrame(box, cs);
    expect(Math.abs(computeVolume(placed))).toBeCloseTo(1000, 4);
    expect(checkManifold(placed).boundaryEdges).toBe(0);
  });
});

describe('scaleBodyXYZ', () => {
  it('scales per-axis so X doubles and Y triples while Z stays', () => {
    const box = createBox(10, 10, 10);
    const scaled = scaleBodyXYZ(box, 2, 3, 1);
    const bb = computeBoundingBox(scaled);
    expect(bb.max.x - bb.min.x).toBeCloseTo(20, 4);
    expect(bb.max.y - bb.min.y).toBeCloseTo(30, 4);
    expect(bb.max.z - bb.min.z).toBeCloseTo(10, 4);
  });

  it('rejects non-positive factors', () => {
    expect(() => scaleBodyXYZ(createBox(1, 1, 1), 0, 1, 1)).toThrow('positive');
    expect(() => scaleBodyXYZ(createBox(1, 1, 1), 1, -1, 1)).toThrow('positive');
  });
});

describe('sweepBody', () => {
  it('sweeps a square profile along a straight path', () => {
    const profile = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const path = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 10 },
    ];
    const body = sweepBody(profile, path);
    expect(body.faces.length).toBeGreaterThan(0);
    expect(body.vertices.length).toBeGreaterThan(0);
    // Volume should be non-zero (exact value depends on face winding).
    const vol = Math.abs(computeVolume(body));
    expect(vol).toBeGreaterThan(0);
  });

  it('sweeps a circular profile along an L-shaped path', () => {
    const segments = 8;
    const r = 1;
    const profile: { x: number; y: number }[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      profile.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    const path = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
    ];
    const body = sweepBody(profile, path);
    expect(body.faces.length).toBeGreaterThan(0);
    // Should have non-zero volume.
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(0);
  });

  it('throws for invalid inputs', () => {
    expect(() => sweepBody([{ x: 0, y: 0 }], [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])).toThrow('≥3');
    expect(() => sweepBody([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0, z: 0 }])).toThrow('≥2');
  });
});
