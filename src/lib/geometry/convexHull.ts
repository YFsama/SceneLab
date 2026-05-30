import type { Vec3 } from './types';

interface HullFace {
  a: number;
  b: number;
  c: number;
  normal: Vec3;
  offset: number; // normal · vertexA
}

const sub = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * 2D convex hull (Andrew's monotone chain), returning the hull points CCW with
 * no repeated closing point. Fewer than 3 points are returned as-is. A simple,
 * non-self-intersecting outline — unlike sorting points by angle.
 */
export function convexHull2D<P extends { x: number; y: number }>(points: P[]): P[] {
  if (points.length < 3) return [...points];
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const crossZ = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && crossZ(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface ConvexHull {
  /** Hull vertices (a subset of the input points). */
  vertices: Vec3[];
  /** Triangular faces as index triples into `vertices`, CCW / outward. */
  faces: [number, number, number][];
  /** Enclosed volume of the hull. */
  volume: number;
}

/**
 * 3D convex hull of a point set via the incremental algorithm. Returns null if
 * the points are degenerate (fewer than 4, or all coplanar) — there is no
 * 3D hull then. Faces are outward-oriented; `volume` is the hull volume.
 */
export function computeConvexHull(points: Vec3[], tol = 1e-9): ConvexHull | null {
  const pts = dedupe(points, tol);
  if (pts.length < 4) return null;

  const seed = initialTetrahedron(pts, tol);
  if (!seed) return null; // coplanar / degenerate

  const faces: HullFace[] = [];
  const centroid = {
    x: (pts[seed[0]]!.x + pts[seed[1]]!.x + pts[seed[2]]!.x + pts[seed[3]]!.x) / 4,
    y: (pts[seed[0]]!.y + pts[seed[1]]!.y + pts[seed[2]]!.y + pts[seed[3]]!.y) / 4,
    z: (pts[seed[0]]!.z + pts[seed[1]]!.z + pts[seed[2]]!.z + pts[seed[3]]!.z) / 4,
  };
  const addFace = (a: number, b: number, c: number) => {
    let n = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
    // Orient outward (away from the seed centroid).
    if (dot(n, sub(pts[a]!, centroid)) < 0) {
      [b, c] = [c, b];
      n = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
    }
    faces.push({ a, b, c, normal: n, offset: dot(n, pts[a]!) });
  };
  addFace(seed[0], seed[1], seed[2]);
  addFace(seed[0], seed[1], seed[3]);
  addFace(seed[0], seed[2], seed[3]);
  addFace(seed[1], seed[2], seed[3]);

  const used = new Set(seed);
  for (let pi = 0; pi < pts.length; pi++) {
    if (used.has(pi)) continue;
    const p = pts[pi]!;
    // Faces visible from p (p is in front of the face plane).
    const visible = faces.filter((f) => dot(f.normal, p) - f.offset > tol);
    if (visible.length === 0) continue; // inside the current hull

    // Horizon = edges used by exactly one visible face.
    const edgeCount = new Map<string, [number, number]>();
    const seen = new Map<string, number>();
    for (const f of visible) {
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as [number, number][]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        edgeCount.set(key, [u, v]);
      }
    }
    const visibleSet = new Set(visible);
    // Remove visible faces.
    for (let i = faces.length - 1; i >= 0; i--) {
      if (visibleSet.has(faces[i]!)) faces.splice(i, 1);
    }
    // New faces from each horizon edge (oriented edge, so the new face faces out).
    for (const [key, [u, v]] of edgeCount) {
      if (seen.get(key) !== 1) continue; // shared by two visible faces → interior
      addFace(u, v, pi);
    }
    used.add(pi);
  }

  // Compact to the vertices actually referenced.
  const remap = new Map<number, number>();
  const outVerts: Vec3[] = [];
  const outFaces: [number, number, number][] = [];
  const idx = (i: number): number => {
    let r = remap.get(i);
    if (r === undefined) {
      r = outVerts.length;
      remap.set(i, r);
      outVerts.push(pts[i]!);
    }
    return r;
  };
  let volume = 0;
  for (const f of faces) {
    outFaces.push([idx(f.a), idx(f.b), idx(f.c)]);
    volume += dot(pts[f.a]!, cross(pts[f.b]!, pts[f.c]!)) / 6;
  }
  return { vertices: outVerts, faces: outFaces, volume: Math.abs(volume) };
}

function dedupe(points: Vec3[], tol: number): Vec3[] {
  const q = 1 / Math.max(tol, 1e-12);
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (const p of points) {
    const k = `${Math.round(p.x * q)},${Math.round(p.y * q)},${Math.round(p.z * q)}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** Indices of four non-coplanar points, or null if all points are coplanar. */
function initialTetrahedron(pts: Vec3[], tol: number): [number, number, number, number] | null {
  const n = pts.length;
  // Two most distant points along X-extremes (cheap, good enough seed).
  let i0 = 0;
  let i1 = 0;
  let maxd = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dot(sub(pts[i]!, pts[j]!), sub(pts[i]!, pts[j]!));
      if (d > maxd) {
        maxd = d;
        i0 = i;
        i1 = j;
      }
    }
    if (n > 200) break; // cap the O(n²) seed search for big clouds
  }
  if (maxd < tol) return null;
  // Farthest from line i0-i1.
  const line = sub(pts[i1]!, pts[i0]!);
  let i2 = -1;
  let maxArea = tol;
  for (let i = 0; i < n; i++) {
    const area = dot(cross(line, sub(pts[i]!, pts[i0]!)), cross(line, sub(pts[i]!, pts[i0]!)));
    if (area > maxArea) {
      maxArea = area;
      i2 = i;
    }
  }
  if (i2 < 0) return null;
  // Farthest from plane i0-i1-i2.
  const planeN = cross(sub(pts[i1]!, pts[i0]!), sub(pts[i2]!, pts[i0]!));
  let i3 = -1;
  let maxVol = tol;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(dot(planeN, sub(pts[i]!, pts[i0]!)));
    if (v > maxVol) {
      maxVol = v;
      i3 = i;
    }
  }
  if (i3 < 0) return null;
  return [i0, i1, i2, i3];
}
