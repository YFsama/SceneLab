/**
 * Exact boolean operations via Manifold (WASM). Voxel booleans (boolean.ts)
 * approximate with a 32³ occupancy grid; Manifold computes watertight,
 * exact-geometry results in milliseconds. The WASM module loads asynchronously,
 * so the engine is warmed up at app start (`warmUpBooleanEngine`) and the sync
 * entry points fall back to the voxel path until (and unless) it is ready.
 */
import type { SolidBody, Face, Vec3 } from './types';
import { buildEdgesFromFaces } from './brep';
import type { BooleanOp } from './boolean';

/* Minimal structural typings for the emscripten module (full d.ts exists in
 * node_modules but the dynamic import surface is easiest used loosely here). */
interface ManifoldMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  numVert: number;
  numTri: number;
}
interface ManifoldInstance {
  volume(): number;
  numTri(): number;
  getMesh(): ManifoldMesh;
  invert(): ManifoldInstance;
  /** Boolean ops (instance methods in Manifold 3.x). */
  add(other: ManifoldInstance): ManifoldInstance;
  subtract(other: ManifoldInstance): ManifoldInstance;
  intersect(other: ManifoldInstance): ManifoldInstance;
}
interface ManifoldModule {
  Manifold: {
    ofMesh(mesh: ManifoldMesh): ManifoldInstance;
    cube(size: [number, number, number], center?: boolean): ManifoldInstance;
  };
  Mesh: new (opts: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => ManifoldMesh;
}

let modulePromise: Promise<void> | null = null;
let ready: ManifoldModule | null = null;

/** Load and initialise the WASM engine once; safe to call repeatedly. */
export function warmUpBooleanEngine(): Promise<void> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const init = (await import('manifold-3d')).default;
      const mod = (await init()) as unknown as ManifoldModule;
      (mod as unknown as { setup(): void }).setup();
      ready = mod;
    })().catch(() => {
      // WASM unavailable (or failed to load) — the voxel engine stays in charge.
      modulePromise = null;
    });
  }
  return modulePromise.then(() => undefined);
}

export function isManifoldEngineReady(): boolean {
  return ready !== null;
}

let nextId = 1;

/**
 * Exact boolean via Manifold. Returns null when the engine is not warmed up,
 * when the input mesh cannot be converted (non-manifold input), or when the
 * boolean result is empty — in every case the caller should fall back to the
 * voxel implementation.
 */
export function booleanOpManifold(a: SolidBody, b: SolidBody, op: BooleanOp): SolidBody | null {
  const mod = ready;
  if (!mod) return null;
  try {
    const ma = toManifold(mod, a);
    const mb = toManifold(mod, b);
    if (!ma || !mb) return null;
    const result = op === 'union' ? ma.add(mb) : op === 'difference' ? ma.subtract(mb) : ma.intersect(mb);
    if (result.numTri() === 0 || Math.abs(result.volume()) < 1e-9) return null;
    return fromManifold(result, `Boolean (${op})`);
  } catch {
    return null;
  }
}

/**
 * Exact planar cut via Manifold: intersect the body with two world-space
 * half-space boxes built from the plane frame. Returns two nulls when the
 * engine is not ready or the body cannot be converted — the caller falls back
 * to the voxel partition.
 */
export function splitByPlaneManifold(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3; u: Vec3; v: Vec3 },
): { positive: SolidBody | null; negative: SolidBody | null } {
  const mod = ready;
  if (!mod) return { positive: null, negative: null };
  try {
    const m = toManifold(mod, body);
    if (!m) return { positive: null, negative: null };

    const norm = (v: Vec3): Vec3 => {
      const len = Math.hypot(v.x, v.y, v.z) || 1;
      return { x: v.x / len, y: v.y / len, z: v.z / len };
    };
    const n = norm(plane.normal);
    const u = norm(plane.u);
    const v = norm(plane.v);

    // Extent of the body around the plane, in the plane frame.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nMin = Infinity, nMax = -Infinity;
    for (const p of body.vertices) {
      const d = { x: p.x - plane.origin.x, y: p.y - plane.origin.y, z: p.z - plane.origin.z };
      const du = d.x * u.x + d.y * u.y + d.z * u.z;
      const dv = d.x * v.x + d.y * v.y + d.z * v.z;
      const dn = d.x * n.x + d.y * n.y + d.z * n.z;
      uMin = Math.min(uMin, du); uMax = Math.max(uMax, du);
      vMin = Math.min(vMin, dv); vMax = Math.max(vMax, dv);
      nMin = Math.min(nMin, dn); nMax = Math.max(nMax, dn);
    }
    const m2 = Math.max(uMax - uMin, vMax - vMin, nMax - nMin) * 0.5 + 1;
    const u0 = uMin - m2, u1 = uMax + m2, v0 = vMin - m2, v1 = vMax + m2;

    // Build the two half-space boxes as world-space meshes (each edge shared
    // by exactly two quads, consistent winding).
    const corner = (a: number, b: number, c: number): Vec3 => ({
      x: plane.origin.x + u.x * a + v.x * b + n.x * c,
      y: plane.origin.y + u.y * a + v.y * b + n.y * c,
      z: plane.origin.z + u.z * a + v.z * b + n.z * c,
    });
    const halfBox = (c0: number, c1: number): ManifoldInstance => {
      const A = corner(u0, v0, c0), B = corner(u1, v0, c0), C = corner(u1, v1, c0), D = corner(u0, v1, c0);
      const E = corner(u0, v0, c1), F = corner(u1, v0, c1), G = corner(u1, v1, c1), H = corner(u0, v1, c1);
      const corners = [A, B, C, D, E, F, G, H];
      const positions: number[] = [];
      for (const p of corners) positions.push(p.x, p.y, p.z);
      // Shared corner indices — Manifold requires a topologically shared mesh;
      // duplicated corner positions per face would leave six disjoint patches.
      const quadIdx = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3],
        [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2],
      ];
      // Orient every quad outward geometrically — the plane frame may be
      // left-handed (u×v = −n), so a fixed winding table is not reliable.
      const center = corners.reduce(
        (s, p) => ({ x: s.x + p.x / 8, y: s.y + p.y / 8, z: s.z + p.z / 8 }),
        { x: 0, y: 0, z: 0 },
      );
      const tris: number[] = [];
      for (const qi of quadIdx) {
        const i0 = qi[0]!, i1 = qi[1]!, i2 = qi[2]!, i3 = qi[3]!;
        const a = corners[i0]!, b = corners[i1]!, c = corners[i2]!;
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
        const nq = {
          x: ab.y * ac.z - ab.z * ac.y,
          y: ab.z * ac.x - ab.x * ac.z,
          z: ab.x * ac.y - ab.y * ac.x,
        };
        const fc = {
          x: (a.x + b.x + c.x + corners[i3]!.x) / 4 - center.x,
          y: (a.y + b.y + c.y + corners[i3]!.y) / 4 - center.y,
          z: (a.z + b.z + c.z + corners[i3]!.z) / 4 - center.z,
        };
        const flipped = nq.x * fc.x + nq.y * fc.y + nq.z * fc.z < 0;
        const ring = flipped ? [i0, i3, i2, i1] : qi;
        tris.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!);
      }
      return mod.Manifold.ofMesh(new mod.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(positions),
        triVerts: new Uint32Array(tris),
      }));
    };

    const cut = (box: ManifoldInstance, name: string): SolidBody | null => {
      const part = m.intersect(box);
      if (part.numTri() === 0 || Math.abs(part.volume()) < 1e-9) return null;
      return fromManifold(part, name);
    };
    return {
      positive: cut(halfBox(0, nMax + m2 + 1), `${body.name} (+)`),
      negative: cut(halfBox(nMin - m2 - 1, 0), `${body.name} (−)`),
    };
  } catch {
    return { positive: null, negative: null };
  }
}

/** Deduplicate the per-face vertex soup into a shared vertex buffer. */
function toManifold(mod: ManifoldModule, body: SolidBody): ManifoldInstance | null {
  const key = (v: Vec3) => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;
  const index = new Map<string, number>();
  const positions: number[] = [];
  const indexOf = (v: Vec3): number => {
    const k = key(v);
    let i = index.get(k);
    if (i === undefined) {
      i = positions.length / 3;
      index.set(k, i);
      positions.push(v.x, v.y, v.z);
    }
    return i;
  };

  const tris: number[] = [];
  for (const face of body.faces) {
    const n = face.vertices.length;
    if (n < 3) continue;
    const ids = face.vertices.map(indexOf);
    for (let i = 1; i < n - 1; i++) {
      tris.push(ids[0]!, ids[i]!, ids[i + 1]!);
    }
  }
  if (tris.length === 0) return null;

  const mesh = new mod.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(tris),
  });
  try {
    const m = mod.Manifold.ofMesh(mesh);
    if (m.volume() < 0) m.invert();
    return m;
  } catch {
    return null; // non-manifold input → voxel fallback
  }
}

/** Rebuild a SolidBody (one triangular face per output triangle). */
function fromManifold(m: ManifoldInstance, name: string): SolidBody {
  const mesh = m.getMesh();
  const props = mesh.vertProperties;
  const tris = mesh.triVerts;

  const vertices: Vec3[] = [];
  for (let i = 0; i < mesh.numVert; i++) {
    vertices.push({ x: props[i * 3]!, y: props[i * 3 + 1]!, z: props[i * 3 + 2]! });
  }

  const faces: Face[] = [];
  const normal = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = vertices[tris[t]!]!;
    const b = vertices[tris[t + 1]!]!;
    const c = vertices[tris[t + 2]!]!;
    faces.push({ id: `face_boolm_${nextId++}`, vertices: [a, b, c], normal: normal(a, b, c) });
  }

  return { id: `body_boolm_${nextId++}`, name, vertices, faces, edges: buildEdgesFromFaces(faces) };
}
