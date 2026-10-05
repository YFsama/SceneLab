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
  invert(): ManifoldInstance;
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
  const tris: number[] = [];
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
  try {
    const mesh = new mod.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(positions),
      triVerts: new Uint32Array(tris),
    });
    const prism = mod.Manifold.ofMesh(mesh);
    if (prism.volume() < 0) prism.invert();
    return prism;
  } catch {
    return null;
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
    // Concave-safe ear-clip (decimated bodies carry concave polygonal faces
    // a naive fan would wind inside-out — feeding Manifold self-intersecting
    // triangles is fragile even when volumes happen to cancel).
    for (const [a, b, c] of triangulateFace(face.vertices)) {
      tris.push(indexOf(a), indexOf(b), indexOf(c));
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

/** Smoothness threshold for grouping faces into one surface for cylinder
 *  classification: facet steps of ≤ this dihedral angle count as one wall
 *  (the kernel's coarsest walls are 8-gons at 45°... which we deliberately
 *  still accept; fragments meeting at steeper creases never merge). */
const CYLINDER_GROUP_MAX_STEP_DEG = 45;

/**
 * Tag `Face.source` on face groups that lie on a common analytic cylinder.
 *
 * Classification (per smooth-connected face group — adjacency through shared
 * edges whose dihedral is under CYLINDER_GROUP_MAX_STEP_DEG):
 *  1. axis: normals of a cylinder wall are radial (⟂ axis), so their scatter
 *     matrix is rank 2 — the axis is its smallest-eigenvector (symmetric 3×3
 *     eigen decomposition by Jacobi rotations). Rank sanity is enforced
 *     (planar patches and spheres are rejected here).
 *  2. circle: Kåsa least-squares circle fit of the vertices projected ⟂ axis
 *     gives origin (on-axis) and radius.
 *  3. verification: EVERY group vertex within 0.1% of the fitted radius,
 *     angular coverage ≥ 300° around the axis (a full wall, not a fragment),
 *     ≥ 12 distinct vertices.
 * Only then is source set (on every face of the group). Never un-tags.
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
    // The normals must span a plane: the middle eigenvalue sizeable against
    // the top (the smallest ≈ 0 is exactly the cylinder signature).
    if (!(l2 > 1e-9) || l1 < 1e-6 * l2) continue;

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
    // Kåsa circle fit: minimize Σ(x²+y² − a·x − b·y − c)².
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, szz = 0, sxz = 0, syz = 0;
    for (const p of pts2) {
      const z = p.x * p.x + p.y * p.y;
      sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
      szz += z; sxz += z * p.x; syz += z * p.y;
    }
    const nPts = pts2.length;
    const A = [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, nPts],
    ];
    const rhs = [sxz, syz, szz];
    const sol = solve3(A, rhs);
    if (!sol) continue;
    const cx = sol[0]! / 2, cy = sol[1]! / 2;
    const r2 = sol[2]! + cx * cx + cy * cy;
    if (!(r2 > 1e-12)) continue;
    const radius = Math.sqrt(r2);
    // Verification 1: every vertex on the fitted circle (0.1% + float slack).
    const tol = 1e-3 * radius + 1e-9;
    let onCircle = true;
    const angles: number[] = [];
    for (const p of pts2) {
      const dx = p.x - cx, dy = p.y - cy;
      if (Math.abs(Math.hypot(dx, dy) - radius) > tol) { onCircle = false; break; }
      angles.push(Math.atan2(dy, dx));
    }
    if (!onCircle) continue;
    // Verification 2: angular coverage ≥ 300° (max gap ≤ 60°).
    angles.sort((a, b) => a - b);
    let maxGap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
    for (let i = 1; i < angles.length; i++) {
      maxGap = Math.max(maxGap, angles[i]! - angles[i - 1]!);
    }
    if (maxGap > (60 * Math.PI) / 180) continue;

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
  }
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
      // A ← Jᵀ A J for the Givens rotation in the (p,q) plane.
      for (let k = 0; k < 3; k++) {
        const kp = at(k, p), kq = at(k, q);
        const np = c * kp - s * kq, nq = s * kp + c * kq;
        a[idx(k, p)] = np; a[idx(k, q)] = nq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = at(p, k), qk = at(q, k);
        const np = c * pk - s * qk, nq = s * pk + c * qk;
        a[idx(p, k)] = np; a[idx(q, k)] = nq;
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
