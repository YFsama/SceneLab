/**
 * Pure voxel geometry kernels, isolated from the Manifold dispatch layer so a
 * Web Worker can bundle just these (no WASM chunk) and keep the main thread
 * free during the seconds-long occupancy sampling. Behaviour is identical to
 * what boolean.ts dispatches to as its fallback.
 */
import type { SolidBody, Vec3, Face, PlaneDefinition } from './types';
import { isPointInsideBody, prepareBodyForInsideTests } from './measure';
import { buildEdgesFromFaces } from './brep';
import { signedDistanceToPlane } from './referenceGeometry';
import { applyMirror } from './operations';

export type BooleanOp = 'union' | 'difference' | 'intersect';

let nextId = 1;
const genId = (p: string) => `${p}_bool_${nextId++}`;

export function aabb(body: SolidBody) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/** Voxel boolean: occupancy sampled on a grid, boundary faces emitted. */
export function booleanOpVoxel(a: SolidBody, b: SolidBody, op: BooleanOp, resolution = 32): SolidBody | null {
  const bbA = aabb(a);
  const bbB = aabb(b);
  // Region the result can occupy.
  let lo: Vec3;
  let hi: Vec3;
  if (op === 'intersect') {
    lo = { x: Math.max(bbA.min.x, bbB.min.x), y: Math.max(bbA.min.y, bbB.min.y), z: Math.max(bbA.min.z, bbB.min.z) };
    hi = { x: Math.min(bbA.max.x, bbB.max.x), y: Math.min(bbA.max.y, bbB.max.y), z: Math.min(bbA.max.z, bbB.max.z) };
  } else if (op === 'difference') {
    lo = { ...bbA.min };
    hi = { ...bbA.max };
  } else {
    lo = { x: Math.min(bbA.min.x, bbB.min.x), y: Math.min(bbA.min.y, bbB.min.y), z: Math.min(bbA.min.z, bbB.min.z) };
    hi = { x: Math.max(bbA.max.x, bbB.max.x), y: Math.max(bbA.max.y, bbB.max.y), z: Math.max(bbA.max.z, bbB.max.z) };
  }
  const dim = { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z };
  if (dim.x <= 0 || dim.y <= 0 || dim.z <= 0) return null;

  const n = Math.max(2, Math.floor(resolution));
  // Pad the grid by one empty cell each side so boundary faces always close.
  const cs = { x: dim.x / n, y: dim.y / n, z: dim.z / n };
  const N = n + 2;
  const occ = new Uint8Array(N * N * N);
  const center = (i: number, j: number, k: number): Vec3 => ({
    x: lo.x + (i - 1 + 0.5) * cs.x,
    y: lo.y + (j - 1 + 0.5) * cs.y,
    z: lo.z + (k - 1 + 0.5) * cs.z,
  });

  let any = false;
  // The sampling loop below casts n³ rays per body; build the per-body face
  // AABB cache once instead of inside the first query.
  prepareBodyForInsideTests(a);
  prepareBodyForInsideTests(b);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        const p = center(i, j, k);
        const inA = isPointInsideBody(a, p);
        const inB = isPointInsideBody(b, p);
        const solid = op === 'union' ? inA || inB : op === 'intersect' ? inA && inB : inA && !inB;
        if (solid) {
          occ[(i * N + j) * N + k] = 1;
          any = true;
        }
      }
    }
  }
  if (!any) return null;
  return meshFromOccupancy(occ, N, n, lo, cs, `Boolean (${op})`);
}

/** Emit the boundary faces between solid and empty cells of a padded grid. */
function meshFromOccupancy(occ: Uint8Array, N: number, n: number, lo: Vec3, cs: Vec3, name: string): SolidBody | null {
  const at = (i: number, j: number, k: number) => occ[(i * N + j) * N + k]!;
  const corner = (gi: number, gj: number, gk: number): Vec3 => ({
    x: lo.x + (gi - 1) * cs.x,
    y: lo.y + (gj - 1) * cs.y,
    z: lo.z + (gk - 1) * cs.z,
  });
  const faces: Face[] = [];
  const quad = (p: Vec3[], normal: Vec3) => faces.push({ id: genId('face'), vertices: p, normal });
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        if (!at(i, j, k)) continue;
        const x0 = i, x1 = i + 1, y0 = j, y1 = j + 1, z0 = k, z1 = k + 1;
        if (!at(i - 1, j, k)) quad([corner(x0, y0, z0), corner(x0, y0, z1), corner(x0, y1, z1), corner(x0, y1, z0)], { x: -1, y: 0, z: 0 });
        if (!at(i + 1, j, k)) quad([corner(x1, y0, z0), corner(x1, y1, z0), corner(x1, y1, z1), corner(x1, y0, z1)], { x: 1, y: 0, z: 0 });
        if (!at(i, j - 1, k)) quad([corner(x0, y0, z0), corner(x1, y0, z0), corner(x1, y0, z1), corner(x0, y0, z1)], { x: 0, y: -1, z: 0 });
        if (!at(i, j + 1, k)) quad([corner(x0, y1, z0), corner(x0, y1, z1), corner(x1, y1, z1), corner(x1, y1, z0)], { x: 0, y: 1, z: 0 });
        if (!at(i, j, k - 1)) quad([corner(x0, y0, z0), corner(x0, y1, z0), corner(x1, y1, z0), corner(x1, y0, z0)], { x: 0, y: 0, z: -1 });
        if (!at(i, j, k + 1)) quad([corner(x0, y0, z1), corner(x1, y0, z1), corner(x1, y1, z1), corner(x0, y1, z1)], { x: 0, y: 0, z: 1 });
      }
    }
  }
  if (faces.length === 0) return null;
  const vertices: Vec3[] = [];
  for (const f of faces) vertices.push(...f.vertices);
  return { id: genId('body'), name, vertices, faces, edges: buildEdgesFromFaces(faces) };
}

/** Mirror across a plane and fuse with the reflection (voxel union). */
export function mirrorMergeVoxel(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3 },
  resolution = 40,
): SolidBody | null {
  const mirrored = applyMirror(body, plane);
  const merged = booleanOpVoxel(body, mirrored, 'union', resolution);
  if (merged) merged.name = `${body.name} (mirrored)`;
  return merged;
}

/** Voxel planar split: cells partitioned by the side of the plane. */
export function splitByPlaneVoxel(
  body: SolidBody,
  plane: PlaneDefinition,
  resolution = 40,
): { positive: SolidBody | null; negative: SolidBody | null } {
  const bb = aabb(body);
  const lo = { ...bb.min };
  const dim = { x: bb.max.x - lo.x, y: bb.max.y - lo.y, z: bb.max.z - lo.z };
  if (dim.x <= 0 || dim.y <= 0 || dim.z <= 0) return { positive: null, negative: null };
  const n = Math.max(2, Math.floor(resolution));
  const cs = { x: dim.x / n, y: dim.y / n, z: dim.z / n };
  const N = n + 2;
  const pos = new Uint8Array(N * N * N);
  const neg = new Uint8Array(N * N * N);
  let anyPos = false;
  let anyNeg = false;
  prepareBodyForInsideTests(body);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        const p = { x: lo.x + (i - 1 + 0.5) * cs.x, y: lo.y + (j - 1 + 0.5) * cs.y, z: lo.z + (k - 1 + 0.5) * cs.z };
        if (!isPointInsideBody(body, p)) continue;
        const idx = (i * N + j) * N + k;
        if (signedDistanceToPlane(plane, p) >= 0) { pos[idx] = 1; anyPos = true; }
        else { neg[idx] = 1; anyNeg = true; }
      }
    }
  }
  return {
    positive: anyPos ? meshFromOccupancy(pos, N, n, lo, cs, `${body.name} (+)`) : null,
    negative: anyNeg ? meshFromOccupancy(neg, N, n, lo, cs, `${body.name} (−)`) : null,
  };
}

/** Voxel hollow: erode the interior by the wall thickness, keep the shell.
 *
 * The erosion is a true EUCLIDEAN distance transform on the (possibly
 * anisotropic) occupancy grid: a cell counts as interior only when its
 * center is at least `wallThickness` (+ half the smallest cell — the wall
 * surface sits between cell centers) from the nearest empty cell, measured
 * in real mm. The previous per-axis Chebyshev erosion quantized the wall
 * per axis: on a 30×30×10 plate at res 48 the cells were 0.625×0.625×0.208,
 * so a nominal 2 mm wall could thin to a single 0.208 mm cell. Distance
 * erosion keeps the wall isotropic on any cell aspect ratio (and correct
 * along diagonal boundaries, which box erosion over-cut).
 */
export function hollowBodyVoxel(body: SolidBody, wallThickness: number, resolution = 40): SolidBody | null {
  if (!(wallThickness > 0)) throw new Error('Wall thickness must be positive');
  const bb = aabb(body);
  const lo = { ...bb.min };
  const dim = { x: bb.max.x - lo.x, y: bb.max.y - lo.y, z: bb.max.z - lo.z };
  if (dim.x <= 0 || dim.y <= 0 || dim.z <= 0) return null;
  const n = Math.max(2, Math.floor(resolution));
  const cs = { x: dim.x / n, y: dim.y / n, z: dim.z / n };
  const N = n + 2;
  const idx = (i: number, j: number, k: number) => (i * N + j) * N + k;

  const inside = new Uint8Array(N * N * N);
  prepareBodyForInsideTests(body);
  // Tiny fixed jitter on the sample points. isPointInsideBody's ray has
  // nearly-equal components, so UNJITTERED lattice-aligned samples (cell
  // centers of an axis-aligned box) systematically graze target edges and
  // flip parity — 182 spurious holes in a perfect 20 mm cube at res 40 —
  // which distance erosion would then carve into wall-sized craters. The
  // offsets are far smaller than a cell and break the symmetry for good.
  const jx = 0.0113, jy = 0.0239, jz = 0.0051;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        const p = { x: lo.x + (i - 1 + 0.5) * cs.x + jx, y: lo.y + (j - 1 + 0.5) * cs.y + jy, z: lo.z + (k - 1 + 0.5) * cs.z + jz };
        if (isPointInsideBody(body, p)) inside[idx(i, j, k)] = 1;
      }
    }
  }

  // Squared distance (mm²) from every cell center to the nearest empty cell
  // center (the one-cell empty padding makes the outer boundary count).
  const d2 = edtSquaredFromEmpty(inside, N, cs.x, cs.y, cs.z);
  // Interior = farther than the wall from any empty cell; the half-cell of
  // slack keeps the emitted wall at ≥ wall − cs_min on every axis (2 mm on
  // 0.625 cells → 1.875 mm, not 2 − 0.625).
  const threshold = wallThickness + Math.min(cs.x, cs.y, cs.z) / 2;

  const shell = new Uint8Array(N * N * N);
  let any = false;
  for (let a = 0; a < shell.length; a++) {
    if (inside[a] && Math.sqrt(d2[a] ?? 0) < threshold) { shell[a] = 1; any = true; }
  }
  if (!any) return null;
  const result = meshFromOccupancy(shell, N, n, lo, cs, 'Hollow');
  if (result) result.name = 'Hollow';
  return result;
}

/**
 * Exact squared Euclidean distance transform of an occupancy cube with
 * ANISOTROPIC cell spacing (Felzenszwalb–Huttenlocher 1D lower-envelope
 * transform, one separable pass per axis with that axis's spacing). Result:
 * d2[i] = squared mm distance from cell i's center to the nearest cell with
 * occupancy 0. O(N³) time, O(N³) memory (one Float64 cube).
 */
function edtSquaredFromEmpty(occ: Uint8Array, N: number, sx: number, sy: number, sz: number): Float64Array {
  const total = N * N * N;
  // Large-finite sentinel instead of Infinity — Felzenszwalb's envelope
  // arithmetic degenerates to NaN on Inf−Inf priors, and the one-cell empty
  // padding guarantees every line reaches a real empty cell anyway.
  const BIG = 1e15;
  const d2 = new Float64Array(total);
  for (let i = 0; i < total; i++) d2[i] = occ[i] ? BIG : 0;

  // One axis pass: rescale priors by 1/s², run the unit-spacing parabola
  // envelope down every line, write back s²·result. `lines` yields the start
  // index of each of the N² lines running along this axis.
  const pass = (stride: number, s: number, lines: () => number[]): void => {
    const inv = 1 / (s * s);
    const g = new Float64Array(N);
    const v = new Int32Array(N);
    const z = new Float64Array(N + 1);
    for (const base of lines()) {
      for (let q = 0; q < N; q++) g[q] = (d2[base + q * stride] ?? 0) * inv;
      let k = 0;
      v[0] = 0;
      z[0] = -Infinity;
      z[1] = Infinity;
      for (let q = 1; q < N; q++) {
        for (;;) {
          const vk = v[k]!;
          // Intersection of parabolas (x−vk)²+g[vk] and (x−q)²+g[q]:
          // s = (q² − vk² + g[q] − g[vk]) / (2(q − vk)).
          const inter = (q * q - vk * vk + g[q]! - g[vk]!) / (2 * (q - vk));
          if (inter > z[k]!) {
            k++;
            v[k] = q;
            z[k] = inter;
            z[k + 1] = Infinity;
            break;
          }
          k--;
        }
      }
      let m = 0;
      for (let q = 0; q < N; q++) {
        while (z[m + 1]! < q) m++;
        const vm = v[m]!;
        d2[base + q * stride] = ((q - vm) * (q - vm) + g[vm]!) * s * s;
      }
    }
  };

  // Index layout: idx = (i*N + j)*N + k.
  const linesI: number[] = []; // vary i (stride N²) over every (j, k)
  const linesJ: number[] = []; // vary j (stride N)   over every (i, k)
  const linesK: number[] = []; // vary k (stride 1)   over every (i, j)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        if (i === 0) linesI.push(j * N + k);
        if (j === 0) linesJ.push(i * N * N + k);
        if (k === 0) linesK.push((i * N + j) * N);
      }
    }
  }
  pass(N * N, sx, () => linesI);
  pass(N, sy, () => linesJ);
  pass(1, sz, () => linesK);
  return d2;
}
