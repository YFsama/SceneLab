import { describe, it, expect } from 'vitest';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyCircularArray, applyMirror, scaleBody, scaleBodyToTarget, resizeBody, weldVertices, mergeBodies, translateBody, centerBody } from './operations';
import { createBox } from './brep';
import { computeBoundingBox, computeVolume, checkManifold } from './brep';
import type { SolidBody, Vec3 } from './types';

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
