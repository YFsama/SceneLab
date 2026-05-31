import { describe, it, expect } from 'vitest';
import {
  makePlane,
  standardPlanes,
  planeFromFace,
  offsetPlane,
  midplaneBetweenFaces,
  signedDistanceToPlane,
  projectPointOntoPlane,
  makeAxis,
  axisFromPoints,
  axisFromPlanes,
  closestPointOnAxis,
  distancePointToAxis,
  makePoint,
  midpoint,
  pointAtAxisPlaneIntersection,
  makeCoordinateSystem,
  worldToLocal,
  localToWorld,
} from './referenceGeometry';
import { createBox } from './brep';
import { listFaces } from './query';

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

describe('makePlane', () => {
  it('builds a right-handed orthonormal basis (u × v = normal)', () => {
    for (const n of [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 1, z: 1 },
      { x: -3, y: 2, z: 0 },
    ]) {
      const p = makePlane({ x: 0, y: 0, z: 0 }, n);
      expect(Math.hypot(p.u.x, p.u.y, p.u.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(p.v.x, p.v.y, p.v.z)).toBeCloseTo(1, 6);
      expect(dot(p.u, p.v)).toBeCloseTo(0, 6);
      expect(dot(p.u, p.normal)).toBeCloseTo(0, 6);
      const uv = cross(p.u, p.v);
      expect(uv.x).toBeCloseTo(p.normal.x, 6);
      expect(uv.y).toBeCloseTo(p.normal.y, 6);
      expect(uv.z).toBeCloseTo(p.normal.z, 6);
    }
  });

  it('throws on a zero-length normal', () => {
    expect(() => makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toThrow();
  });
});

describe('standardPlanes', () => {
  it('returns three orthogonal planes through the origin', () => {
    const [front, top, right] = standardPlanes();
    expect(front.normal).toMatchObject({ x: 0, y: 0, z: 1 });
    expect(top.normal).toMatchObject({ x: 0, y: 1, z: 0 });
    expect(right.normal).toMatchObject({ x: 1, y: 0, z: 0 });
    for (const p of [front, top, right]) expect(p.origin).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});

describe('planeFromFace / offsetPlane', () => {
  const box = createBox(10, 10, 10);
  const top = listFaces(box).find((f) => f.normal.y > 0.99)!;

  it('sits on the face with the face normal', () => {
    const p = planeFromFace(box, top.id)!;
    expect(p.normal.y).toBeCloseTo(1, 6);
    expect(p.origin.y).toBeCloseTo(10, 4);
  });

  it('offset shifts the origin along the normal', () => {
    const p = planeFromFace(box, top.id, 5)!;
    expect(p.origin.y).toBeCloseTo(15, 4);
  });

  it('offsetPlane keeps the normal and shifts the origin', () => {
    const base = planeFromFace(box, top.id)!;
    const off = offsetPlane(base, 3);
    expect(off.normal.y).toBeCloseTo(1, 6);
    expect(off.origin.y).toBeCloseTo(13, 4);
  });

  it('returns null for an unknown face', () => {
    expect(planeFromFace(box, 'nope')).toBeNull();
  });
});

describe('midplaneBetweenFaces', () => {
  const box = createBox(10, 20, 10); // height 20 in Y, faces at y=0 and y=20
  const faces = listFaces(box);
  const top = faces.find((f) => f.normal.y > 0.99)!;
  const bottom = faces.find((f) => f.normal.y < -0.99)!;
  const side = faces.find((f) => f.normal.x > 0.99)!;

  it('sits halfway between two parallel faces', () => {
    const mid = midplaneBetweenFaces(box, top.id, bottom.id)!;
    expect(mid.origin.y).toBeCloseTo(10, 4);
    expect(Math.abs(mid.normal.y)).toBeCloseTo(1, 6);
  });

  it('returns null for non-parallel faces', () => {
    expect(midplaneBetweenFaces(box, top.id, side.id)).toBeNull();
  });

  it('returns null for a missing face', () => {
    expect(midplaneBetweenFaces(box, top.id, 'nope')).toBeNull();
  });
});

describe('signedDistanceToPlane / projectPointOntoPlane', () => {
  const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

  it('measures signed distance along the normal', () => {
    expect(signedDistanceToPlane(plane, { x: 5, y: 4, z: 2 })).toBeCloseTo(4, 6);
    expect(signedDistanceToPlane(plane, { x: 0, y: -3, z: 0 })).toBeCloseTo(-3, 6);
  });

  it('projects a point onto the plane (distance becomes zero)', () => {
    const q = projectPointOntoPlane(plane, { x: 5, y: 4, z: 2 });
    expect(q.y).toBeCloseTo(0, 6);
    expect(q.x).toBeCloseTo(5, 6);
    expect(q.z).toBeCloseTo(2, 6);
    expect(signedDistanceToPlane(plane, q)).toBeCloseTo(0, 6);
  });
});

describe('reference axes', () => {
  it('makeAxis normalizes the direction; throws on zero', () => {
    const a = makeAxis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    expect(Math.hypot(a.direction.x, a.direction.y, a.direction.z)).toBeCloseTo(1, 6);
    expect(a.direction.z).toBeCloseTo(1, 6);
    expect(() => makeAxis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toThrow();
  });

  it('axisFromPoints points from p1 toward p2; null if coincident', () => {
    const a = axisFromPoints({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 6 })!;
    expect(a.direction.z).toBeCloseTo(1, 6);
    expect(axisFromPoints({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 })).toBeNull();
  });

  it('intersection of the Front (XY) and Top (XZ) planes is the X axis', () => {
    const [front, top] = standardPlanes();
    const axis = axisFromPlanes(front, top)!;
    expect(axis).not.toBeNull();
    // Direction is ±X.
    expect(Math.abs(axis.direction.x)).toBeCloseTo(1, 6);
    expect(Math.abs(axis.direction.y)).toBeCloseTo(0, 6);
    expect(Math.abs(axis.direction.z)).toBeCloseTo(0, 6);
    // The line passes through the origin (y=0, z=0).
    expect(axis.origin.y).toBeCloseTo(0, 6);
    expect(axis.origin.z).toBeCloseTo(0, 6);
  });

  it('intersection of two offset planes lies on both', () => {
    // Plane z=2 and plane y=3 intersect in the line x-free, y=3, z=2.
    const pz = makePlane({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 1 });
    const py = makePlane({ x: 0, y: 3, z: 0 }, { x: 0, y: 1, z: 0 });
    const axis = axisFromPlanes(pz, py)!;
    expect(signedDistanceToPlane(pz, axis.origin)).toBeCloseTo(0, 6);
    expect(signedDistanceToPlane(py, axis.origin)).toBeCloseTo(0, 6);
    expect(Math.abs(axis.direction.x)).toBeCloseTo(1, 6); // line runs along X
  });

  it('parallel planes have no intersection axis', () => {
    const a = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const b = makePlane({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 1 });
    expect(axisFromPlanes(a, b)).toBeNull();
  });

  it('closestPointOnAxis and distancePointToAxis measure perpendicular offset', () => {
    const zAxis = makeAxis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const p = { x: 3, y: 4, z: 7 };
    const c = closestPointOnAxis(zAxis, p);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
    expect(c.z).toBeCloseTo(7, 6); // projects onto the axis at the same height
    expect(distancePointToAxis(zAxis, p)).toBeCloseTo(5, 6); // √(3²+4²)
  });
});

describe('reference points', () => {
  it('makePoint copies the position', () => {
    const src = { x: 1, y: 2, z: 3 };
    const p = makePoint(src);
    expect(p.position).toEqual(src);
    src.x = 99; // mutating the source must not affect the stored point
    expect(p.position.x).toBe(1);
  });

  it('midpoint averages two points', () => {
    const m = midpoint({ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 8 });
    expect(m.position).toEqual({ x: 2, y: 1, z: 4 });
  });

  it('pointAtAxisPlaneIntersection finds where an axis pierces a plane', () => {
    const zAxis = makeAxis({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 1 });
    const plane = makePlane({ x: 0, y: 0, z: 7 }, { x: 0, y: 0, z: 1 }); // z = 7
    const p = pointAtAxisPlaneIntersection(zAxis, plane)!;
    expect(p.position.x).toBeCloseTo(3, 6);
    expect(p.position.y).toBeCloseTo(4, 6);
    expect(p.position.z).toBeCloseTo(7, 6);
  });

  it('pointAtAxisPlaneIntersection is null when the axis lies parallel to the plane', () => {
    const xAxis = makeAxis({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const plane = makePlane({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 1 }); // axis runs in z=0, parallel
    expect(pointAtAxisPlaneIntersection(xAxis, plane)).toBeNull();
  });
});

describe('coordinate systems', () => {
  const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    a.x * b.x + a.y * b.y + a.z * b.z;

  it('builds a right-handed orthonormal frame (x × y = z)', () => {
    const cs = makeCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 1, y: 3, z: 0 });
    for (const v of [cs.xAxis, cs.yAxis, cs.zAxis]) {
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
    }
    expect(dot(cs.xAxis, cs.yAxis)).toBeCloseTo(0, 6);
    expect(dot(cs.xAxis, cs.zAxis)).toBeCloseTo(0, 6);
    expect(dot(cs.yAxis, cs.zAxis)).toBeCloseTo(0, 6);
    // x × y = z
    const cxy = {
      x: cs.xAxis.y * cs.yAxis.z - cs.xAxis.z * cs.yAxis.y,
      y: cs.xAxis.z * cs.yAxis.x - cs.xAxis.x * cs.yAxis.z,
      z: cs.xAxis.x * cs.yAxis.y - cs.xAxis.y * cs.yAxis.x,
    };
    expect(cxy.x).toBeCloseTo(cs.zAxis.x, 6);
    expect(cxy.y).toBeCloseTo(cs.zAxis.y, 6);
    expect(cxy.z).toBeCloseTo(cs.zAxis.z, 6);
  });

  it('throws when primary and secondary directions are parallel', () => {
    expect(() => makeCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })).toThrow();
  });

  it('worldToLocal / localToWorld round-trip', () => {
    const cs = makeCoordinateSystem({ x: 10, y: -5, z: 2 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    const p = { x: 3, y: 7, z: -4 };
    const local = worldToLocal(cs, p);
    const back = localToWorld(cs, local);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
  });

  it('the origin maps to the local zero', () => {
    const cs = makeCoordinateSystem({ x: 4, y: 4, z: 4 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const local = worldToLocal(cs, cs.origin);
    expect(local.x).toBeCloseTo(0, 6);
    expect(local.y).toBeCloseTo(0, 6);
    expect(local.z).toBeCloseTo(0, 6);
  });
});
