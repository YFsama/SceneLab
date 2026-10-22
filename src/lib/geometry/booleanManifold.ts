/**
 * Exact boolean operations via Manifold (WASM). Voxel booleans (boolean.ts)
 * approximate with a 32³ occupancy grid; Manifold computes watertight,
 * exact-geometry results in milliseconds. The WASM module loads asynchronously,
 * so the engine is warmed up at app start (`warmUpBooleanEngine`) and the sync
 * entry points fall back to the voxel path until (and unless) it is ready.
 *
 * Beyond the two-body boolean and the planar split, this module hosts the
 * EXACT (subtractive) fillet / chamfer / shell engines: analytic cutters are
 * built from Manifold primitives and half-space boxes, and the feature is the
 * boolean difference of the body with their union. Callers (operations.ts)
 * keep their overlay implementations as the cold-engine / non-manifold-input
 * fallback.
 */
import type { SolidBody, Face, Vec3, FaceSource } from './types';
import { buildEdgesFromFaces, triangulateFace } from './brep';
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
  /** Boolean ops (instance methods in Manifold 3.x). */
  add(other: ManifoldInstance): ManifoldInstance;
  subtract(other: ManifoldInstance): ManifoldInstance;
  intersect(other: ManifoldInstance): ManifoldInstance;
  /** Affine transform, column-major 4×4 (last row ignored by Manifold). */
  transform(m: number[]): ManifoldInstance;
}
interface ManifoldModule {
  Manifold: {
    ofMesh(mesh: ManifoldMesh): ManifoldInstance;
    cube(size: [number, number, number], center?: boolean): ManifoldInstance;
    /** Cylinder along +Z centered on the origin when `center` (axis bottom→top). */
    cylinder(
      height: number,
      radiusLow: number,
      radiusHigh?: number,
      circularSegments?: number,
      center?: boolean,
    ): ManifoldInstance;
    union(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
    difference(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
    intersection(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
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

/**
 * Test seam: drop the warmed engine back to cold (the sync boolean entry
 * points take the voxel fallback again) and forget the in-flight warmup so a
 * later warmUpBooleanEngine() runs from scratch. Mirrors the
 * `__setExactStepLoaderForTests` precedent — lets tests evaluate features on
 * the cold path, then flip warm and verify the results change.
 */
export function __resetManifoldEngineForTests(): void {
  ready = null;
  modulePromise = null;
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

    const cut = (box: ManifoldInstance, name: string): SolidBody | null => {
      const part = m.intersect(box);
      if (part.numTri() === 0 || Math.abs(part.volume()) < 1e-9) return null;
      return fromManifold(part, name);
    };
    return {
      positive: cut(orientedBox(mod, plane.origin, u, v, n, u0, u1, v0, v1, 0, nMax + m2 + 1), `${body.name} (+)`),
      negative: cut(orientedBox(mod, plane.origin, u, v, n, u0, u1, v0, v1, nMin - m2 - 1, 0), `${body.name} (−)`),
    };
  } catch {
    return { positive: null, negative: null };
  }
}

// ---------------------------------------------------------------------------
// Exact fillet / chamfer / shell (audit roadmap #1+#2: subtractive features)
// ---------------------------------------------------------------------------

/** Facet count for fillet cutter cylinders: sliver-volume error ≈ 0.15%,
 *  comfortably inside the 2% volume goldens (an N-gon prism removes
 *  (1 − N·sin(2π/N)/8)·r² per 90° edge instead of (1 − π/4)·r²). */
const FILLET_CYLINDER_SEGMENTS = 96;
/** How far cutters may overshoot edge endpoints / face planes (mm). Zero by
 *  design: near-coincident (µm-apart) planes leave epsilon-artifact
 *  micro-edges where corner cutters meet, while EXACTLY coincident planes go
 *  through Manifold's coplanar handling cleanly. The chamfer wedge is the
 *  measured exception (its three-plane corners quantize to the same float32
 *  vertices when exactly coincident — 2 non-manifold edges on a full-box
 *  chamfer — so IT keeps a 1 µm standoff). */
const CUTTER_EPSILON = 0;
const CHAMFER_EPSILON = 1e-3;

interface EdgeFrame {
  edge: { id: string; start: Vec3; end: Vec3 };
  face1: Face;
  face2: Face;
  n1: Vec3;
  n2: Vec3;
}

/**
 * Edges the exact fillet/chamfer engines will treat, mirroring the overlay
 * appliers' skip conditions one-for-one: at least two adjacent faces, not a
 * coplanar flat seam, a non-degenerate in-plane tangent. Returns null (whole
 * exact attempt aborted → overlay fallback) when a selected edge is REFLEX
 * (concave): the subtractive cutters would remove material where a concave
 * fillet/chamfer must add it, and the overlay remains the honest approximation.
 */
function selectableConvexEdges(
  body: SolidBody,
  edgeIds: string[],
  needTangent: boolean,
): EdgeFrame[] | null {
  const edgeSet = new Set(edgeIds.length > 0 ? edgeIds : body.edges.map((e) => e.id));
  const out: EdgeFrame[] = [];
  const diag = bodyDiagonal(body);
  const reflexTol = 1e-6 * Math.max(1, diag);
  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) continue;
    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) continue;
    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) continue;
    const n1 = vNormalize(face1.normal);
    const n2 = vNormalize(face2.normal);
    if (vDot(n1, n2) > 1 - 1e-6) continue; // coplanar flat seam
    const edgeDir = vNormalize(vSub(edge.end, edge.start));
    if (needTangent && vLen(vCross(n1, edgeDir)) < 1e-9) continue;
    if (vLen(vAdd(n1, n2)) < 1e-9) continue; // fold-back flat-to-flat
    // Reflex (concave) edge: the OTHER face's off-edge vertices must lie in
    // this face's inner half-space for a convex dihedral. One probe vertex
    // per face (any vertex not on the edge line) suffices.
    const offEdgeVertex = (face: Face): Vec3 | null => {
      for (const v of face.vertices) {
        const r = vSub(v, edge.start);
        const along = vDot(r, edgeDir);
        if (vLen(vSub(r, vScale(edgeDir, along))) > reflexTol) return v;
      }
      return null;
    };
    const p2 = offEdgeVertex(face2);
    const p1 = offEdgeVertex(face1);
    if (!p1 || !p2) continue; // degenerate face — overlay skips complex cases too
    if (vDot(vSub(p2, edge.start), n1) > reflexTol) return null; // reflex
    if (vDot(vSub(p1, edge.start), n2) > reflexTol) return null; // reflex
    out.push({ edge, face1, face2, n1, n2 });
  }
  return out;
}

/**
 * Exact fillet: body − ⋃(per-edge sliver cutters), where each sliver cutter
 * is (the corner wedge along the edge, bounded by the faces, the arc's
 * tangent legs and the edge ends) − (the radius-r rolling-ball cylinder
 * along the axis at distance r from both faces). The cylinder's wall IS the
 * fillet surface — tangent to both faces exactly. At 3-edge corners the
 * union of prismatic slivers keeps slightly MORE than the true rolling
 * ball's ball-octant (measured −0.6% of removal on a full box) — the
 * corner-corrected golden uses the union formula, honestly.
 *
 * Watertight by construction (Manifold difference). Returns null — caller
 * falls back to the pass-30 overlay — when the engine is cold, the body is
 * not manifold-convertible, a selected edge is reflex, or the cut failed.
 */
export function filletManifold(body: SolidBody, edgeIds: string[], radius: number): SolidBody | null {
  const mod = ready;
  if (!mod) return null;
  const selected = selectableConvexEdges(body, edgeIds, true);
  if (!selected || selected.length === 0) return null;
  try {
    const m = toManifold(mod, body);
    if (!m) return null;
    const cutters: ManifoldInstance[] = [];
    for (const { edge, face1, face2, n1, n2 } of selected) {
      const dir = vNormalize(vSub(edge.end, edge.start));
      const u1 = inPlaneAway(face1, edge, dir, n1);
      const u2 = inPlaneAway(face2, edge, dir, n2);
      if (!u1 || !u2) return null; // degenerate — the overlay tries
      const cutter = edgeSliverCutter(mod, edge, n1, n2, u1, u2, radius);
      cutters.push(cutter);
    }
    const cutter = cutters.length === 1 ? cutters[0]! : mod.Manifold.union(cutters);
    const result = m.subtract(cutter);
    if (result.numTri() === 0 || Math.abs(result.volume()) < 1e-9) return null;
    return adoptBody(fromManifold(result, `${body.name} (fillet)`), body);
  } catch {
    return null;
  }
}

/** The sliver a radius-r fillet removes along one edge:
 *  cornerWedge(edge) − rollingBallCylinder(r). The wedge is bounded by the
 *  two face planes, the leg planes at the arc's tangent extent τ = r·tan(φ/2)
 *  (φ = interior dihedral; r on a 90° corner, ~10r on a cylinder side seam)
 *  and the edge endpoints; the cylinder runs along the axis at distance r
 *  from BOTH faces, so its wall is the fillet surface, tangent to each face
 *  exactly where the leg planes sit. */
function edgeSliverCutter(
  mod: ManifoldModule,
  edge: { start: Vec3; end: Vec3 },
  n1: Vec3,
  n2: Vec3,
  u1: Vec3,
  u2: Vec3,
  radius: number,
): ManifoldInstance {
  const q = edge.start;
  const dir = vNormalize(vSub(edge.end, edge.start));
  const L = vLen(vSub(edge.end, edge.start));
  const c = vDot(n1, n2);
  // Tangent-point distance along each face from the edge: r·cot(φ/2) where
  // φ is the INTERIOR dihedral (c = n1·n2 = −cos φ ⇒ cot(φ/2) = (1−c)/√(1−c²)).
  // The flipped-sign form r·tan(φ/2) coincides only at φ=90° and gouges
  // obtuse edges / ledges acute ones (independent review: 120° seam over-cut
  // 38×; a hex-prism fillet removed 41.14 vs the true 1.075 mm³).
  const tau = (radius * (1 - c)) / Math.sqrt(Math.max(1e-24, 1 - c * c)); // r·cot(φ/2)
  const E = Math.max(L, radius, tau) * 2 + 10; // half-space extent past everything local
  const half = (d: Vec3, lo: number, hi: number): ManifoldInstance => {
    const u = vNormalize(vCross(d, Math.abs(d.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
    const v = vNormalize(vCross(d, u));
    return orientedBox(mod, q, u, v, d, -E, E, -E, E, lo, hi);
  };
  const wedge = mod.Manifold.intersection([
    half(vNeg(n1), -CUTTER_EPSILON, E),        // this side of face 1
    half(vNeg(n2), -CUTTER_EPSILON, E),        // this side of face 2
    half(u1, -E, tau + CUTTER_EPSILON),        // leg on face 1
    half(u2, -E, tau + CUTTER_EPSILON),        // leg on face 2
    half(dir, -CUTTER_EPSILON, L + CUTTER_EPSILON), // along the edge only
  ]);
  // Rolling-ball axis: distance r from both faces ⇒ q − (n1+n2)·r/(1+n1·n2).
  const s = radius / (1 + c);
  const axisOrigin = vAdd(q, vScale(vNeg(vAdd(n1, n2)), s));
  const ball = edgeCylinder(mod, { start: axisOrigin, end: vAdd(axisOrigin, vScale(dir, L)) }, radius);
  return mod.Manifold.difference([wedge, ball]);
}

/** Cylinder of `radius` along the edge, its ends CUTTER_EPSILON past the
 *  endpoints, built from Manifold's +Z cylinder via a rotation frame. */
function edgeCylinder(mod: ManifoldModule, edge: { start: Vec3; end: Vec3 }, radius: number): ManifoldInstance {
  const dir = vNormalize(vSub(edge.end, edge.start));
  const len = vLen(vSub(edge.end, edge.start));
  const height = len + 2 * CUTTER_EPSILON;
  // Orthonormal frame with f = +Z target; u chosen away from the axis.
  const a = Math.abs(dir.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = vNormalize(vCross(dir, a));
  const v = vCross(dir, u);
  const mid = vScale(vAdd(edge.start, edge.end), 0.5);
  // Column-major: columns (u, v, dir, mid).
  const mat = [
    u.x, u.y, u.z, 0,
    v.x, v.y, v.z, 0,
    dir.x, dir.y, dir.z, 0,
    mid.x, mid.y, mid.z, 1,
  ];
  return mod.Manifold
    .cylinder(height, radius, radius, FILLET_CYLINDER_SEGMENTS, true)
    .transform(mat);
}

/**
 * Exact chamfer: body − ⋃(per-edge wedge cutters). Each wedge is the
 * intersection of half-spaces that carves exactly the equal-leg chamfer
 * region — the material between the edge corner and the 45°(ish) chamfer
 * plane through the legs at `distance` d in-plane on each adjacent face:
 *
 *   { the corner side of the chamfer plane } ∩ { leg1: u1·(p−q) ≤ d }
 *     ∩ { leg2: u2·(p−q) ≤ d } ∩ { inside face1's plane } ∩ { inside face2's
 *     plane } ∩ { along the edge }
 *
 * Unlike the overlay's per-edge wedge shells (whose corners over-count by
 * 8·D_w·d³), the cutters' union is EXACTLY the true chamfer removal at every
 * corner where chamfered edges meet. The face-plane and endpoint bounds keep
 * the cutter local so non-convex bodies are never clipped across gaps.
 * Returns null (→ overlay fallback) on the same conditions as filletManifold.
 */
export function chamferManifold(body: SolidBody, edgeIds: string[], distance: number): SolidBody | null {
  const mod = ready;
  if (!mod) return null;
  const selected = selectableConvexEdges(body, edgeIds, false);
  if (!selected || selected.length === 0) return null;
  try {
    const m = toManifold(mod, body);
    if (!m) return null;
    const diag = bodyDiagonal(body);
    const E = diag + 2 * distance + 10; // half-space extent, safely past the body
    const cutters: ManifoldInstance[] = [];
    for (const { edge, face1, face2, n1, n2 } of selected) {
      const q = edge.start;
      const edgeDir = vNormalize(vSub(edge.end, edge.start));
      const L = vLen(vSub(edge.end, edge.start));
      // In-plane unit directions away from the edge, into each face (same
      // orientation rule as the overlay applier: cross(edgeDir, n) signed by
      // the face's own vertices).
      const u1 = inPlaneAway(face1, edge, edgeDir, n1);
      const u2 = inPlaneAway(face2, edge, edgeDir, n2);
      if (!u1 || !u2 || vLen(vAdd(u1, u2)) < 1e-9) return null; // degenerate — overlay tries
      const nc = vNormalize(vAdd(u1, u2));
      const delta = distance * vDot(nc, u1); // chamfer plane offset along nc
      const t = (dir: Vec3, lo: number, hi: number): ManifoldInstance => {
        const u = vNormalize(vCross(dir, Math.abs(dir.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
        const v = vNormalize(vCross(dir, u));
        return orientedBox(mod, q, u, v, dir, -E, E, -E, E, lo, hi);
      };
      const boxes = [
        t(nc, -E, delta),           // the corner side of the chamfer plane
        t(u1, -E, distance),       // leg on face 1
        t(u2, -E, distance),       // leg on face 2
        t(vNeg(n1), -CHAMFER_EPSILON, E), // inside face 1's material side
        t(vNeg(n2), -CHAMFER_EPSILON, E), // inside face 2's material side
        t(edgeDir, -CHAMFER_EPSILON, L + CHAMFER_EPSILON), // along the edge only
      ];
      cutters.push(mod.Manifold.intersection(boxes));
    }
    const result = mod.Manifold.difference([m, ...cutters]);
    if (result.numTri() === 0 || Math.abs(result.volume()) < 1e-9) return null;
    return adoptBody(fromManifold(result, `${body.name} (chamfer)`), body);
  } catch {
    return null;
  }
}

/** In-plane unit direction on the face pointing away from the edge (the
 *  overlay applier's `inPlaneAway`, orientation decided by the face's vertices). */
function inPlaneAway(
  face: Face,
  edge: { start: Vec3; end: Vec3 },
  edgeDir: Vec3,
  n: Vec3,
): Vec3 | null {
  const c = vCross(edgeDir, n);
  const len = vLen(c);
  if (len < 1e-9) return null;
  const cand = vScale(c, 1 / len);
  let side = 0;
  for (const v of face.vertices) {
    side += vDot(vSub(v, edge.start), cand);
  }
  return side >= 0 ? cand : vNeg(cand);
}

/** A watertight box in the frame (origin; u, v ⟂ n), coordinates measured
 *  from `origin` along each frame axis — the half-space primitive the split,
 *  chamfer and shell cutters are built from. Every quad is wound outward
 *  geometrically (the frame may be left-handed). */
function orientedBox(
  mod: ManifoldModule,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  n: Vec3,
  u0: number, u1: number,
  v0: number, v1: number,
  w0: number, w1: number,
): ManifoldInstance {
  const corner = (a: number, b: number, c: number): Vec3 => ({
    x: origin.x + u.x * a + v.x * b + n.x * c,
    y: origin.y + u.y * a + v.y * b + n.y * c,
    z: origin.z + u.z * a + v.z * b + n.z * c,
  });
  const A = corner(u0, v0, w0), B = corner(u1, v0, w0), C = corner(u1, v1, w0), D = corner(u0, v1, w0);
  const E = corner(u0, v0, w1), F = corner(u1, v0, w1), G = corner(u1, v1, w1), H = corner(u0, v1, w1);
  const corners = [A, B, C, D, E, F, G, H];
  const positions: number[] = [];
  for (const p of corners) positions.push(p.x, p.y, p.z);
  // Shared corner indices — Manifold requires a topologically shared mesh;
  // duplicated corner positions per face would leave six disjoint patches.
  const quadIdx = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3],
    [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2],
  ];
  // Orient every quad outward geometrically — the frame may be
  // left-handed (u×v = −n), so a fixed winding table is not reliable.
  const center = corners.reduce(
    (s, p) => ({ x: s.x + p.x / 8, y: s.y + p.y / 8, z: s.z + p.z / 8 }),
    { x: 0, y: 0, z: 0 },
  );
  const tris: number[] = [];
  for (const qi of quadIdx) {
    const i0 = qi[0]!, i1 = qi[1]!, i2 = qi[2]!, i3 = qi[3]!;
    const a = corners[i0]!, b = corners[i1]!, c = corners[i2]!;
    const nq = vCross(vSub(b, a), vSub(c, a));
    const fc = {
      x: (a.x + b.x + c.x + corners[i3]!.x) / 4 - center.x,
      y: (a.y + b.y + c.y + corners[i3]!.y) / 4 - center.y,
      z: (a.z + b.z + c.z + corners[i3]!.z) / 4 - center.z,
    };
    const flipped = vDot(nq, fc) < 0;
    const ring = flipped ? [i0, i3, i2, i1] : qi;
    tris.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!);
  }
  return mod.Manifold.ofMesh(new mod.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(tris),
  }));
}

/**
 * Exact shell: body − eroded-interior (− opening prisms over the selected
 * faces). Erosion of the body inward by `thickness`:
 *
 * - CONVEX bodies (every face plane contains all vertices on its inner side —
 *   boxes, prisms, convex extrudes, i.e. what this app mostly builds): the
 *   erosion is EXACT — the intersection of every face's half-space shifted
 *   inward by t (for a convex set, eroding by a ball is the intersection of
 *   the eroded supporting half-spaces). Walls land at exactly t.
 * - Everything else: `makeInterior` supplies the interior (the caller passes
 *   the voxel EDT erosion from booleanVoxel; blocky inner walls at the grid's
 *   resolution, honest about it). May return null for "erosion empty" (walls
 *   consumed the body) — the shell is then the solid itself.
 *
 * Each selected face is opened by subtracting the prism of its own footprint
 * extruded inward to the inner wall — exactly t on the convex path,
 * `voxelOpeningDepth` (t + a couple of cells) when the interior is blocky — so
 * the hole matches the removed face and the wall's side faces are exposed.
 * Watertight by construction. Returns null — caller falls back to the pocket
 * overlay — when the engine is cold, the body is not convertible, or the
 * difference fails.
 */
export function shellManifold(
  body: SolidBody,
  faceIds: string[],
  thickness: number,
  makeInterior: () => SolidBody | null,
  voxelOpeningDepth: number,
): SolidBody | null {
  const mod = ready;
  if (!mod) return null;
  try {
    const m = toManifold(mod, body);
    if (!m) return null;

    let cavity: ManifoldInstance | null = null;
    let openingDepth = thickness; // sealed-thin fallback: a surface recess only
    if (isConvexPolyhedron(body)) {
      // Exact erosion: intersect the inward-shifted supporting half-spaces
      // {n·p ≤ d − t}, each built as a half-space box anchored at its face.
      const diag = bodyDiagonal(body);
      const E = diag + 4 * thickness + 10;
      const planes = body.faces.map((f) => {
        const n = vNormalize(f.normal);
        return { n, d: vDot(n, f.vertices[0]!) };
      });
      const faceBoxes = planes.map(({ n, d }, i) => {
        const u = vNormalize(vCross(n, Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
        const v = vNormalize(vCross(n, u));
        const p0 = body.faces[i]!.vertices[0]!;
        return orientedBox(mod, p0, u, v, n, -E, E, -E, E, -E, d - thickness - vDot(n, p0));
      });
      const eroded = mod.Manifold.intersection(faceBoxes);
      if (eroded.numTri() > 0 && Math.abs(eroded.volume()) > 1e-9) {
        cavity = eroded;
        // openingDepth stays `thickness` here: the opening prism runs to
        // EXACTLY the inner wall depth — a coincident-plane cut resolves
        // exactly in Manifold, while any µm overshoot into the cavity makes
        // the prism/cavity union degenerate.
      }
    } else {
      const erodedBody = makeInterior();
      if (erodedBody) {
        const eroded = toManifold(mod, erodedBody);
        if (eroded) cavity = eroded;
      }
      openingDepth = voxelOpeningDepth;
    }

    // The opening prisms join the cavity FIRST: the union resolves the
    // prism-wall / cavity-floor coincidences exactly inside one solid, and a
    // single difference carves shell + openings in one exact boolean.
    const openings: ManifoldInstance[] = [];
    const faceSet = new Set(faceIds);
    for (const face of body.faces) {
      if (!faceSet.has(face.id)) continue;
      const prism = facePrismManifold(mod, face, openingDepth, CUTTER_EPSILON);
      if (!prism) return null; // non-planar/odd face — let the overlay handle it
      openings.push(prism);
    }
    let cavityWithOpenings: ManifoldInstance | null = cavity;
    if (cavity && openings.length > 0) {
      cavityWithOpenings = mod.Manifold.union([cavity, ...openings]);
    } else if (!cavity && openings.length > 0) {
      cavityWithOpenings = openings.length === 1 ? openings[0]! : mod.Manifold.union(openings);
    }

    const result = cavityWithOpenings ? m.subtract(cavityWithOpenings) : m;
    if (result.numTri() === 0 || Math.abs(result.volume()) < 1e-9) return null;
    const out = adoptBody(fromManifold(result, `${body.name} (shell)`), body);
    return stripDanglingSheets(out);
  } catch {
    return null;
  }
}

/** Drop dangling sheets: faces whose EVERY edge is a boundary edge (shared
 *  with no other face). A closed solid never legitimately contains one — they
 *  are boolean epsilon-artifacts (e.g. a cutter's back-cap imprint where it
 *  exited into empty space). Removing them heals the mesh without moving any
 *  geometry (the sheets are zero-volume). */
function stripDanglingSheets(body: SolidBody): SolidBody {
  const count = new Map<string, number>();
  const key = (a: Vec3, b: Vec3) => {
    const s = (v: Vec3) => `${v.x},${v.y},${v.z}`;
    return s(a) < s(b) ? `${s(a)}|${s(b)}` : `${s(b)}|${s(a)}`;
  };
  for (const f of body.faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      const k = key(f.vertices[i]!, f.vertices[(i + 1) % f.vertices.length]!);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const faces = body.faces.filter((f) => {
    for (let i = 0; i < f.vertices.length; i++) {
      const k = key(f.vertices[i]!, f.vertices[(i + 1) % f.vertices.length]!);
      if ((count.get(k) ?? 0) > 1) return true; // shares at least one edge — keep
    }
    return false;
  });
  if (faces.length === body.faces.length) return body;
  const used = new Set<Vec3>();
  for (const f of faces) for (const v of f.vertices) used.add(v);
  return {
    ...body,
    faces,
    vertices: body.vertices.filter((v) => used.has(v)),
    edges: buildEdgesFromFaces(faces),
  };
}

/** Keep the parent body's identity/display attributes on an exact result. */
function adoptBody(result: SolidBody, parent: SolidBody): SolidBody {
  return {
    ...result,
    id: parent.id,
    name: parent.name,
    color: parent.color,
    opacity: parent.opacity,
    material: parent.material,
  };
}

/** Bounding-box diagonal — the scale for cutter extents and tolerances. */
function bodyDiagonal(body: SolidBody): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of body.vertices) {
    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

/** Is the body a convex polyhedron (every vertex inside every face's
 *  half-space)? Capped: huge meshes skip the O(F·V) check and are treated as
 *  non-convex (the voxel interior path). */
function isConvexPolyhedron(body: SolidBody): boolean {
  if (body.faces.length === 0 || body.faces.length > 512 || body.vertices.length > 4096) return false;
  const tol = 1e-6 * Math.max(1, bodyDiagonal(body));
  for (const f of body.faces) {
    const n = vNormalize(f.normal);
    const p0 = f.vertices[0]!;
    for (const v of body.vertices) {
      if (vDot(n, vSub(v, p0)) > tol) return false;
    }
  }
  return true;
}

/** Closed prism over a face's own footprint: front ring at `outset` OUTSIDE
 *  the face, back ring `depth` INSIDE along −normal. With outset 0 and depth
 *  exactly the wall thickness, both caps are coincident with the shell's own
 *  planes, which Manifold resolves exactly (measured: any µm offset instead
 *  corrupts the union). Triangulated with brep's ear-clipper (which returns
 *  the original vertex references) so concave footprints are handled; null
 *  when the face is degenerate or not planar enough to extrude. */
function facePrismManifold(
  mod: ManifoldModule,
  face: Face,
  depth: number,
  outset: number,
): ManifoldInstance | null {
  const n = vNormalize(face.normal);
  if (face.vertices.length < 3) return null;
  // Planarity guard — the prism is only honest over a (near-)planar face.
  let maxDist = 0;
  let extent = 0;
  for (const v of face.vertices) {
    maxDist = Math.max(maxDist, Math.abs(vDot(n, vSub(v, face.vertices[0]!))));
    extent = Math.max(extent, Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  }
  if (maxDist > 1e-6 * (1 + extent)) return null;

  const ring = face.vertices;
  const front = ring.map((v) => vAdd(v, vScale(n, outset)));
  const back = ring.map((v) => vSub(v, vScale(n, depth)));
  const verts = [...front, ...back];
  const m = ring.length;
  const backStart = m;
  let tris: number[] = [];
  const pushTri = (a: number, b: number, c: number) => tris.push(a, b, c);
  // Front cap: triangles inherit the ring's winding, whose normal is ≈ +n —
  // flip the (numerically) inverted ones only. brep's triangulator returns
  // the input vertex objects, so indexOf(reference) recovers the index.
  for (const [a, b, c] of triangulateFace(front)) {
    const ia = front.indexOf(a), ib = front.indexOf(b), ic = front.indexOf(c);
    if (ia < 0 || ib < 0 || ic < 0) return null;
    if (vDot(vCross(vSub(b, a), vSub(c, a)), n) >= 0) pushTri(ia, ib, ic);
    else pushTri(ia, ic, ib);
  }
  // Back cap: same ring seen from −n — every triangle flips.
  for (const [a, b, c] of triangulateFace(back)) {
    const ia = back.indexOf(a), ib = back.indexOf(b), ic = back.indexOf(c);
    if (ia < 0 || ib < 0 || ic < 0) return null;
    if (vDot(vCross(vSub(b, a), vSub(c, a)), n) >= 0) pushTri(backStart + ia, backStart + ic, backStart + ib);
    else pushTri(backStart + ia, backStart + ib, backStart + ic);
  }
  // Side quads: for a ring wound with normal +n, the outward side normal of
  // edge (i→j) is cross(edge, n), which the winding (i, back_i, back_j, j)
  // produces (its first triangle's normal is d·cross(edge, n), d = depth).
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    pushTri(i, backStart + i, backStart + j);
    pushTri(i, backStart + j, j);
  }
  const positions: number[] = [];
  for (const v of verts) positions.push(v.x, v.y, v.z);
  // Orientation fixed in JS (signed volume + winding flip) — manifold-3d
  // 3.5.1 has no instance invert() and the old call threw for any
  // inward-wound prism footprint.
  if (signedVolume6(positions, tris) < 0) tris = flipWinding(tris);
  try {
    const mesh = new mod.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(positions),
      triVerts: new Uint32Array(tris),
    });
    return mod.Manifold.ofMesh(mesh);
  } catch {
    return null;
  }
}

/** Signed volume ×6 of a triangle soup (Σ det[a,b,c]) — negative when the
 *  winding faces inward. Manifold needs outward winding; manifold-3d 3.5.1
 *  exposes NO instance invert(), so orientation is fixed here in JS by
 *  reversing every triangle before the mesh is built. */
function signedVolume6(positions: number[], tris: number[]): number {
  let sum = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const i = tris[t]! * 3, j = tris[t + 1]! * 3, k = tris[t + 2]! * 3;
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[j]!, by = positions[j + 1]!, bz = positions[j + 2]!;
    const cx = positions[k]!, cy = positions[k + 1]!, cz = positions[k + 2]!;
    sum +=
      ax * (by * cz - cy * bz) -
      bx * (ay * cz - cy * az) +
      cx * (ay * bz - by * az);
  }
  return sum;
}

/** Reverse every triangle's winding (b↔c) — the JS equivalent of the
 *  Manifold invert() this library version does not expose. */
function flipWinding(tris: number[]): number[] {
  const out = new Array<number>(tris.length);
  for (let t = 0; t < tris.length; t += 3) {
    out[t] = tris[t]!;
    out[t + 1] = tris[t + 2]!;
    out[t + 2] = tris[t + 1]!;
  }
  return out;
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

  let tris: number[] = [];
  for (const face of body.faces) {
    const n = face.vertices.length;
    if (n < 3) continue;
    // Concave-safe ear-clip (decimated bodies carry concave polygonal faces
    // a naive fan would wind inside-out — feeding Manifold self-intersecting
    // triangles is fragile even when volumes happen to cancel).
    for (const [a, b, c] of triangulateFace(face.vertices)) {
      tris.push(indexOf(a), indexOf(b), indexOf(c));
    }
  }
  if (tris.length === 0) return null;
  // Inward-wound input (e.g. pre-fix revolves, mirrored imports) is flipped
  // here — the old `m.invert()` call threw (no such method in manifold-3d
  // 3.5.1) and silently routed every such body to the voxel fallback.
  if (signedVolume6(positions, tris) < 0) tris = flipWinding(tris);

  const mesh = new mod.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(tris),
  });
  try {
    return mod.Manifold.ofMesh(mesh);
  } catch {
    return null; // non-manifold input → voxel fallback
  }
}

/**
 * Rebuild a SolidBody from a Manifold result.
 *
 * Pipeline: (1) DECIMATION — coplanar adjacent triangles are merged back into
 * polygonal faces (the audit's M item: ~half the output triangles used to be
 * fake 0°-crease pairs on flat cut faces; every downstream battery — volume,
 * manifold checks, CAM — gets half the faces to walk). (2) PROVENANCE — face
 * groups that lie on a common analytic cylinder (a full ≥300° wall of ≥12
 * vertices, e.g. a drilled hole) carry `Face.source` with the fitted
 * axis/origin/radius, the contract hole-recognition consumers tag against.
 * Both passes only ever reorganize faces: geometry (vertex positions and the
 * watertight surface) is untouched.
 */
function fromManifold(m: ManifoldInstance, name: string): SolidBody {
  const mesh = m.getMesh();
  const props = mesh.vertProperties;
  const tris = mesh.triVerts;

  const vertices: Vec3[] = [];
  for (let i = 0; i < mesh.numVert; i++) {
    vertices.push({ x: props[i * 3]!, y: props[i * 3 + 1]!, z: props[i * 3 + 2]! });
  }

  const faces: Face[] = [];
  const faceNormal = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
    const cr = vCross(vSub(b, a), vSub(c, a));
    const len = vLen(cr) || 1;
    return { x: cr.x / len, y: cr.y / len, z: cr.z / len };
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = vertices[tris[t]!]!;
    const b = vertices[tris[t + 1]!]!;
    const c = vertices[tris[t + 2]!]!;
    faces.push({ id: `face_boolm_${nextId++}`, vertices: [a, b, c], normal: faceNormal(a, b, c) });
  }

  // Weld coincident vertices: Manifold's buffer may carry duplicate positions
  // (property runs, corner retriangulations), which the coordinate-keyed
  // manifold checks and every downstream consumer read as broken topology.
  // EXACT position matches only — tangency outputs also carry legitimately
  // distinct vertices microns apart, and merging those would fuse separate
  // edges. Drops faces degenerated by the weld; the vertex buffer is rebuilt
  // again after decimation from the referenced positions.
  const weld = weldFaces(faces);
  const decimated = decimateCoplanar(weld.faces, weld.vertices);
  const finalFaces = compactVertices(decimated);
  tagCylinderSources(finalFaces.faces);

  return {
    id: `body_boolm_${nextId++}`,
    name,
    vertices: finalFaces.vertices,
    faces: finalFaces.faces,
    edges: buildEdgesFromFaces(finalFaces.faces),
  };
}

/** Replace exactly-coincident vertex objects with one shared representative. */
function weldFaces(faces: Face[]): { faces: Face[]; vertices: Vec3[] } {
  const rep = new Map<string, Vec3>();
  const weld = (v: Vec3): Vec3 => {
    const k = `${v.x},${v.y},${v.z}`;
    let r = rep.get(k);
    if (!r) { r = v; rep.set(k, r); }
    return r;
  };
  const out: Face[] = [];
  for (const f of faces) {
    const welded: Vec3[] = [];
    for (const v of f.vertices) {
      const w = weld(v);
      if (welded[welded.length - 1] !== w) welded.push(w);
    }
    if (welded.length >= 3 && welded[0] !== welded[welded.length - 1]) out.push({ ...f, vertices: welded });
  }
  const used = new Set<Vec3>();
  for (const f of out) for (const v of f.vertices) used.add(v);
  return { faces: out, vertices: Array.from(used) };
}

/** Keep only the vertices the (decimated) faces still reference — merging
 *  faces can orphan buffer entries, and isolated vertices read as damage in
 *  mesh-health checks. */
function compactVertices(faces: Face[]): { faces: Face[]; vertices: Vec3[] } {
  const used = new Set<Vec3>();
  for (const f of faces) for (const v of f.vertices) used.add(v);
  return { faces, vertices: Array.from(used) };
}

/**
 * Merge coplanar adjacent triangles into single polygonal faces. Triangles
 * belong to one merge group when they share an edge AND their normals are
 * parallel with the same orientation (a true 0° crease — Manifold emits these
 * when it re-triangulates planar cut faces). Each group becomes ONE face
 * bounded by its outer ring when that ring is a single simple loop; groups
 * that fail planarity verification or form multiple loops (annuli) keep their
 * triangles. Purely topological — no vertex moves.
 */
function decimateCoplanar(faces: Face[], vertices: Vec3[]): Face[] {
  if (faces.length < 2) return faces;

  // Vertex identity → dense index (faces reference the shared `vertices` array).
  const idOf = new Map<Vec3, number>();
  for (let i = 0; i < vertices.length; i++) idOf.set(vertices[i]!, i);

  // Edge (i<j) → adjacent face indices, via each triangle's directed ring.
  const edgeFaces = new Map<string, number[]>();
  const edgeDir = new Map<string, [number, number][]>(); // directed edges per owner face
  faces.forEach((f, fi) => {
    const ids = f.vertices.map((v) => idOf.get(v));
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i]!;
      const b = ids[(i + 1) % ids.length]!;
      if (a === undefined || b === undefined || a === b) continue;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edgeFaces.get(k) ?? [];
      list.push(fi);
      edgeFaces.set(k, list);
      const dirs = edgeDir.get(k) ?? [];
      dirs.push([a, b]);
      edgeDir.set(k, dirs);
    }
  });

  // Union-find over faces joined across coplanar shared edges.
  const parent = faces.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x] ?? x] ?? x; x = parent[x] ?? x; }
    return x;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  };
  edgeFaces.forEach((owners, k) => {
    if (owners.length !== 2) return;
    const [fa, fb] = owners;
    if (fa === undefined || fb === undefined) return;
    if (vDot(faces[fa]!.normal, faces[fb]!.normal) <= 1 - 1e-9) return; // crease, not coplanar
    // Winding sanity: the shared edge must run in opposite directions.
    const dirs = edgeDir.get(k) ?? [];
    if (dirs.length === 2 && dirs[0]![0] === dirs[1]![0]) return;
    union(fa, fb);
  });

  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  });

  const out: Face[] = [];
  for (const members of groups.values()) {
    const first = faces[members[0]!]!;
    if (members.length === 1) { out.push(first); continue; }
    // Planarity verification on the merged set — a hard backstop before any
    // face is rewritten.
    const n = first.normal;
    const p0 = first.vertices[0]!;
    let flat = true;
    for (const fi of members) {
      for (const v of faces[fi]!.vertices) {
        if (Math.abs(vDot(n, vSub(v, p0))) > 1e-6 * (1 + Math.abs(p0.x) + Math.abs(p0.y) + Math.abs(p0.z))) {
          flat = false;
          break;
        }
      }
      if (!flat) break;
    }
    if (!flat) {
      for (const fi of members) out.push(faces[fi]!);
      continue;
    }
    // Boundary = edges of the group owned by exactly one member; each such
    // edge keeps its directed orientation from that owner's winding, so the
    // boundary ring inherits the merged face's orientation.
    const memberSet = new Set(members);
    const nextOf = new Map<number, number>();
    edgeFaces.forEach((owners, k) => {
      const inside = owners.filter((o) => memberSet.has(o));
      if (inside.length !== 1) return; // interior (2) or non-manifold (>2) edge
      const ownerPos = owners.indexOf(inside[0]!);
      const d = (edgeDir.get(k) ?? [])[ownerPos];
      if (!d) return;
      nextOf.set(d[0], d[1]);
    });
    // Walk the boundary: a single closed cycle that consumes every boundary
    // edge merges; anything else (multiple loops — annuli — or tailed paths)
    // keeps its triangles.
    if (nextOf.size < 3) {
      for (const fi of members) out.push(faces[fi]!);
      continue;
    }
    const start = nextOf.keys().next().value as number;
    const ring: number[] = [];
    const seen = new Set<number>();
    let cur = start;
    let ok = true;
    for (;;) {
      if (seen.has(cur)) break; // closed a cycle — at `start` only if simple
      seen.add(cur);
      ring.push(cur);
      const nxt = nextOf.get(cur);
      if (nxt === undefined) { ok = false; break; }
      cur = nxt;
    }
    if (!ok || cur !== start || seen.size !== nextOf.size) {
      for (const fi of members) out.push(faces[fi]!);
      continue;
    }
    out.push({
      id: `face_boolm_${nextId++}`,
      vertices: ring.map((i) => vertices[i]!),
      normal: { ...first.normal },
    });
  }
  return out;
}

/** Smoothness threshold for grouping faces into one surface for analytic
 *  classification: facet steps of ≤ this dihedral angle count as one wall
 *  (the kernel's coarsest walls are 8-gons at 45°... which we deliberately
 *  still accept; fragments meeting at steeper creases never merge). */
const CYLINDER_GROUP_MAX_STEP_DEG = 45;

/** Minimum distinct vertices per section ring in the cone classifier — a
 *  ring needs enough corners for the ≥300° coverage rule to mean anything
 *  (the kernel's coarsest full walls are 8-gons). */
const CONE_MIN_RING_VERTS = 6;

/** Cone half-angle gates (radians). Below 2° a sloped wall is near-cylindrical:
 *  the pooled cylinder fit has already rejected it at 0.1 % radius tolerance,
 *  and the honest tag is none (writing a cone whose slope is noise would lie
 *  to every consumer). Above 80° the frustum is near-planar and the apex
 *  extrapolation (r→0) is numerically meaningless. */
const CONE_MIN_HALF_ANGLE = (2 * Math.PI) / 180;
const CONE_MAX_HALF_ANGLE = (80 * Math.PI) / 180;

/** Fit tolerance shared by the cone/sphere verifications: 0.1 % of the fitted
 *  scale plus float slack — the same standard the cylinder path applies to
 *  its vertices (tessellation vertices lie ON the surface; only chords
 *  deviate). */
const analyticFitTol = (scale: number): number => 1e-3 * scale + 1e-9;

/** Angular-coverage gate shared by every classifier kind: largest gap between
 *  neighbouring vertex angles around the axis must be ≤ 60° (≥300° wall). */
function coversFullRing(angles: number[]): boolean {
  if (angles.length < 4) return false;
  angles.sort((a, b) => a - b);
  let maxGap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
  for (let i = 1; i < angles.length; i++) {
    maxGap = Math.max(maxGap, angles[i]! - angles[i - 1]!);
  }
  return maxGap <= (60 * Math.PI) / 180;
}

/**
 * Kåsa least-squares circle fit of 2D points: minimize
 * Σ(x²+y² − a·x − b·y − c)². Returns the center and radius, or null when the
 * normal equations are singular / degenerate. Shared by the cylinder (pooled
 * single circle) and cone (per section ring) classifiers.
 */
function fitCircle2D(pts: Array<{ x: number; y: number }>): { cx: number; cy: number; radius: number } | null {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, szz = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    szz += z; sxz += z * p.x; syz += z * p.y;
  }
  const nPts = pts.length;
  const sol = solve3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, nPts],
    ],
    [sxz, syz, szz],
  );
  if (!sol) return null;
  const cx = sol[0]! / 2, cy = sol[1]! / 2;
  const r2 = sol[2]! + cx * cx + cy * cy;
  if (!(r2 > 1e-12)) return null;
  return { cx, cy, radius: Math.sqrt(r2) };
}

/** Minimum enclosing circle (Welzl, randomized incremental) of 2D points —
 *  the circumscribed circle of a tessellated ring. Determined by the outer
 *  points alone, so chord-interior vertices cannot bias it (a Kåsa fit
 *  averages them in and under-reports both radius and center precision). */
function minEnclosingCircle2D(pts: Array<{ x: number; y: number }>): { cx: number; cy: number; radius: number } {
  const P = pts.slice();
  // Deterministic shuffle (the algorithm is expected-linear for random order;
  // a fixed seed keeps classifier output reproducible run-to-run). Math.imul
  // keeps the multiply in exact int32 domain — plain * overflows past 2^53
  // and degrades the low bits the modulo feeds on.
  let seed = 0x2f6e2b1;
  for (let i = P.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [P[i], P[j]] = [P[j]!, P[i]!];
  }
  const dist2 = (p: { x: number; y: number }, c: { cx: number; cy: number; r: number }) => {
    const dx = p.x - c.cx, dy = p.y - c.cy;
    return dx * dx + dy * dy;
  };
  const from2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const dx = a.x - b.x, dy = a.y - b.y;
    return { cx, cy, r: Math.hypot(dx, dy) / 2 };
  };
  const from3 = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) {
      // Collinear — the widest pair carries the circle.
      const c2 = from2(a, b);
      const c3 = from2(b, c);
      const c1 = from2(a, c);
      return c1.r >= c2.r && c1.r >= c3.r ? c1 : c2.r >= c3.r ? c2 : c3;
    }
    const cx = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
    const cy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
    return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
  };
  let c = { cx: P[0]!.x, cy: P[0]!.y, r: 0 };
  for (let i = 1; i < P.length; i++) {
    if (dist2(P[i]!, c) <= c.r * c.r) continue;
    c = { cx: P[i]!.x, cy: P[i]!.y, r: 0 };
    for (let j = 0; j < i; j++) {
      if (dist2(P[j]!, c) <= c.r * c.r) continue;
      c = from2(P[i]!, P[j]!);
      for (let k = 0; k < j; k++) {
        if (dist2(P[k]!, c) <= c.r * c.r) continue;
        c = from3(P[i]!, P[j]!, P[k]!);
      }
    }
  }
  return { cx: c.cx, cy: c.cy, radius: c.r };
}

/**
 * Chord-tolerant cylinder verification: the Kåsa path above demands every
 * vertex ON the circle at 0.1%, which only holds while every vertex is a
 * ring vertex. A boolean that crosses the wall obliquely (a drilled
 * oblique axis) leaves NEW rim vertices ON the tessellated wall's facet
 * chords — legitimately up to one chord sagitta INSIDE the circumscribed
 * circle (r·(1−cos(π/n)) = 0.0053 at r 2.5 / 48 facets, twice the 0.1%
 * tolerance) and those vertices poisoned the whole fit. Recover the
 * circumscribed circle via minimum enclosing circle (pinned by the ring
 * vertices, immune to interior points), then accept every vertex that is
 * either on it or inside it by at most the local chord sagitta implied by
 * the ring's own angular step there. Returns the fitted center/radius, or
 * null when no such consistent ring exists.
 *
 * `kasa` (the failed strict fit) supplies the pre-gate reference centre: a
 * passable group's radial spread around it can never exceed the coarsest
 * legitimate chord depth (ring step ≤ 60° by the coverage gate ⇒ ≤ 13.4% of
 * the radius, plus fit bias slack) — huge non-cylindrical groups (half a
 * sphere, ~2k verts) are rejected by two passes over the points instead of
 * paying the enclosing-circle search (measured 15% of a sphere-union
 * fromManifold otherwise).
 */
function fitCircleWithChordTolerance(
  pts2: Array<{ x: number; y: number }>,
  kasa: { cx: number; cy: number; radius: number },
): { cx: number; cy: number; radius: number; angles: number[] } | null {
  let minD = Infinity, maxD = 0;
  for (const p of pts2) {
    const d = Math.hypot(p.x - kasa.cx, p.y - kasa.cy);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (maxD <= 0 || maxD - minD > 0.16 * maxD) return null; // spread dwarfs any chord sagitta
  const mec = minEnclosingCircle2D(pts2);
  const tol = analyticFitTol(mec.radius);
  // Ring vertices: on the circumscribed circle within the analytic tol.
  const ringAngles: number[] = [];
  for (const p of pts2) {
    const dx = p.x - mec.cx, dy = p.y - mec.cy;
    if (Math.abs(Math.hypot(dx, dy) - mec.radius) <= tol) ringAngles.push(Math.atan2(dy, dx));
  }
  if (ringAngles.length < 8 || !coversFullRing(ringAngles)) return null;
  ringAngles.sort((a, b) => a - b);
  // Every vertex inside by at most its local chord sagitta (see
  // chordInteriorOk; mostly formality on the "outside" branch — the MEC
  // contains every input point by construction, so a genuinely-outside
  // vertex REDEFINES the circle instead of tripping that check — adversarial
  // inflation is bounded upstream by the radial spread pre-gate (≤16% ⇒
  // ≤ ~0.9% radius inflation), and legit chord interiors sit strictly
  // inside. The strict-Kåsa radius stays the reference for the clean-input
  // fast path above.)
  if (!chordInteriorOk(pts2, mec.cx, mec.cy, mec.radius, ringAngles, tol)) return null;
  return { cx: mec.cx, cy: mec.cy, radius: mec.radius, angles: ringAngles };
}

/** Shared chord-interior acceptance for a fitted circle (cx, cy, radius):
 *  every point of `pts2` is either ON the circle (within `tol`) or inside it
 *  by at most the local chord sagitta — the chord between the enclosing pair
 *  of `ringAngles` (sorted, ≥ 2 entries) at angular width Δ dips
 *  radius·(1−cos(Δ/2)), which is the deepest a facet-chord vertex can sit
 *  while still belonging to the tessellated wall. Points outside the circle
 *  are never legitimate. Deterministic: pure arithmetic over the sorted ring
 *  angles (binary search into the same interval every run). */
function chordInteriorOk(
  pts2: Array<{ x: number; y: number }>,
  cx: number,
  cy: number,
  radius: number,
  ringAngles: number[],
  tol: number,
): boolean {
  const TWO_PI = 2 * Math.PI;
  for (const p of pts2) {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > radius + tol) return false; // outside the wall — never legitimate
    if (d >= radius - tol) continue; // on the ring
    const theta = Math.atan2(dy, dx);
    // Find the cyclic ring interval containing theta (ringAngles is sorted
    // and has ≥ 2 entries).
    let lo = 0, hi = ringAngles.length - 1;
    let width: number;
    if (theta < ringAngles[0]! || theta > ringAngles[hi]!) {
      width = ringAngles[0]! + TWO_PI - ringAngles[hi]!;
    } else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ringAngles[mid]! <= theta) lo = mid; else hi = mid;
      }
      width = ringAngles[hi]! - ringAngles[lo]!;
    }
    const sagitta = radius * (1 - Math.cos(Math.min(width, Math.PI) / 2));
    if (radius - d > sagitta + tol) return false;
  }
  return true;
}

/**
 * Tag `Face.source` on face groups that lie on a common analytic surface.
 *
 * Classification (per smooth-connected face group — adjacency through shared
 * edges whose dihedral is under CYLINDER_GROUP_MAX_STEP_DEG), tried in order:
 *
 *  1. CYLINDER (the original classifier, unchanged): normals of a cylinder
 *     wall are radial (⟂ axis), so their scatter matrix is rank 2 — the axis
 *     is its smallest-eigenvector (Jacobi eigen decomposition). A Kåsa circle
 *     fit of ALL vertices projected ⟂ axis gives origin and radius; every
 *     vertex must sit on the circle (0.1 %) and the angular coverage must be
 *     ≥ 300° (a full wall, not a fragment) with ≥ 12 distinct vertices.
 *  2. CONE: the group's vertices split at the largest axial gap into two
 *     section rings; each ring is Kåsa-fitted, the two centers define the
 *     axis, and the radii must vary linearly along it with a significant
 *     slope (2° < half angle < 80°). A single-vertex second section sitting
 *     on the axis is accepted as the apex (pointed cones). The fit is then
 *     verified against EVERY group vertex (radial distance = t·tan θ, same
 *     0.1 % tolerance) and every group facet's normal (a cone facet's normal
 *     is exactly radial·cos θ ∓ axis·sin θ with a consistent sign — this
 *     rejects sphere bands, whose two rings are trivially cospherical and
 *     would otherwise fool the linear extrapolation). Tried against both the
 *     smallest eigenvector (shallow cones, like cylinders) and the largest
 *     (steep cones: a 45° chamfer band's normals scatter MORE along the axis
 *     than around it, putting the axis on the top eigenvalue).
 *  3. SPHERE: a centered algebraic (Kåsa) sphere fit of all vertices
 *     (3×3 normal equations via solve3), verified the same way — every
 *     vertex on the sphere (0.1 %), radius bounded by the group's extent,
 *     every facet normal (anti)radial (|cos| ≥ 0.85, which rejects the
 *     cospherical two-ring bands of tall cylinder/cone walls).
 *
 * Tori are NOT classified (the two-section machinery does not fit them);
 * 'torus' tags have no producer. Only ever sets `source`; never un-tags.
 */
function tagCylinderSources(faces: Face[]): void {
  if (faces.length < 4) return;
  // Adjacency through smooth shared edges (by vertex identity).
  const idOf = new Map<Vec3, number>();
  const dense = (v: Vec3): number => {
    let i = idOf.get(v);
    if (i === undefined) { i = idOf.size; idOf.set(v, i); }
    return i;
  };
  const edgeFaces = new Map<string, number[]>();
  faces.forEach((f, fi) => {
    const ids = f.vertices.map(dense);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i]!;
      const b = ids[(i + 1) % ids.length]!;
      if (a === b) continue;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edgeFaces.get(k) ?? [];
      list.push(fi);
      edgeFaces.set(k, list);
    }
  });
  const cosSmooth = Math.cos((CYLINDER_GROUP_MAX_STEP_DEG * Math.PI) / 180);
  const parent = faces.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x] ?? x] ?? x; x = parent[x] ?? x; }
    return x;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  };
  edgeFaces.forEach((owners) => {
    if (owners.length !== 2) return;
    const [fa, fb] = owners;
    if (fa === undefined || fb === undefined) return;
    if (vDot(faces[fa]!.normal, faces[fb]!.normal) < cosSmooth) return;
    union(fa, fb);
  });

  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  });

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Gather the group's distinct vertices and area-weighted normal scatter.
    const verts: Vec3[] = [];
    const seen = new Set<Vec3>();
    let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
    for (const fi of members) {
      const f = faces[fi]!;
      for (const v of f.vertices) {
        if (!seen.has(v)) { seen.add(v); verts.push(v); }
      }
      // Weight by face area (cross-product magnitude of one triangle ≈ 2·area).
      const a = f.vertices[0]!, b = f.vertices[1]!, c = f.vertices[2]!;
      const cr = vCross(vSub(b, a), vSub(c, a));
      const w = vLen(cr);
      const n = f.normal;
      s00 += w * n.x * n.x; s01 += w * n.x * n.y; s02 += w * n.x * n.z;
      s11 += w * n.y * n.y; s12 += w * n.y * n.z; s22 += w * n.z * n.z;
    }
    if (verts.length < 12) continue;

    const eig = jacobiEigen([s00, s01, s02, s11, s12, s22]);
    if (!eig) continue;
    const [, l1, l2] = eig.values; // ascending: smallest (≈0) is the axis
    const axis = eig.vectors[0]!; // smallest eigenvalue's eigenvector = the axis

    // ---- 1. cylinder: normals ⟂ axis (rank-2 scatter), all verts one circle.
    // Gate (the original classifier's, verbatim): the middle eigenvalue must
    // be significant against the largest (normals span a plane — planar
    // patches are rejected; the smallest is never directly gated).
    if (l2 > 1e-9 && l1 >= 1e-6 * l2) {
      // 2D basis ⟂ axis.
      const ref = Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const e1 = vNormalize(vCross(axis, ref));
      const e2 = vCross(axis, e1);
      const c0 = verts[0]!;
      const pts2 = verts.map((v) => {
        const r = vSub(v, c0);
        const t = vDot(axis, r);
        const rad = vSub(r, vScale(axis, t));
        return { x: vDot(rad, e1), y: vDot(rad, e2) };
      });
      const fit = fitCircle2D(pts2);
      if (fit) {
        const { cx, cy, radius } = fit;
        // Verification 1: every vertex on the fitted circle (0.1% + float slack).
        const tol = analyticFitTol(radius);
        let onCircle = true;
        const angles: number[] = [];
        for (const p of pts2) {
          const dx = p.x - cx, dy = p.y - cy;
          if (Math.abs(Math.hypot(dx, dy) - radius) > tol) { onCircle = false; break; }
          angles.push(Math.atan2(dy, dx));
        }
        // Verification 2: angular coverage ≥ 300° (max gap ≤ 60°).
        if (onCircle && coversFullRing(angles)) {
          // Origin: on-axis at the group's mean axis coordinate.
          let tSum = 0;
          for (const v of verts) tSum += vDot(axis, vSub(v, c0));
          const origin = {
            x: c0.x + axis.x * (tSum / verts.length) + e1.x * cx + e2.x * cy,
            y: c0.y + axis.y * (tSum / verts.length) + e1.y * cx + e2.y * cy,
            z: c0.z + axis.z * (tSum / verts.length) + e1.z * cx + e2.z * cy,
          };
          const source: FaceSource = { kind: 'cylinder', origin, axis: { ...axis }, radius };
          for (const fi of members) {
            const f = faces[fi]!;
            if (!f.source) f.source = source;
          }
          continue;
        }
      }
      // Chord-tolerant retry (obliquely-cut walls carry rim vertices ON the
      // facet chords, inside the circumscribed circle — see the helper's
      // contract). Only reached when the strict fit failed, so clean walls
      // keep the bit-exact Kåsa result above.
      const chordFit = fit ? fitCircleWithChordTolerance(pts2, fit) : null;
      if (chordFit) {
        let tSum = 0;
        for (const v of verts) tSum += vDot(axis, vSub(v, c0));
        const { cx, cy, radius } = chordFit;
        const origin = {
          x: c0.x + axis.x * (tSum / verts.length) + e1.x * cx + e2.x * cy,
          y: c0.y + axis.y * (tSum / verts.length) + e1.y * cx + e2.y * cy,
          z: c0.z + axis.z * (tSum / verts.length) + e1.z * cx + e2.z * cy,
        };
        const source: FaceSource = { kind: 'cylinder', origin, axis: { ...axis }, radius };
        for (const fi of members) {
          const f = faces[fi]!;
          if (!f.source) f.source = source;
        }
        continue;
      }
    }

    // ---- 2. cone: two section rings with linearly varying radius. --------
    const cone =
      fitConeSource(faces, members, verts, axis) ??
      fitConeSource(faces, members, verts, eig.vectors[2]!);
    if (cone) {
      for (const fi of members) {
        const f = faces[fi]!;
        if (!f.source) f.source = cone;
      }
      continue;
    }

    // ---- 3. sphere: one algebraic fit through the whole group. -----------
    const sphere = fitSphereSource(faces, members, verts);
    if (sphere) {
      for (const fi of members) {
        const f = faces[fi]!;
        if (!f.source) f.source = sphere;
      }
    }
  }
}

/**
 * Fit a cone to a smooth face group along the candidate `axisDir` (unit, sign
 * arbitrary — an eigenvector of the group's normal scatter). See
 * `tagCylinderSources` for the full contract; returns the tag or null.
 */
function fitConeSource(faces: Face[], members: number[], verts: Vec3[], axisDir: Vec3): FaceSource | null {
  // ---- stage 1: rough sections along the eigen axis → section centroids. ---
  // The eigen axis can sit several degrees off the true axis (the area
  // weighting of merged quads is azimuthally anisotropic), far too sloppy for
  // the ring-planarity gate — but good enough to SEPARATE the rings (their
  // axial gap dwarfs the tilt-induced spread). A full ring's vertex centroid
  // then sits ON the true axis exactly, which refines the axis for stage 2.
  const c0 = verts[0]!;
  const splitAtLargestGap = (axis: Vec3, origin: Vec3): Vec3[][] => {
    const keyed = verts.map((v) => ({ v, t: vDot(vSub(v, origin), axis) }));
    keyed.sort((a, b) => a.t - b.t);
    if (keyed[keyed.length - 1]!.t - keyed[0]!.t <= 1e-9) return []; // no axial extent
    let cut = 0;
    let gap = 0;
    for (let i = 0; i + 1 < keyed.length; i++) {
      const g = keyed[i + 1]!.t - keyed[i]!.t;
      if (g > gap) {
        gap = g;
        cut = i;
      }
    }
    return [keyed.slice(0, cut + 1).map((p) => p.v), keyed.slice(cut + 1).map((p) => p.v)];
  };
  const centroidOf = (section: Vec3[]): Vec3 => {
    let x = 0, y = 0, z = 0;
    for (const v of section) { x += v.x; y += v.y; z += v.z; }
    const n = section.length || 1;
    return { x: x / n, y: y / n, z: z / n };
  };
  const rough = splitAtLargestGap(axisDir, c0);
  if (rough.length !== 2 || rough[0]!.length === 0 || rough[1]!.length === 0) return null;
  const centroidA = centroidOf(rough[0]!);
  const centroidB = centroidOf(rough[1]!);
  const refine = vSub(centroidB, centroidA);
  if (vLen(refine) <= 1e-9) return null;
  // Refined axis must still resemble the eigen direction (the centroid line of
  // two genuinely separate rings cannot be near-perpendicular to it). Loose on
  // purpose: the eigenvector itself can sit ~15° off the true axis (steep
  // cones' area weighting is strongly azimuthally anisotropic) — mixed-ring
  // splits are rejected later by the stage-2 ring fits, not here.
  const axisRough = vScale(refine, 1 / vLen(refine));
  if (vLen(vCross(axisDir, axisRough)) > 0.5) return null;

  // ---- stage 2: exact sections along the refined axis → Kåsa ring fits. ----
  const sections = splitAtLargestGap(axisRough, centroidA);
  if (sections.length !== 2) return null;

  // Per-section circle fit in the plane ⟂ the refined axis. A section with
  // many points is a rim ring (must be planar and concyclic); a single-point
  // section may be the apex of a pointed cone (resolved below).
  const ref = Math.abs(axisRough.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = vNormalize(vCross(axisRough, ref));
  const e2 = vCross(axisRough, e1);
  const axialT = (v: Vec3): number => vDot(vSub(v, centroidA), axisRough);
  /** Strict fit of one planar point cluster: Kåsa circle + planarity ⟂ axis
   *  (a cluster spanning several vertex rows is a cut-up wall, not a section
   *  circle) + every vertex ON the circle at 0.1%. The ring's own centroid
   *  carries its axial position (and, for a full ring, lies ON the axis) —
   *  the 2D fit only recovers the radial offsets. */
  const fitPlanarRing = (cluster: Vec3[]): { center: Vec3; radius: number } | null => {
    if (cluster.length < CONE_MIN_RING_VERTS) return null;
    const ts = cluster.map(axialT).sort((a, b) => a - b);
    const centroid = centroidOf(cluster);
    const pts2 = cluster.map((v) => {
      const r = vSub(v, centroid);
      const rad = vSub(r, vScale(axisRough, vDot(axisRough, r)));
      return { x: vDot(rad, e1), y: vDot(rad, e2) };
    });
    const fit = fitCircle2D(pts2);
    if (!fit) return null;
    if (ts[ts.length - 1]! - ts[0]! > analyticFitTol(fit.radius)) return null;
    const tol = analyticFitTol(fit.radius);
    for (const p of pts2) {
      if (Math.abs(Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.radius) > tol) return null;
    }
    return {
      center: {
        x: centroid.x + e1.x * fit.cx + e2.x * fit.cy,
        y: centroid.y + e1.y * fit.cx + e2.y * fit.cy,
        z: centroid.z + e1.z * fit.cx + e2.z * fit.cy,
      },
      radius: fit.radius,
    };
  };
  /**
   * Chord-tolerant ring fallback for a section whose strict fit failed: an
   * oblique boolean cut leaves rim vertices ON the wall facets BETWEEN the
   * ring rows, so the section can mix its true ring row with off-row arc
   * points (possibly several arcs at different heights) — and the rim
   * contamination also bends the stage-1 centroid line, so the refined
   * `axisRough` itself can sit ~10° off the true axis and the strict
   * planarity/circle gates fail even on a perfectly clean ring row. Cluster
   * the section axially at gaps above 2% of its spread (the row separations
   * dwarf any tilt-induced spread), then fit each cluster INDEPENDENTLY of
   * the sectioning axis: a least-squares plane (the cluster covariance's
   * smallest eigenvector) with the Kåsa circle fitted in that plane's own
   * basis, accepting vertices ON the circle at 0.1% as the ring and vertices
   * inside it within the local chord sagitta implied by the ring's own
   * angular step (the same rule as the cylinder chord path). Clusters are
   * tried most-vertices-first, ties by lower axial position. Clean sections
   * never get here (the strict fit above keeps its exact result).
   */
  const fitRingChordTolerant = (section: Vec3[]): { center: Vec3; radius: number } | null => {
    if (section.length < 2 * CONE_MIN_RING_VERTS) return null;
    const keyed = section.map((v) => ({ v, t: axialT(v) })).sort((a, b) => a.t - b.t);
    const spread = keyed[keyed.length - 1]!.t - keyed[0]!.t;
    if (!(spread > 0)) return null;
    const gapEps = Math.max(0.02 * spread, 1e-9);
    const clusters: Vec3[][] = [];
    let run: Vec3[] = [keyed[0]!.v];
    for (let i = 1; i < keyed.length; i++) {
      if (keyed[i]!.t - keyed[i - 1]!.t > gapEps) {
        clusters.push(run);
        run = [];
      }
      run.push(keyed[i]!.v);
    }
    clusters.push(run);
    clusters.sort((a, b) => b.length - a.length || axialT(a[0]!) - axialT(b[0]!));
    for (const cluster of clusters) {
      if (cluster.length < CONE_MIN_RING_VERTS) continue;
      // Least-squares plane of the cluster (own basis — immune to axisRough).
      const centroid = centroidOf(cluster);
      let sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
      for (const v of cluster) {
        const r = vSub(v, centroid);
        sxx += r.x * r.x; sxy += r.x * r.y; sxz += r.x * r.z;
        syy += r.y * r.y; syz += r.y * r.z; szz += r.z * r.z;
      }
      const eig = jacobiEigen([sxx, sxy, sxz, syy, syz, szz]);
      if (!eig) continue;
      const nrm = eig.vectors[0]!; // ring plane normal
      if (Math.abs(vDot(nrm, axisRough)) < 0.5) continue; // not a section plane
      const ref3 = Math.abs(nrm.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const b1 = vNormalize(vCross(nrm, ref3));
      const b2 = vCross(nrm, b1);
      const pts2 = cluster.map((v) => {
        const r = vSub(v, centroid);
        return { x: vDot(r, b1), y: vDot(r, b2) };
      });
      const fit = fitCircle2D(pts2);
      if (!fit) continue;
      const tol = analyticFitTol(fit.radius);
      let flat = true;
      for (const v of cluster) {
        if (Math.abs(vDot(vSub(v, centroid), nrm)) > tol) {
          flat = false;
          break;
        }
      }
      if (!flat) continue; // spans several rows / a cut-up wall — not a ring
      const ringAngles: number[] = [];
      for (const p of pts2) {
        const dx = p.x - fit.cx, dy = p.y - fit.cy;
        if (Math.abs(Math.hypot(dx, dy) - fit.radius) <= tol) ringAngles.push(Math.atan2(dy, dx));
      }
      if (ringAngles.length < CONE_MIN_RING_VERTS) continue;
      ringAngles.sort((a, b) => a - b);
      if (!chordInteriorOk(pts2, fit.cx, fit.cy, fit.radius, ringAngles, tol)) continue;
      return {
        center: {
          x: centroid.x + b1.x * fit.cx + b2.x * fit.cy,
          y: centroid.y + b1.y * fit.cx + b2.y * fit.cy,
          z: centroid.z + b1.z * fit.cx + b2.z * fit.cy,
        },
        radius: fit.radius,
      };
    }
    return null;
  };
  const fitRing = (section: Vec3[]): { center: Vec3; radius: number } | null =>
    fitPlanarRing(section) ?? fitRingChordTolerant(section);

  const ringA = fitRing(sections[0]!);
  const ringB = fitRing(sections[1]!);
  let P1: Vec3 | null = null;
  let r1 = 0;
  let P2: Vec3 | null = null;
  let r2 = 0;
  if (ringA && ringB) {
    P1 = ringA.center; r1 = ringA.radius;
    P2 = ringB.center; r2 = ringB.radius;
  } else if (ringA && !ringB && sections[1]!.length === 1) {
    P1 = ringA.center; r1 = ringA.radius;
    P2 = sections[1]![0]!; r2 = 0; // pointed cone apex candidate
  } else if (ringB && !ringA && sections[0]!.length === 1) {
    P1 = ringB.center; r1 = ringB.radius;
    P2 = sections[0]![0]!; r2 = 0;
  }
  if (!P1 || !P2) return null;

  // The center→center (or center→apex) line IS the axis.
  const axisVec = vSub(P2, P1);
  const L = vLen(axisVec);
  if (L <= 1e-9) return null;
  const axis = vScale(axisVec, 1 / L);

  const slope = (r2 - r1) / L; // dr/dt along the axis
  const halfAngle = Math.atan(Math.abs(slope));
  if (halfAngle < CONE_MIN_HALF_ANGLE || halfAngle > CONE_MAX_HALF_ANGLE) return null;

  // Apex: where the linear radius law r(t) = r1 + slope·t degenerates to 0.
  const apex = vAdd(P1, vScale(axis, -r1 / slope));
  // Canonical axis: pointing from the apex INTO the band (t > 0 on the band).
  let tSum = 0;
  for (const v of verts) tSum += vDot(vSub(v, apex), axis);
  const axisCanonical = tSum < 0 ? vNeg(axis) : axis;

  // Verify EVERY group vertex lies on the cone (same 0.1 % standard), on one
  // side of the apex, and that the ring wraps ≥300°. The angular basis is
  // rebuilt ⟂ the FINAL axis (the sectioning basis e1/e2 belongs to the
  // rough axis; when rim contamination tilted it, mixing the two would
  // distort the coverage gaps).
  const tanH = Math.tan(halfAngle);
  const tol = analyticFitTol(Math.max(r1, r2));
  const refF = Math.abs(axisCanonical.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const f1 = vNormalize(vCross(axisCanonical, refF));
  const f2 = vCross(axisCanonical, f1);
  const angles: number[] = [];
  for (const v of verts) {
    const d = vSub(v, apex);
    const t = vDot(d, axisCanonical);
    const radial = vSub(d, vScale(axisCanonical, t));
    const rd = vLen(radial);
    if (t < -tol) return null; // band straddles the apex — not a cone band
    if (Math.abs(rd - t * tanH) > tol) return null;
    if (rd > tol) angles.push(Math.atan2(vDot(radial, f2), vDot(radial, f1)));
  }
  if (!coversFullRing(angles)) return null;

  // Facet normals: a cone facet's normal is exactly radial·cos θ ∓ axis·sin θ,
  // so |n·axis| ≈ sin θ with ONE sign across the group. Sphere bands (whose
  // two rings are always cospherical) fail here, as do tori and freeforms.
  // Area-weighted: an oblique cut leaves a few tiny retriangulation slivers
  // at the rim whose vertices all lie on the cone but whose plane bridges to
  // the cutter wall — those are not cone tangents, but at <1% of the group
  // area they are not a sphere signature either; a disguised band violates
  // on ~100% of the area and stays rejected.
  const sinH = Math.sin(halfAngle);
  const refAxial = vDot(faces[members[0]!]!.normal, axisCanonical);
  if (refAxial === 0) return null;
  let weight = 0;
  let violating = 0;
  for (const fi of members) {
    const f = faces[fi]!;
    const a = vDot(f.normal, axisCanonical);
    const w = vLen(vCross(vSub(f.vertices[1]!, f.vertices[0]!), vSub(f.vertices[2]!, f.vertices[0]!)));
    weight += w;
    if (a * refAxial <= 0 || Math.abs(Math.abs(a) - sinH) > 0.05) violating += w;
  }
  // The 5% area budget is deliberately generous: the real contamination is
  // boolean dust (probe-measured ~1e-12 of the area — a couple of sliver
  // facets at a drill rim whose normals are pure transition garbage), which
  // an all-or-nothing guard would reject whole legitimate groups over. A
  // systematically disguised band violates on ~100% of the area and stays
  // rejected; no real geometry has been found that slips through under 5%.
  if (weight <= 0 || violating > 0.05 * weight) return null;

  return { kind: 'cone', apex, axis: axisCanonical, halfAngle };
}

/**
 * Fit a sphere to a smooth face group: centered algebraic (Kåsa) fit —
 * minimize Σ(|p|² − u·p − w)² over centered coordinates p, whose normal
 * equations decouple to a 3×3 system (reusing solve3) with
 * R² = mean|p|² + |u|²/4. Verified like the other kinds: every vertex on the
 * sphere (0.1 %), radius bounded by the group's extent (≤ 20× — a planar
 * group algebraically fits a near-infinite-radius "sphere", where the
 * relative tolerance becomes vacuous), and every facet normal (anti)radial
 * (|cos| ≥ 0.85 — a true sphere facet's normal is ±(v−center)/R). The normal
 * gate also rejects the cospherical two-ring bands of TALL cylinder/cone
 * walls (their facet normals make a constant angle arctan(L/2r) with the
 * radial); very SHORT bands (L ≲ 0.55·r) can still alias as spheres — a
 * documented conservative limit, geometrically exact through every vertex.
 * Returns the tag or null.
 */
function fitSphereSource(faces: Face[], members: number[], verts: Vec3[]): FaceSource | null {
  const n = verts.length;
  const centroid = verts.reduce((s, v) => ({ x: s.x + v.x / n, y: s.y + v.y / n, z: s.z + v.z / n }), { x: 0, y: 0, z: 0 });
  let sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
  let mx = 0, my = 0, mz = 0, sz2 = 0;
  for (const v of verts) {
    const px = v.x - centroid.x, py = v.y - centroid.y, pz = v.z - centroid.z;
    const z2 = px * px + py * py + pz * pz;
    sxx += px * px; sxy += px * py; sxz += px * pz;
    syy += py * py; syz += py * pz; szz += pz * pz;
    mx += z2 * px; my += z2 * py; mz += z2 * pz; sz2 += z2;
  }
  const u = solve3(
    [
      [sxx, sxy, sxz],
      [sxy, syy, syz],
      [sxz, syz, szz],
    ],
    [mx, my, mz],
  );
  if (!u) return null; // singular — coplanar rings leave the sphere undefined
  const center = vAdd(centroid, vScale({ x: u[0]!, y: u[1]!, z: u[2]! }, 0.5));
  const r2 = sz2 / n + (u[0]! * u[0]! + u[1]! * u[1]! + u[2]! * u[2]!) / 4;
  if (!(r2 > 1e-12)) return null;
  const radius = Math.sqrt(r2);
  // Degenerate-fit guard: a (near-)planar group algebraically fits a sphere
  // of near-infinite radius — a plane IS that sphere's limit — and the 0.1 %
  // tolerance scales with R, so the on-sphere check becomes vacuous (measured:
  // a drilled box's flat cap fit R = 3.4e14). A genuine sphere group's
  // radius is on the order of its own extent E (a full sphere has E = R; even
  // a 10° cap only reaches R ≈ 6E), so anything beyond 20E is not a sphere
  // this classifier can vouch for.
  let extent = 0;
  for (const v of verts) extent = Math.max(extent, vLen(vSub(v, centroid)));
  if (radius > 20 * extent) return null;
  const tol = analyticFitTol(radius);
  let taggedRadius = radius;
  let verified = true;
  for (const v of verts) {
    if (Math.abs(vLen(vSub(v, center)) - radius) > tol) {
      verified = false;
      break;
    }
  }
  if (!verified) {
    /**
     * Chord-tolerant retry for a group whose strict equidistance gate
     * failed: a boolean that slices the sphere (a box cut, an oblique
     * drill) leaves rim vertices ON the tessellation's facet CHORD planes —
     * strictly inside the true sphere by up to one facet sagitta — and a
     * plain Kåsa fit averages them in. Mirror the cylinder path's recovery:
     * (1) a radial-spread pre-gate rejects groups no chord interpretation
     * could explain, (2) the reference radius is the CIRCUMSCRIBED distance
     * from the fitted centre (pinned by the on-sphere ring vertices, immune
     * to chord-interior points — the 3-D sibling of the minimum enclosing
     * circle), and (3) each vertex is accepted either ON that sphere within
     * 0.1% or inside it by at most the chord sagitta of the group's own
     * coarsest member face (r·(1−cos(Δ/2)) with Δ the face's angular
     * diameter about the centre — no facet vertex can sit deeper than its
     * own facet's chord plane). Deterministic: pure maxima over the fixed
     * face list. Clean spheres never get here (the strict fit above keeps
     * its exact result).
     */
    let minD = Infinity;
    let maxD = 0;
    for (const v of verts) {
      const d = vLen(vSub(v, center));
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    if (maxD > 0 && maxD - minD <= 0.16 * maxD) {
      let rRef = 0;
      for (const v of verts) rRef = Math.max(rRef, vLen(vSub(v, center)));
      const tolRef = analyticFitTol(rRef);
      // Group-wide chord allowance: the deepest sagitta among the member
      // faces (their angular diameter about the centre). Every legitimate
      // chord-interior vertex lies on the chord plane of a facet no larger
      // than the group's own coarsest one — the honest bound this mesh can
      // vouch for. (Per-vertex star bounds are useless here: the boolean's
      // re-triangulation fans the cut rim into small triangles whose
      // diameter says nothing about the original facet the rim bisected.)
      const dirOf = new Map<Vec3, Vec3>();
      for (const v of verts) {
        const d = vSub(v, center);
        const len = vLen(d);
        dirOf.set(v, len > 1e-12 ? vScale(d, 1 / len) : { x: 0, y: 0, z: 0 });
      }
      let diam = 0;
      for (const fi of members) {
        const vs = faces[fi]!.vertices;
        for (let i = 0; i < vs.length; i++) {
          for (let j = i + 1; j < vs.length; j++) {
            diam = Math.max(
              diam,
              Math.acos(Math.max(-1, Math.min(1, vDot(dirOf.get(vs[i]!)!, dirOf.get(vs[j]!)!)))),
            );
          }
        }
      }
      const allow = rRef * (1 - Math.cos(Math.min(diam, Math.PI) / 2));
      const limit = Math.max(tolRef, allow);
      verified = true;
      for (const v of verts) {
        if (Math.abs(vLen(vSub(v, center)) - rRef) > limit) {
          verified = false;
          break;
        }
      }
      if (verified) taggedRadius = rRef;
    }
  }
  if (!verified) return null;
  for (const fi of members) {
    const f = faces[fi]!;
    const radial = vSub(f.vertices[0]!, center);
    const len = vLen(radial);
    if (len < 1e-12) return null;
    if (Math.abs(vDot(f.normal, vScale(radial, 1 / len))) < 0.85) return null;
  }
  return { kind: 'sphere', center, radius: taggedRadius };
}

/** Eigen decomposition of a symmetric 3×3 matrix (cyclic Jacobi rotations).
 *  `m` = [m00, m01, m02, m11, m12, m22]. Returns eigenvalues ascending with
 *  their eigenvectors (columns of V), or null if it failed to converge. */
function jacobiEigen(m: number[]): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } | null {
  const a = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!]; // 00 01 02 11 12 22
  const idx = (i: number, j: number): number => {
    if (i > j) [i, j] = [j, i];
    return i === 0 && j === 0 ? 0 : i === 0 && j === 1 ? 1 : i === 0 && j === 2 ? 2
      : i === 1 && j === 1 ? 3 : i === 1 && j === 2 ? 4 : 5;
  };
  const at = (i: number, j: number): number => a[idx(i, j)]!;
  // V stored column-major 3×3: v[col*3 + row].
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pairs = [[0, 1], [0, 2], [1, 2]] as const;
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = Math.abs(at(0, 1)) + Math.abs(at(0, 2)) + Math.abs(at(1, 2));
    if (off <= 1e-14 * (Math.abs(at(0, 0)) + Math.abs(at(1, 1)) + Math.abs(at(2, 2)) + 1e-300)) break;
    if (sweep === 29) return null;
    for (const [p, q] of pairs) {
      const apq = at(p, q);
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (at(q, q) - at(p, p)) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.hypot(1, theta));
      const c = 1 / Math.hypot(1, t);
      const s = t * c;
      // A ← Jᵀ A J for the Givens rotation in the (p,q) plane, applied as the
      // single combined SYMMETRIC update: A·J alone is not symmetric, so the
      // packed storage's shared (p,q) cell cannot carry rows and columns
      // separately (the old sequential in-place form corrupted it mid-loop —
      // near-degenerate eigenvalue pairs, e.g. a cone's scatter with one axis
      // eigenvalue against a perpendicular double, never converged and the
      // decomposition returned null).
      {
        const app = at(p, p), aqq = at(q, q), apq0 = at(p, q);
        for (let k = 0; k < 3; k++) {
          if (k === p || k === q) continue;
          const akp = at(k, p), akq = at(k, q);
          a[idx(k, p)] = c * akp - s * akq;
          a[idx(k, q)] = s * akp + c * akq;
        }
        a[idx(p, p)] = c * c * app - 2 * s * c * apq0 + s * s * aqq;
        a[idx(q, q)] = s * s * app + 2 * s * c * apq0 + c * c * aqq;
        a[idx(p, q)] = (c * c - s * s) * apq0 + s * c * (app - aqq);
      }
      // V ← V J (accumulate the rotation into the eigenvector columns).
      for (let r = 0; r < 3; r++) {
        const vp = v[p * 3 + r]!, vq = v[q * 3 + r]!;
        v[p * 3 + r] = c * vp - s * vq;
        v[q * 3 + r] = s * vp + c * vq;
      }
    }
  }
  const entries: [number, Vec3][] = [
    [a[0]!, { x: v[0]!, y: v[1]!, z: v[2]! }],
    [a[3]!, { x: v[3]!, y: v[4]!, z: v[5]! }],
    [a[5]!, { x: v[6]!, y: v[7]!, z: v[8]! }],
  ];
  entries.sort((x, y) => x[0] - y[0]);
  const vectors = [
    vNormalizeRaw(entries[0]![1]),
    vNormalizeRaw(entries[1]![1]),
    vNormalizeRaw(entries[2]![1]),
  ] as [Vec3, Vec3, Vec3];
  return { values: [entries[0]![0], entries[1]![0], entries[2]![0]], vectors };
}

/** Solve a 3×3 linear system (Gaussian elimination, partial pivoting). */
function solve3(A: number[][], rhs: number[]): number[] | null {
  const M = [
    [A[0]![0]!, A[0]![1]!, A[0]![2]!, rhs[0]!],
    [A[1]![0]!, A[1]![1]!, A[1]![2]!, rhs[1]!],
    [A[2]![0]!, A[2]![1]!, A[2]![2]!, rhs[2]!],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c < 4; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return [M[0]![3]! / M[0]![0]!, M[1]![3]! / M[1]![1]!, M[2]![3]! / M[2]![2]!];
}

// --- Small vector helpers (local, allocation-light) ---

function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function vCross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function vLen(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
function vNeg(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}
function vNormalizeRaw(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  if (l < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
function vNormalize(a: Vec3): Vec3 {
  return vNormalizeRaw(a);
}

/** Vertex-ring edge membership (same matching as the operations appliers). */
function faceContainsEdge(face: Face, edge: { start: Vec3; end: Vec3 }): boolean {
  const eq = (a: Vec3, b: Vec3) =>
    Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
  for (let i = 0; i < face.vertices.length; i++) {
    const a = face.vertices[i]!;
    const b = face.vertices[(i + 1) % face.vertices.length]!;
    if ((eq(a, edge.start) && eq(b, edge.end)) || (eq(a, edge.end) && eq(b, edge.start))) return true;
  }
  return false;
}
