import { describe, it, expect, beforeAll } from 'vitest';
import { listFaces, angleBetweenFaces, detectCircularHoles } from './query';
import { createBox, createCylinder, createSphere, createTube } from './brep';
import { warmUpBooleanEngine, booleanOpManifold } from './booleanManifold';
import { translateBody } from './operations';

describe('listFaces', () => {
  it('reports a box face: 6 faces, area 100, unit axis normals', () => {
    const faces = listFaces(createBox(10, 10, 10));
    expect(faces).toHaveLength(6);
    for (const f of faces) {
      expect(f.area).toBeCloseTo(100, 3);
      expect(Math.hypot(f.normal.x, f.normal.y, f.normal.z)).toBeCloseTo(1, 6);
      expect(f.id).toBeTruthy();
    }
    // There is a +Y face whose centroid sits at the top (y = 10).
    const top = faces.find((f) => f.normal.y > 0.99);
    expect(top).toBeDefined();
    expect(top!.centroid.y).toBeCloseTo(10, 4);
  });

  it('lists faces for a cylinder', () => {
    const faces = listFaces(createCylinder(5, 10, 16));
    expect(faces.length).toBeGreaterThan(0);
    // All faces should have positive area.
    for (const f of faces) {
      expect(f.area).toBeGreaterThan(0);
    }
  });

  it('lists faces for a sphere', () => {
    const faces = listFaces(createSphere(7, 16));
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      expect(f.area).toBeGreaterThan(0);
    }
  });

  it('all face normals are unit vectors', () => {
    const faces = listFaces(createBox(10, 10, 10));
    for (const f of faces) {
      const len = Math.hypot(f.normal.x, f.normal.y, f.normal.z);
      expect(len).toBeCloseTo(1, 6);
    }
  });
});

describe('angleBetweenFaces', () => {
  const box = createBox(10, 10, 10);
  const faces = listFaces(box);
  const top = faces.find((f) => f.normal.y > 0.99)!;
  const bottom = faces.find((f) => f.normal.y < -0.99)!;
  const side = faces.find((f) => f.normal.x > 0.99)!;

  it('adjacent box faces meet at 90°', () => {
    expect(angleBetweenFaces(box, top.id, side.id)).toBeCloseTo(90, 6);
  });

  it('opposite box faces read 180°', () => {
    expect(angleBetweenFaces(box, top.id, bottom.id)).toBeCloseTo(180, 6);
  });

  it('a face against itself reads 0°', () => {
    expect(angleBetweenFaces(box, top.id, top.id)).toBeCloseTo(0, 6);
  });

  it('returns null for an unknown face id', () => {
    expect(angleBetweenFaces(box, top.id, 'nope')).toBeNull();
  });
});

describe('detectCircularHoles', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('a watertight undrilled box has no holes', () => {
    expect(detectCircularHoles(createBox(20, 10, 30))).toEqual([]);
  });

  it('a plain cylinder is a boss, not a hole', () => {
    expect(detectCircularHoles(createCylinder(15, 20, 32))).toEqual([]);
  });

  it('finds the ⌀12 through hole of a tube at the centre', () => {
    const holes = detectCircularHoles(createTube(15, 6, 20, 32));
    expect(holes).toHaveLength(1);
    expect(holes[0]!.centre.x).toBeCloseTo(0, 6);
    expect(holes[0]!.centre.z).toBeCloseTo(0, 6);
    expect(holes[0]!.diameter).toBeCloseTo(12, 2);
    expect(holes[0]!.depth).toBeCloseTo(20, 6);
  });

  it('finds a drilled ⌀6 hole in a watertight box at the right (x, z) with depth', () => {
    const box = createBox(20, 20, 30); // x ±10, y 0..20, z ±15
    const drill = translateBody(createCylinder(3, 30, 24), { x: 4, y: -5, z: 2 });
    const drilled = booleanOpManifold(box, drill, 'difference');
    expect(drilled).not.toBeNull();
    const holes = detectCircularHoles(drilled as NonNullable<typeof drilled>);
    expect(holes).toHaveLength(1);
    expect(holes[0]!.centre.x).toBeCloseTo(4, 3);
    expect(holes[0]!.centre.z).toBeCloseTo(2, 3);
    expect(holes[0]!.diameter).toBeCloseTo(6, 2);
    expect(holes[0]!.depth).toBeCloseTo(20, 3);
  });

  it('finds two separate drilled holes', () => {
    const box = createBox(30, 20, 20);
    const drilledPair = booleanOpManifold(
      translateBody(createCylinder(2, 40, 16), { x: -6, y: -5, z: 0 }),
      translateBody(createCylinder(2, 40, 16), { x: 6, y: -5, z: 0 }),
      'union',
    );
    expect(drilledPair).not.toBeNull();
    const drills = drilledPair as NonNullable<typeof drilledPair>;
    const drilled = booleanOpManifold(box, drills, 'difference');
    expect(drilled).not.toBeNull();
    const holes = detectCircularHoles(drilled as NonNullable<typeof drilled>);
    expect(holes).toHaveLength(2);
    expect(holes[0]!.centre.x).toBeCloseTo(-6, 3);
    expect(holes[1]!.centre.x).toBeCloseTo(6, 3);
    expect(holes[0]!.diameter).toBeCloseTo(4, 2);
  });
});
