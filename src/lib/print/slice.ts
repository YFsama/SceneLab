import type { SolidBody, Vec3 } from '../geometry/types';

export interface CrossSection {
  /** Height of the cut along the build axis (mm). */
  height: number;
  /** Cross-sectional (filled) area at the cut, mm². */
  area: number;
  /** Total contour length of the cut, mm (wall/perimeter length for a layer). */
  perimeter: number;
  /** Number of intersection segments (triangles crossed). */
  segments: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Orthonormal (u, v) basis spanning the plane perpendicular to `up`. */
function planeBasis(up: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(up);
  const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(ref, n));
  return { u, v: cross(n, u) };
}

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z });
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Cross-section of a closed mesh by a plane at `height` along the build axis
 * (`up`, default +Y): its filled area and contour perimeter.
 *
 * Each triangle that straddles the plane yields one segment. Orienting every
 * segment along `faceNormal × up` makes them trace the contour consistently
 * CCW (for outward-wound meshes), so a shoelace sum over the segments gives the
 * enclosed area directly — no loop assembly needed. Watertight, consistently
 * wound input (as produced by the primitives) is assumed.
 */
export function sliceCrossSection(body: SolidBody, height: number, up: Vec3 = { x: 0, y: 1, z: 0 }): CrossSection {
  const axis = normalize(up);
  const { u, v } = planeBasis(axis);
  const eps = 1e-9;

  let area2 = 0; // twice the signed area
  let perimeter = 0;
  let segments = 0;

  for (const face of body.faces) {
    const vs = face.vertices;
    for (let i = 1; i < vs.length - 1; i++) {
      const tri = [vs[0]!, vs[i]!, vs[i + 1]!];
      const s = tri.map((p) => dot(p, axis) - height);

      // Intersection points where consecutive edges straddle the plane.
      const pts: Vec3[] = [];
      for (let e = 0; e < 3; e++) {
        const sa = s[e]!;
        const sb = s[(e + 1) % 3]!;
        if ((sa < -eps && sb > eps) || (sa > eps && sb < -eps)) {
          pts.push(lerp(tri[e]!, tri[(e + 1) % 3]!, sa / (sa - sb)));
        }
      }
      if (pts.length !== 2) continue;

      // Orient the segment so the contour is consistently wound (CCW).
      const gn = triNormal(tri[0]!, tri[1]!, tri[2]!);
      const orient = dot(gn, face.normal) < 0 ? -1 : 1;
      const dir = cross({ x: gn.x * orient, y: gn.y * orient, z: gn.z * orient }, axis);
      let pa = pts[0]!;
      let pb = pts[1]!;
      if (dot({ x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z }, dir) < 0) {
        [pa, pb] = [pb, pa];
      }

      area2 += dot(pa, u) * dot(pb, v) - dot(pb, u) * dot(pa, v);
      perimeter += Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      segments += 1;
    }
  }

  return { height, area: Math.abs(area2) / 2, perimeter, segments };
}
