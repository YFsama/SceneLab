import type { SolidBody, Vec3, Face } from './types';
import { isPointInsideBody } from './measure';
import { buildEdgesFromFaces } from './brep';

let nextId = 1;
const genId = (p: string) => `${p}_bool_${nextId++}`;

export type BooleanOp = 'union' | 'difference' | 'intersect';

function aabb(body: SolidBody) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/**
 * Boolean of two solids (union / difference A−B / intersect) via voxel
 * sampling: occupancy is evaluated on a grid using point-in-mesh tests, then
 * the boundary faces between solid and empty cells are emitted. The result is a
 * watertight (closed) blocky solid whose fidelity grows with `resolution`; it
 * may contain non-manifold edges where the staircase touches diagonally —
 * raise the resolution or run weldVertices/repair if a strictly-manifold mesh
 * is required. Returns null if the result is empty.
 */
export function booleanOp(a: SolidBody, b: SolidBody, op: BooleanOp, resolution = 32): SolidBody | null {
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

/**
 * Hollow a solid into a closed shell of approximately `wallThickness` — a true
 * lightweighting hollow (unlike the placeholder applyShell). Voxelize the
 * interior, erode it by the wall thickness (separable Chebyshev erosion), and
 * keep the cells that are inside but not deep — the wall. Watertight blocky
 * result; raise `resolution` for finer walls. Returns null if the wall consumes
 * the whole part.
 */
export function hollowBody(body: SolidBody, wallThickness: number, resolution = 40): SolidBody | null {
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
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        const p = { x: lo.x + (i - 1 + 0.5) * cs.x, y: lo.y + (j - 1 + 0.5) * cs.y, z: lo.z + (k - 1 + 0.5) * cs.z };
        if (isPointInsideBody(body, p)) inside[idx(i, j, k)] = 1;
      }
    }
  }

  // Wall thickness in cells along each axis; erode by that many cells.
  const tx = Math.max(1, Math.round(wallThickness / cs.x));
  const ty = Math.max(1, Math.round(wallThickness / cs.y));
  const tz = Math.max(1, Math.round(wallThickness / cs.z));
  // Separable Chebyshev erosion: a deep cell has all cells within ±t (each axis) solid.
  const erodeAxis = (src: Uint8Array, t: number, axis: 0 | 1 | 2): Uint8Array => {
    const out = new Uint8Array(N * N * N);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= n; j++) {
        for (let k = 1; k <= n; k++) {
          if (!src[idx(i, j, k)]) continue;
          let keep = true;
          for (let d = -t; d <= t && keep; d++) {
            const ii = axis === 0 ? i + d : i;
            const jj = axis === 1 ? j + d : j;
            const kk = axis === 2 ? k + d : k;
            if (ii < 1 || ii > n || jj < 1 || jj > n || kk < 1 || kk > n || !src[idx(ii, jj, kk)]) keep = false;
          }
          if (keep) out[idx(i, j, k)] = 1;
        }
      }
    }
    return out;
  };
  let deep = erodeAxis(inside, tx, 0);
  deep = erodeAxis(deep, ty, 1);
  deep = erodeAxis(deep, tz, 2);

  const shell = new Uint8Array(N * N * N);
  let any = false;
  for (let a = 0; a < shell.length; a++) {
    if (inside[a] && !deep[a]) { shell[a] = 1; any = true; }
  }
  if (!any) return null;
  const result = meshFromOccupancy(shell, N, n, lo, cs, 'Hollow');
  if (result) result.name = 'Hollow';
  return result;
}
