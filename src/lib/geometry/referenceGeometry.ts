import type { SolidBody, Vec3, PlaneDefinition } from './types';

let nextId = 1;
const genId = () => `plane_${nextId++}`;

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v: Vec3): Vec3 {
  const l = len(v);
  if (l < 1e-12) throw new Error('Cannot build a plane from a zero-length normal');
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Build a datum plane from an origin and normal, choosing a stable in-plane
 * basis (u, v) so the plane is fully oriented. The basis is right-handed:
 * u × v = normal.
 */
export function makePlane(origin: Vec3, normal: Vec3, name = 'Plane'): PlaneDefinition {
  const n = normalize(normal);
  // Pick the world axis least aligned with n to seed a stable tangent.
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const seed: Vec3 = ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const u = normalize(cross(seed, n));
  const v = cross(n, u); // already unit length (n ⟂ u, both unit)
  return { id: genId(), name, origin: { ...origin }, normal: n, u, v };
}

/** The three standard datum planes through the world origin (SolidWorks Front/Top/Right). */
export function standardPlanes(): PlaneDefinition[] {
  const o = { x: 0, y: 0, z: 0 };
  return [
    makePlane(o, { x: 0, y: 0, z: 1 }, 'Front (XY)'),
    makePlane(o, { x: 0, y: 1, z: 0 }, 'Top (XZ)'),
    makePlane(o, { x: 1, y: 0, z: 0 }, 'Right (YZ)'),
  ];
}

/**
 * A datum plane coincident with a body face, optionally offset along the face's
 * outward normal by `offset` mm. Returns null if the face id is missing.
 */
export function planeFromFace(body: SolidBody, faceId: string, offset = 0): PlaneDefinition | null {
  const f = body.faces.find((face) => face.id === faceId);
  if (!f) return null;
  const n = normalize(f.normal);
  const c = { x: 0, y: 0, z: 0 };
  for (const p of f.vertices) {
    c.x += p.x / f.vertices.length;
    c.y += p.y / f.vertices.length;
    c.z += p.z / f.vertices.length;
  }
  const origin = { x: c.x + n.x * offset, y: c.y + n.y * offset, z: c.z + n.z * offset };
  return makePlane(origin, n, `Plane on ${faceId}`);
}

/** A new plane parallel to `plane`, shifted `distance` mm along its normal. */
export function offsetPlane(plane: PlaneDefinition, distance: number): PlaneDefinition {
  const origin = {
    x: plane.origin.x + plane.normal.x * distance,
    y: plane.origin.y + plane.normal.y * distance,
    z: plane.origin.z + plane.normal.z * distance,
  };
  return makePlane(origin, plane.normal, `${plane.name} +${distance}`);
}

/**
 * The midplane halfway between two faces — SolidWorks' "mid plane" reference.
 * The faces should be (roughly) parallel; the plane sits at the midpoint of
 * their centroids with the averaged normal. Returns null if either id is
 * missing or the faces are not parallel enough to define a stable midplane.
 */
export function midplaneBetweenFaces(body: SolidBody, faceIdA: string, faceIdB: string): PlaneDefinition | null {
  const a = body.faces.find((f) => f.id === faceIdA);
  const b = body.faces.find((f) => f.id === faceIdB);
  if (!a || !b) return null;
  const na = normalize(a.normal);
  const nb = normalize(b.normal);
  // Parallel-ish: |na·nb| close to 1 (same or opposite facing).
  if (Math.abs(dot(na, nb)) < 0.9) return null;
  const centroid = (f: typeof a): Vec3 => {
    const c = { x: 0, y: 0, z: 0 };
    for (const p of f.vertices) {
      c.x += p.x / f.vertices.length;
      c.y += p.y / f.vertices.length;
      c.z += p.z / f.vertices.length;
    }
    return c;
  };
  const ca = centroid(a);
  const cb = centroid(b);
  const origin = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, z: (ca.z + cb.z) / 2 };
  // Flip nb to agree with na before averaging so opposite-facing walls don't cancel.
  const nbAligned = dot(na, nb) < 0 ? { x: -nb.x, y: -nb.y, z: -nb.z } : nb;
  const avg = { x: na.x + nbAligned.x, y: na.y + nbAligned.y, z: na.z + nbAligned.z };
  return makePlane(origin, avg, 'Midplane');
}

/** Signed distance from a point to a plane (positive on the normal side). */
export function signedDistanceToPlane(plane: PlaneDefinition, point: Vec3): number {
  return dot(plane.normal, { x: point.x - plane.origin.x, y: point.y - plane.origin.y, z: point.z - plane.origin.z });
}

/** Orthogonal projection of a point onto a plane. */
export function projectPointOntoPlane(plane: PlaneDefinition, point: Vec3): Vec3 {
  const d = signedDistanceToPlane(plane, point);
  return { x: point.x - plane.normal.x * d, y: point.y - plane.normal.y * d, z: point.z - plane.normal.z * d };
}

// --- Reference axes (datum axes) ---

let nextAxisId = 1;
const genAxisId = () => `axis_${nextAxisId++}`;

/** A datum axis: an infinite line given by a point and a unit direction. */
export interface AxisDefinition {
  id: string;
  name: string;
  origin: Vec3;
  direction: Vec3;
}

/** Build a datum axis from a point and a direction (normalized). Throws on a zero direction. */
export function makeAxis(origin: Vec3, direction: Vec3, name = 'Axis'): AxisDefinition {
  return { id: genAxisId(), name, origin: { ...origin }, direction: normalize(direction) };
}

/** Datum axis through two distinct points; null if the points coincide. */
export function axisFromPoints(p1: Vec3, p2: Vec3, name = 'Axis'): AxisDefinition | null {
  const dir = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
  if (len(dir) < 1e-12) return null;
  return makeAxis(p1, dir, name);
}

/**
 * Datum axis at the intersection of two datum planes (SolidWorks "axis from two
 * planes"). Returns null if the planes are parallel. Direction = nA × nB; a
 * point on the line is found by Goldman's two-plane formula.
 */
export function axisFromPlanes(a: PlaneDefinition, b: PlaneDefinition, name = 'Axis'): AxisDefinition | null {
  const u = cross(a.normal, b.normal);
  const uu = dot(u, u);
  if (uu < 1e-18) return null; // parallel planes — no intersection line
  const ca = dot(a.normal, a.origin);
  const cb = dot(b.normal, b.origin);
  const t1 = cross(b.normal, u); // ca · (nB × u)
  const t2 = cross(u, a.normal); // cb · (u × nA)
  const origin: Vec3 = {
    x: (ca * t1.x + cb * t2.x) / uu,
    y: (ca * t1.y + cb * t2.y) / uu,
    z: (ca * t1.z + cb * t2.z) / uu,
  };
  return makeAxis(origin, u, name);
}

/** Closest point on an (infinite) axis to a point. */
export function closestPointOnAxis(axis: AxisDefinition, point: Vec3): Vec3 {
  const d = axis.direction;
  const w = { x: point.x - axis.origin.x, y: point.y - axis.origin.y, z: point.z - axis.origin.z };
  const t = dot(w, d); // direction is unit length
  return { x: axis.origin.x + d.x * t, y: axis.origin.y + d.y * t, z: axis.origin.z + d.z * t };
}

/** Perpendicular distance from a point to an axis. */
export function distancePointToAxis(axis: AxisDefinition, point: Vec3): number {
  const c = closestPointOnAxis(axis, point);
  return Math.hypot(point.x - c.x, point.y - c.y, point.z - c.z);
}
