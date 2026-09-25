import type { SolidBody, Vec3 } from './types';
import { computeMassProperties } from './brep';

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

/** Möller–Trumbore ray/triangle hit test (positive distance). */
function rayHitsTriangle(orig: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const px = dir.y * e2.z - dir.z * e2.y;
  const py = dir.z * e2.x - dir.x * e2.z;
  const pz = dir.x * e2.y - dir.y * e2.x;
  const det = e1.x * px + e1.y * py + e1.z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const t = sub(orig, a);
  const u = (t.x * px + t.y * py + t.z * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = t.y * e1.z - t.z * e1.y;
  const qy = t.z * e1.x - t.x * e1.z;
  const qz = t.x * e1.y - t.y * e1.x;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2.x * qx + e2.y * qy + e2.z * qz) * inv > 1e-9;
}

/**
 * Whether a point lies inside a closed mesh, by ray-casting parity: cast a ray
 * and count surface crossings — odd means inside. Uses a slightly off-axis
 * direction to avoid grazing axis-aligned faces.
 */
export function isPointInsideBody(body: SolidBody, p: Vec3): boolean {
  const dir = { x: 0.5773, y: 0.5774, z: 0.5775 };
  let crossings = 0;
  for (const f of body.faces) {
    const vs = f.vertices;
    // Cheap ray-vs-face-AABB slab test first: the voxel engines cast millions
    // of these rays, and the conservative reject skips the triangle math for
    // the vast majority of faces at any given query point.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of vs) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    let t0 = 0;
    let t1 = Infinity;
    let hit = true;
    const slab = (o: number, d: number, lo: number, hi: number): boolean => {
      if (d > 1e-12 || d < -1e-12) {
        let ta = (lo - o) / d;
        let tb = (hi - o) / d;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return false;
      } else if (o < lo || o > hi) {
        return false;
      }
      return true;
    };
    if (!slab(p.x, dir.x, minX, maxX) || !slab(p.y, dir.y, minY, maxY) || !slab(p.z, dir.z, minZ, maxZ)) {
      hit = false;
    }
    if (!hit) continue;
    for (let i = 1; i < vs.length - 1; i++) {
      if (rayHitsTriangle(p, dir, vs[0]!, vs[i]!, vs[i + 1]!)) crossings++;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Interference (overlap) detection between two bodies — SolidWorks'
 * Interference Detection. Broad-phase AABB rejection, then true if any vertex
 * of one body lies inside the other. Catches volumetric overlap (the common
 * case); pure edge-edge grazing with no contained vertex is not flagged.
 */
export function bodiesInterfere(a: SolidBody, b: SolidBody): boolean {
  const bbA = aabb(a);
  const bbB = aabb(b);
  if (
    bbA.max.x < bbB.min.x || bbB.max.x < bbA.min.x ||
    bbA.max.y < bbB.min.y || bbB.max.y < bbA.min.y ||
    bbA.max.z < bbB.min.z || bbB.max.z < bbA.min.z
  ) {
    return false;
  }
  return a.vertices.some((p) => isPointInsideBody(b, p)) || b.vertices.some((p) => isPointInsideBody(a, p));
}

/**
 * Volume of the overlap region between two bodies — the figure SolidWorks'
 * Interference Detection reports. Estimated by sampling a regular grid over the
 * bounding-box intersection and counting cells inside both bodies. Deterministic
 * (no randomness); accuracy improves with `samplesPerAxis`. Returns 0 when the
 * AABBs don't overlap.
 */
export function interferenceVolume(a: SolidBody, b: SolidBody, samplesPerAxis = 24): number {
  const bbA = aabb(a);
  const bbB = aabb(b);
  const lo = { x: Math.max(bbA.min.x, bbB.min.x), y: Math.max(bbA.min.y, bbB.min.y), z: Math.max(bbA.min.z, bbB.min.z) };
  const hi = { x: Math.min(bbA.max.x, bbB.max.x), y: Math.min(bbA.max.y, bbB.max.y), z: Math.min(bbA.max.z, bbB.max.z) };
  const dx = hi.x - lo.x, dy = hi.y - lo.y, dz = hi.z - lo.z;
  if (dx <= 0 || dy <= 0 || dz <= 0) return 0;

  const n = Math.max(2, Math.floor(samplesPerAxis));
  const cell = (dx / n) * (dy / n) * (dz / n);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const px = lo.x + ((i + 0.5) / n) * dx;
    for (let j = 0; j < n; j++) {
      const py = lo.y + ((j + 0.5) / n) * dy;
      for (let k = 0; k < n; k++) {
        const pz = lo.z + ((k + 0.5) / n) * dz;
        const p = { x: px, y: py, z: pz };
        if (isPointInsideBody(a, p) && isPointInsideBody(b, p)) inside++;
      }
    }
  }
  return inside * cell;
}

export interface SceneMassProperties {
  bodyCount: number;
  totalVolume: number;
  totalMass: number;
  /** Mass-weighted center of mass of all bodies combined. */
  centerOfMass: Vec3;
}

/**
 * Combined mass properties of a multi-body scene (assembly), like SolidWorks'
 * assembly mass properties: total volume, total mass, and the mass-weighted
 * center of mass across all bodies, for the given uniform density.
 */
export function computeSceneMassProperties(bodies: SolidBody[], density = 1): SceneMassProperties {
  let totalVolume = 0;
  let totalMass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const body of bodies) {
    const mp = computeMassProperties(body, density);
    totalVolume += mp.volume;
    totalMass += mp.mass;
    cx += mp.centerOfMass.x * mp.mass;
    cy += mp.centerOfMass.y * mp.mass;
    cz += mp.centerOfMass.z * mp.mass;
  }
  const centerOfMass = totalMass > 1e-12 ? { x: cx / totalMass, y: cy / totalMass, z: cz / totalMass } : { x: 0, y: 0, z: 0 };
  return { bodyCount: bodies.length, totalVolume, totalMass, centerOfMass };
}

function aabb(body: SolidBody): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/** Measure tool mode: two-point distance, three-point angle, or single-face area. */
export type MeasureMode = 'distance' | 'angle' | 'area';

/** The face targeted by the area mode: ids into the scene's bodies. */
export interface MeasureFacePick {
  bodyId: string;
  faceId: string;
}

/** What the measure HUD renders: a formatted value and the 3D point it anchors to. */
export interface MeasureReadout {
  text: string;
  anchor: Vec3;
}

/**
 * Angle in DEGREES at `vertex` between the rays to `a` and `b` (0–180), like
 * Fusion's 3-point angle measure. Degenerate arms (zero length) read as 0.
 * Note the argument order: vertex FIRST (unlike sketch/snap's a-b-c helper).
 */
export function angleBetweenRays(vertex: Vec3, a: Vec3, b: Vec3): number {
  const u = sub(a, vertex);
  const v = sub(b, vertex);
  const lu = Math.hypot(u.x, u.y, u.z);
  const lv = Math.hypot(v.x, v.y, v.z);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const d = Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)));
  return (Math.acos(d) * 180) / Math.PI;
}

/**
 * Area of a 3D polygon by Newell's method: half the magnitude of the summed
 * cross products of consecutive vertex pairs. Exact for planar loops (any
 * orientation — no axis alignment needed) and the best average for nearly
 * planar ones. 0 for fewer than 3 points.
 */
export function polygonArea3D(points: Vec3[]): number {
  if (points.length < 3) return 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    nx += p.y * q.z - p.z * q.y;
    ny += p.z * q.x - p.x * q.z;
    nz += p.x * q.y - p.y * q.x;
  }
  return 0.5 * Math.hypot(nx, ny, nz);
}

/**
 * Area and area-weighted centroid of one face of a body: the face's ordered
 * vertex loop is triangulated as a fan, each triangle's area comes from the
 * cross-product magnitude, and the centroid is the area-weighted average of
 * the triangle centroids. Null for an unknown face id or a loop with <3
 * vertices; a degenerate (zero-area) loop reports area 0 with the vertex
 * average as centroid.
 */
export function faceAreaAndCentroid(body: SolidBody, faceId: string): { area: number; centroid: Vec3 } | null {
  const face = body.faces.find((f) => f.id === faceId);
  if (!face || face.vertices.length < 3) return null;
  const vs = face.vertices;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 1; i < vs.length - 1; i++) {
    const a = vs[0]!;
    const b = vs[i]!;
    const c = vs[i + 1]!;
    const ab = sub(b, a);
    const ac = sub(c, a);
    const cr = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
    const t = 0.5 * Math.hypot(cr.x, cr.y, cr.z);
    area += t;
    cx += ((a.x + b.x + c.x) / 3) * t;
    cy += ((a.y + b.y + c.y) / 3) * t;
    cz += ((a.z + b.z + c.z) / 3) * t;
  }
  if (area <= 1e-12) {
    const n = vs.length;
    const avg = (sel: (v: Vec3) => number) => vs.reduce((s, v) => s + sel(v), 0) / n;
    return { area: 0, centroid: { x: avg((v) => v.x), y: avg((v) => v.y), z: avg((v) => v.z) } };
  }
  return { area, centroid: { x: cx / area, y: cy / area, z: cz / area } };
}

/**
 * The measure HUD's readout, computed purely from the store's measure state so
 * the viewport just renders it: locale-independent strings ("12.3 mm",
 * "∠ 45.0°", "A 123.4 mm²") anchored at the midpoint of the distance chain,
 * the angle's vertex, or the face's centroid. Null while the active mode
 * doesn't have enough picks yet (HUD then shows the mode hint instead).
 *
 * - distance: path length over the picked chain (2 picks = the classic
 *   point-to-point distance the tool has always shown);
 * - angle: angle at the MIDDLE pick between the rays to picks 1 and 3;
 * - area: the fan-triangulated area of the picked face.
 */
export function computeMeasureReadout(
  mode: MeasureMode,
  pts: Vec3[],
  facePick: MeasureFacePick | null,
  bodies: SolidBody[],
): MeasureReadout | null {
  if (mode === 'distance') {
    if (pts.length < 2) return null;
    let length = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = sub(pts[i]!, pts[i - 1]!);
      length += Math.hypot(d.x, d.y, d.z);
    }
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    return {
      text: `${length.toFixed(1)} mm`,
      anchor: { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, z: (first.z + last.z) / 2 },
    };
  }
  if (mode === 'angle') {
    if (pts.length < 3) return null;
    return { text: `∠ ${angleBetweenRays(pts[1]!, pts[0]!, pts[2]!).toFixed(1)}°`, anchor: pts[1]! };
  }
  if (!facePick) return null;
  const body = bodies.find((b) => b.id === facePick.bodyId);
  if (!body) return null;
  const face = faceAreaAndCentroid(body, facePick.faceId);
  if (!face) return null;
  return { text: `A ${face.area.toFixed(1)} mm²`, anchor: face.centroid };
}
