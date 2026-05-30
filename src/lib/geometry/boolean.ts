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
  const at = (i: number, j: number, k: number) => occ[(i * N + j) * N + k]!;
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

  const faces: Face[] = [];
  // Corner position of grid node (gi,gj,gk): low corner of cell (gi,gj,gk).
  const corner = (gi: number, gj: number, gk: number): Vec3 => ({
    x: lo.x + (gi - 1) * cs.x,
    y: lo.y + (gj - 1) * cs.y,
    z: lo.z + (gk - 1) * cs.z,
  });
  const quad = (p: Vec3[], normal: Vec3) => faces.push({ id: genId('face'), vertices: p, normal });

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      for (let k = 1; k <= n; k++) {
        if (!at(i, j, k)) continue;
        // Cell spans corners (i..i+1, j..j+1, k..k+1) in node coords.
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

  const vertices: Vec3[] = [];
  for (const f of faces) vertices.push(...f.vertices);
  return { id: genId('body'), name: `Boolean (${op})`, vertices, faces, edges: buildEdgesFromFaces(faces) };
}
