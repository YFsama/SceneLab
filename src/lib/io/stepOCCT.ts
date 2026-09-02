/**
 * OCCT-grade curved STEP import via occt-import-js (an Emscripten/WASM build
 * of OpenCASCADE's STEP reader + mesher). The ~7 MB kernel is a lazy
 * code-split chunk: it is only fetched when a STEP file actually contains
 * curved geometry, and any failure falls back to the pure faceted parser in
 * stepImport.ts.
 */
import type { SolidBody, Vec3, Face, Edge } from '../geometry/types';
import { importSTEP } from './stepImport';
import type { OcctImportApi, OcctMeshNode } from 'occt-import-js';

// ---------------------------------------------------------------------------
// Lazy kernel loading (code-split: the chunk + wasm load on first curved use).
let occtPromise: Promise<OcctImportApi> | null = null;

function getOCCT(): Promise<OcctImportApi> {
  occtPromise ??= (async () => {
    const [mod, wasm] = await Promise.all([
      import('occt-import-js'),
      import('occt-import-js/dist/occt-import-js.wasm?url'),
    ]);
    return mod.default({ locateFile: () => wasm.default });
  })();
  return occtPromise;
}

// ---------------------------------------------------------------------------
// Pure conversion seam (unit-testable without the WASM kernel).
/** The mesh data occt-import-js returns, reduced to what conversion needs. */
export interface OcctMeshData {
  /** Flat xyz triplets (per mesh, positions are usually per-face duplicated). */
  positions: ArrayLike<number>;
  /** Triangle vertex indices into `positions`. */
  indices: ArrayLike<number>;
  /** Optional rgb 0..1 body colour from the STEP product. */
  color?: [number, number, number];
}

/** Dihedral angle above which a shared triangle edge is a feature (model) edge. */
export const FEATURE_EDGE_ANGLE_RAD = (25 * Math.PI) / 180;

let nextId = 1;
const gid = (prefix: string): string => `${prefix}_${nextId++}`;

const vertexKey = (p: ArrayLike<number>, i: number): string =>
  `${Math.round(p[i]! * 1e5)},${Math.round(p[i + 1]! * 1e5)},${Math.round(p[i + 2]! * 1e5)}`;

interface Tri {
  a: number;
  b: number;
  c: number;
  normal: Vec3;
}

/**
 * Convert one OCCT tessellation into a SceneLab SolidBody: positions are
 * welded into a shared vertex table, every triangle becomes a face (this
 * kernel is a poly-solid — same convention as STL import), and model edges
 * are the feature edges of the triangle soup: open boundaries plus segments
 * where adjacent triangles bend more than FEATURE_EDGE_ANGLE_RAD (the rims of
 * cylinders/fillets, cube corners — what a CAD user expects to see and pick).
 */
export function occtMeshToSolidBody(mesh: OcctMeshData, name: string): SolidBody {
  const positions = mesh.positions;
  const indices = mesh.indices;

  // Weld duplicated positions into a shared vertex table.
  const vertexIndex = new Map<string, number>();
  const vertices: Vec3[] = [];
  const remap: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const key = vertexKey(positions, i);
    let idx = vertexIndex.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push({ x: positions[i]!, y: positions[i + 1]!, z: positions[i + 2]! });
      vertexIndex.set(key, idx);
    }
    remap.push(idx);
  }

  const tris: Tri[] = [];
  const faces: Face[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]!]!;
    const b = remap[indices[i + 1]!]!;
    const c = remap[indices[i + 2]!]!;
    const v1 = vertices[a]!;
    const v2 = vertices[b]!;
    const v3 = vertices[c]!;
    const ux = v2.x - v1.x, uy = v2.y - v1.y, uz = v2.z - v1.z;
    const vx = v3.x - v1.x, vy = v3.y - v1.y, vz = v3.z - v1.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // degenerate sliver
    nx /= len; ny /= len; nz /= len;
    tris.push({ a, b, c, normal: { x: nx, y: ny, z: nz } });
    faces.push({
      id: gid('face_occt'),
      vertices: [v1, v2, v3],
      normal: { x: nx, y: ny, z: nz },
    });
  }

  // Edge → adjacent triangles, keyed on the welded vertex pair.
  const edgeKey = (u: number, v: number): number => (u < v ? u * 4294967296 + v : v * 4294967296 + u);
  const adjacency = new Map<number, { a: number; b: number; triIdx: number[] }>();
  for (let t = 0; t < tris.length; t++) {
    const { a, b, c } = tris[t]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = edgeKey(u, v);
      let entry = adjacency.get(key);
      if (!entry) {
        entry = { a: u, b: v, triIdx: [] };
        adjacency.set(key, entry);
      }
      entry.triIdx.push(t);
    }
  }

  const edges: Edge[] = [];
  for (const { a, b, triIdx } of adjacency.values()) {
    if (triIdx.length === 1) {
      edges.push({ id: gid('edge_occt'), start: vertices[a]!, end: vertices[b]! });
      continue;
    }
    // Feature edge: the two adjacent triangles bend sharply (or disagree —
    // non-manifold seams read as hard edges too).
    if (triIdx.length > 2) {
      edges.push({ id: gid('edge_occt'), start: vertices[a]!, end: vertices[b]! });
      continue;
    }
    const tA = triIdx[0]!;
    const tB = triIdx[1]!;
    const dot =
      tris[tA]!.normal.x * tris[tB]!.normal.x +
      tris[tA]!.normal.y * tris[tB]!.normal.y +
      tris[tA]!.normal.z * tris[tB]!.normal.z;
    if (dot < Math.cos(FEATURE_EDGE_ANGLE_RAD)) {
      edges.push({ id: gid('edge_occt'), start: vertices[a]!, end: vertices[b]! });
    }
  }

  const body: SolidBody = {
    id: gid('body_occt'),
    name,
    vertices,
    faces,
    edges,
  };
  if (mesh.color) {
    const [r, g, b] = mesh.color;
    const to255 = (v: number) => Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
    body.color = (to255(r) << 16) | (to255(g) << 8) | to255(b);
  }
  return body;
}

// ---------------------------------------------------------------------------
// STEP text heuristics: curved surfaces/edges deserve the exact kernel.
const CURVED_TOKENS = [
  'CYLINDRICAL_SURFACE',
  'CONICAL_SURFACE',
  'SPHERICAL_SURFACE',
  'TOROIDAL_SURFACE',
  'B_SPLINE_SURFACE',
  'BEZIER_SURFACE',
  'SURFACE_OF_REVOLUTION',
  'SURFACE_OF_LINEAR_EXTRUSION',
  'OFFSET_SURFACE',
  'B_SPLINE_CURVE',
  'BEZIER_CURVE',
  'CIRCLE(',
  'ELLIPSE(',
] as const;

/** True when the STEP text contains curved geometry the faceted parser chords. */
export function stepNeedsExactKernel(text: string): boolean {
  return CURVED_TOKENS.some((tok) => text.includes(tok));
}

// ---------------------------------------------------------------------------
// WASM-backed import.
/**
 * Import a STEP file with the exact OCCT kernel (curved surfaces included).
 * One SolidBody per tessellated mesh node; product names and colours are
 * carried over from the STEP structure.
 */
export async function importSTEPWithOCCT(bytes: Uint8Array, name = 'STEP Import'): Promise<SolidBody[]> {
  const occt = await getOCCT();
  const result = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.1,
    angularDeflection: 0.5,
  });
  if (!result.success) throw new Error('OCCT STEP import failed');
  const nodes = result.meshes.filter((m: OcctMeshNode) => (m.index?.array?.length ?? 0) >= 3);
  if (nodes.length === 0) throw new Error('OCCT STEP import produced no meshes');
  return nodes.map((m: OcctMeshNode, i: number) =>
    occtMeshToSolidBody(
      {
        positions: m.attributes.position.array,
        indices: m.index.array,
        color: m.color,
      },
      // Assemblies keep their part names; a single unnamed part uses the
      // file name (OCCT calls unnamed parts "(Unsaved)").
      nodes.length > 1 ? `${name} — ${m.name || i + 1}` : name,
    ),
  );
}

// ---------------------------------------------------------------------------
// Dispatcher used by the UI: exact kernel when needed, faceted fallback.
export interface STEPImportResult {
  bodies: SolidBody[];
  engine: 'occt' | 'faceted';
}

/** Test seam: replace the exact loader so unit tests skip the WASM kernel. */
let exactLoaderForTests: ((bytes: Uint8Array, name: string) => Promise<SolidBody[]>) | null = null;
export function __setExactStepLoaderForTests(
  loader: ((bytes: Uint8Array, name: string) => Promise<SolidBody[]>) | null,
): void {
  exactLoaderForTests = loader;
}

/**
 * Import a STEP file: the OCCT kernel when the text contains curved geometry,
 * the fast pure parser otherwise — and as a fallback whenever the kernel
 * cannot be loaded (offline, out of memory) or fails on the file.
 */
export async function importSTEPAuto(text: string, name: string, bytes?: Uint8Array): Promise<STEPImportResult> {
  if (stepNeedsExactKernel(text)) {
    const loader = exactLoaderForTests ?? importSTEPWithOCCT;
    try {
      const bodies = await loader(bytes ?? new TextEncoder().encode(text), name);
      if (bodies.length > 0 && bodies.some((b) => b.faces.length > 0)) {
        return { bodies, engine: 'occt' };
      }
    } catch {
      // fall through to the faceted parser
    }
  }
  return { bodies: [importSTEP(text, name)], engine: 'faceted' };
}
