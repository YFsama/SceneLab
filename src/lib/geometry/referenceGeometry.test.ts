import { describe, it, expect } from 'vitest';
import {
  makePlane,
  standardPlanes,
  planeFromFace,
  offsetPlane,
  midplaneBetweenFaces,
  signedDistanceToPlane,
  projectPointOntoPlane,
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
