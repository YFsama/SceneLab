import { describe, it, expect } from 'vitest';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyCircularArray, applyMirror } from './operations';
import { createBox } from './brep';

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
