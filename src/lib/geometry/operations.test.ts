import { describe, it, expect } from 'vitest';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyCircularArray, applyMirror, scaleBody, weldVertices } from './operations';
import { createBox } from './brep';
import { computeBoundingBox, computeVolume } from './brep';
import type { SolidBody } from './types';

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
});
