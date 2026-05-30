import type { SolidBody, Vec3 } from './types';

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Closest point on triangle (a,b,c) to point p — Ericson, Real-Time Collision Detection. */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { x: a.x + ab.x * v, y: a.y + ab.y * v, z: a.z + ab.z * v };
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { x: a.x + ac.x * w, y: a.y + ac.y * w, z: a.z + ac.z * w };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { x: b.x + (c.x - b.x) * w, y: b.y + (c.y - b.y) * w, z: b.z + (c.z - b.z) * w };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return { x: a.x + ab.x * v + ac.x * w, y: a.y + ab.y * v + ac.y * w, z: a.z + ab.z * v + ac.z * w };
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Minimum distance between two bodies' surfaces (clearance) — the value
 * SolidWorks' Measure reports between parts. Each body's vertices are tested
 * against the other's fan-triangulated faces (both directions); returns the
 * smallest gap. 0 when surfaces touch. This samples vertices, so it is exact
 * for flat-faced parts and a close lower bound for curved meshes.
 */
export function minDistanceBetweenBodies(a: SolidBody, b: SolidBody): number {
  if (a.vertices.length === 0 || b.vertices.length === 0) return Infinity;
  const triangles = (body: SolidBody): [Vec3, Vec3, Vec3][] => {
    const tris: [Vec3, Vec3, Vec3][] = [];
    for (const f of body.faces) {
      for (let i = 1; i < f.vertices.length - 1; i++) tris.push([f.vertices[0]!, f.vertices[i]!, f.vertices[i + 1]!]);
    }
    return tris;
  };
  const triA = triangles(a);
  const triB = triangles(b);
  let min = Infinity;
  const probe = (verts: Vec3[], tris: [Vec3, Vec3, Vec3][]) => {
    for (const p of verts) {
      for (const [t0, t1, t2] of tris) {
        const d = dist2(p, closestOnTriangle(p, t0, t1, t2));
        if (d < min) min = d;
      }
    }
  };
  probe(a.vertices, triB);
  probe(b.vertices, triA);
  return Math.sqrt(min);
}
