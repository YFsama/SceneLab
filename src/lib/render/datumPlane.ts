import type { Vec3, PlaneDefinition } from '../geometry/types';

/**
 * The four corner points of a square datum-plane quad of side `size`, centred on
 * the plane origin and spanned by its (u, v) basis. Order is CCW around the
 * normal: (−u−v), (+u−v), (+u+v), (−u+v) — suitable for a quad outline or a
 * two-triangle fill. Pure geometry so it can be unit-tested without a renderer.
 */
export function datumPlaneCorners(plane: PlaneDefinition, size: number): [Vec3, Vec3, Vec3, Vec3] {
  const h = size / 2;
  const { origin: o, u, v } = plane;
  const at = (su: number, sv: number): Vec3 => ({
    x: o.x + u.x * su * h + v.x * sv * h,
    y: o.y + u.y * su * h + v.y * sv * h,
    z: o.z + u.z * su * h + v.z * sv * h,
  });
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

/**
 * Flat position array (xyz triples) for the datum-plane quad rendered as two
 * triangles (0-1-2, 0-2-3), ready for a THREE BufferAttribute.
 */
export function datumPlaneTriangles(plane: PlaneDefinition, size: number): number[] {
  const [a, b, c, d] = datumPlaneCorners(plane, size);
  const push = (out: number[], p: Vec3) => out.push(p.x, p.y, p.z);
  const out: number[] = [];
  push(out, a); push(out, b); push(out, c);
  push(out, a); push(out, c); push(out, d);
  return out;
}

/**
 * Closed outline (5 points: the 4 corners plus the first repeated) for drawing
 * the datum-plane border as a line loop.
 */
export function datumPlaneOutline(plane: PlaneDefinition, size: number): Vec3[] {
  const [a, b, c, d] = datumPlaneCorners(plane, size);
  return [a, b, c, d, a];
}
