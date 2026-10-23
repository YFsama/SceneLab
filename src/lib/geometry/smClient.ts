// Typed client for the SMLib native service (Rust side under src-tauri/). The
// kernel offers exact-primitive construction, exact booleans and tessellation
// with per-face analytic provenance (FaceSource); this module is the frontend's
// ONLY seam for those Tauri commands. v1 is a pure lib surface — no store, UI
// or boolean-dispatch wiring yet — and it must be safe to import anywhere:
// nothing here throws to callers. Every entry point returns a structured
// result ({ ok: false, reason, error } — the same shape discipline as the
// backend's { ok: false, error }), and the convenience wrappers collapse that
// to `null` for one-line call sites.
//
// Transport: the project routes ALL Tauri calls through `callNative`
// (lib/runtime.ts), which lazy-imports @tauri-apps/api so browser builds never
// pull the Tauri runtime and REJECTS outside the Tauri shell. jsdom (vitest)
// and the plain-browser dev build therefore degrade to "unavailable" by
// construction — the rejection is caught and cached, never surfaced as an
// exception. Tests swap the transport via `__setSmInvokerForTests` (the
// `__resetManifoldEngineForTests` / `__setExactStepLoaderForTests` seam
// precedent) instead of mocking @tauri-apps modules.
import type { Face, FaceSource, SolidBody, Vec3 } from './types';
import { buildEdgesFromFaces, DEFAULT_CHORD_TOLERANCE } from './brep';
import { callNative } from '../runtime';

// ---------------------------------------------------------------------------
// IPC contract — mirrors the Rust serde (camelCase) shapes 1:1. The wire data
// is untrusted JSON at runtime regardless of these types; every boundary
// below re-validates defensively.
// ---------------------------------------------------------------------------

export type SmPrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';
export type SmBooleanOp = 'union' | 'difference' | 'intersect';
/** kind-specific dims: box size:[x,y,z]; cylinder radius,height; sphere radius;
 *  cone bottomRadius, topRadius (0 = pointed), height; torus major/minorRadius.
 *  Every kind also accepts an optional center:[x,y,z] anchor (box/sphere/torus
 *  center it symmetrically; cylinder/cone place the base circle there; absent
 *  = origin). */
export type SmPrimitiveParams = Record<string, number | number[]>;

export interface SmTessellation {
  chordToleranceMm?: number;
  angleToleranceDeg?: number;
  maxEdgeLengthMm?: number;
}

export interface SmPrimitiveReq {
  kind: SmPrimitiveKind;
  params: SmPrimitiveParams;
  tessellation?: SmTessellation;
}

export interface SmBooleanReq {
  a: SmPrimitiveReq;
  b: SmPrimitiveReq;
  op: SmBooleanOp;
  tessellation?: SmTessellation;
}

export interface SmStatus {
  available: boolean;
  version?: string;
  error?: string;
}

/** Wire form of a tessellated body: an INDEXED mesh (faces reference the
 *  vertex table by index). SolidBody stores expanded Vec3 loops instead, which
 *  is exactly what the conversion below bridges. Coordinates are Y-up;
 *  box/sphere/torus sit at the origin, cylinder/cone have their base on y=0. */
export interface SmBody {
  vertices: [number, number, number][];
  faces: {
    vertices: number[];
    normal: [number, number, number];
    source?: FaceSource;
  }[];
}

export type SmBodyResult =
  | { ok: true; body: SmBody; brepVolumeMm3: number }
  | { ok: false; error: string };

/** Why an operation failed, so callers can distinguish "fall back to the JS
 *  path" (unavailable) from "show the kernel's error" (backend). */
export type SmFailureReason =
  | 'unavailable' // status gate: no usable kernel in this session
  | 'bad-request' // client-side request validation failed before any invoke
  | 'backend' // Rust answered { ok: false, error } (kernel/parameter error)
  | 'bad-response' // invoke resolved with a malformed envelope
  | 'conversion' // SmBody failed mesh validation on the way to SolidBody
  | 'invoke'; // transport rejection (command missing, IPC failure, ...)

export type SmOpResult =
  | { ok: true; body: SolidBody; brepVolumeMm3: number }
  | { ok: false; reason: SmFailureReason; error: string };

/** Signature of `callNative`-style transports (mockable seam for tests). */
export type SmInvoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Transport + availability cache
// ---------------------------------------------------------------------------

/** Test seam — production is always `callNative`. */
let invokerOverride: SmInvoker | null = null;

async function invokeSm(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (invokerOverride) return invokerOverride(cmd, args);
  return callNative(cmd, args);
}

/**
 * Cached sm_status answer. The PROMISE is cached (not just the value) so
 * concurrent first callers share one round-trip. The snapshot is what the sync
 * `isSmAvailable()` reads; a session that never asked (or asked and got
 * available:false — including the not-in-Tauri rejection) reports false.
 */
let statusPromise: Promise<SmStatus> | null = null;
let statusSnapshot: SmStatus | null = null;

function parseStatusPayload(raw: unknown): SmStatus {
  if (!raw || typeof raw !== 'object') {
    return { available: false, error: 'malformed sm_status response' };
  }
  const r = raw as { available?: unknown; version?: unknown; error?: unknown };
  if (r.available === true) {
    return typeof r.version === 'string' ? { available: true, version: r.version } : { available: true };
  }
  return {
    available: false,
    error: typeof r.error === 'string' && r.error ? r.error : 'SMLib kernel not available',
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Kernel availability; the first call is answered from cache ever after. */
export function smStatus(): Promise<SmStatus> {
  if (!statusPromise) {
    // Never rejects: outside Tauri callNative rejects ("Cannot call native
    // command ... outside Tauri") and a missing/failed Rust command rejects
    // too — both are just "unavailable" for this session, cached like any
    // other answer so the failure costs exactly one attempt.
    statusPromise = invokeSm('sm_status')
      .then(parseStatusPayload)
      .catch((e: unknown): SmStatus => ({ available: false, error: messageOf(e) }))
      .then((s) => {
        statusSnapshot = s;
        return s;
      });
  }
  return statusPromise;
}

/** Synchronous availability, valid only after a (cached) smStatus() resolved. */
export function isSmAvailable(): boolean {
  return statusSnapshot?.available === true;
}

// ---------------------------------------------------------------------------
// SmBody → SolidBody conversion (pure, defensive)
// ---------------------------------------------------------------------------

let nextId = 1;

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A wire Vec3. FaceSource fields are specified as "same names, same meaning"
 * as the TS FaceSource — i.e. {x,y,z} objects — while the SmBody envelope
 * spells its vertices/normals as [x,y,z] triples; the reader accepts both so
 * either serialization choice on the Rust side integrates unchanged.
 */
function finiteVec3(v: unknown): Vec3 | null {
  let x: unknown;
  let y: unknown;
  let z: unknown;
  if (Array.isArray(v)) {
    if (v.length !== 3) return null;
    x = v[0];
    y = v[1];
    z = v[2];
  } else if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    x = r.x;
    y = r.y;
    z = r.z;
  } else {
    return null;
  }
  if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) return null;
  return { x, y, z };
}

/** Unit-length copy of `v`, or null for zero/non-finite/overflowing vectors. */
function unitVec3(v: Vec3): Vec3 | null {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || !(len > 1e-12)) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Validate a wire-form face normal ([x,y,z] triple) into a unit Vec3. */
function validUnitNormal(n: unknown): Vec3 | null {
  if (!Array.isArray(n) || n.length !== 3) return null;
  const v = finiteVec3({ x: n[0], y: n[1], z: n[2] });
  return v ? unitVec3(v) : null;
}

/**
 * Validate one face `source` tag off the wire. Same semantics as the load-side
 * sanitizeFaceSource in io/studio3d.ts (which is module-private): per kind,
 * every Vec3 field finite, radii positive, cone halfAngle inside (0, π/2),
 * torus minor ≤ major, axis non-zero — plus one strengthening step natural
 * here: directions (axes, plane normals) are NORMALIZED to unit length on the
 * way in, since the Rust side already sends unit axes and consumers (STEP
 * export, hole recognition) assume them. Anything invalid — including unknown
 * kinds from a newer backend — drops the TAG and keeps the geometry:
 * provenance is an optimization, never a load-blocker.
 */
function sanitizeSmSource(raw: unknown): FaceSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case 'plane': {
      const point = finiteVec3(s.point);
      const normal = finiteVec3(s.normal);
      const n = normal && unitVec3(normal);
      return point && n ? { kind: 'plane', point, normal: n } : null;
    }
    case 'cylinder': {
      const origin = finiteVec3(s.origin);
      const axis = finiteVec3(s.axis);
      const a = axis && unitVec3(axis);
      return origin && a && isFiniteNum(s.radius) && s.radius > 0
        ? { kind: 'cylinder', origin, axis: a, radius: s.radius }
        : null;
    }
    case 'cone': {
      const apex = finiteVec3(s.apex);
      const axis = finiteVec3(s.axis);
      const a = axis && unitVec3(axis);
      return apex && a && isFiniteNum(s.halfAngle) && s.halfAngle > 0 && s.halfAngle < Math.PI / 2
        ? { kind: 'cone', apex, axis: a, halfAngle: s.halfAngle }
        : null;
    }
    case 'sphere': {
      const center = finiteVec3(s.center);
      return center && isFiniteNum(s.radius) && s.radius > 0
        ? { kind: 'sphere', center, radius: s.radius }
        : null;
    }
    case 'torus': {
      const center = finiteVec3(s.center);
      const axis = finiteVec3(s.axis);
      const a = axis && unitVec3(axis);
      const major = isFiniteNum(s.majorRadius) ? s.majorRadius : null;
      const minor = isFiniteNum(s.minorRadius) ? s.minorRadius : null;
      return center && a && major !== null && minor !== null &&
          major > 0 && minor > 0 && minor <= major
        ? { kind: 'torus', center, axis: a, majorRadius: major, minorRadius: minor }
        : null;
    }
    default:
      return null; // unknown kind — newer backend / hand-edited payload
  }
}

/** Newell normal of a vertex loop, normalized; null for a degenerate loop. */
function newellUnitNormal(loop: Vec3[]): Vec3 | null {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  return unitVec3({ x: nx, y: ny, z: nz });
}

/**
 * Convert the kernel's indexed mesh into the app's polygon-soup SolidBody:
 * expand each face's index ring into a shared-reference Vec3 loop (the
 * convention used by every brep.ts primitive and booleanManifold's output),
 * reuse the kernel normal when it is finite and non-zero (normalized on the
 * way in) and otherwise re-derive it from the loop's Newell normal, and build
 * unique edges with the shared buildEdgesFromFaces.
 *
 * Rejection policy — bad data returns null (the caller reports
 * reason:'conversion'; the mesh cannot be trusted):
 *   - vertex table entry that is not a [x,y,z] triple of finite numbers
 *   - face record that is not an object / has no index array
 *   - a face index that is not a safe integer in [0, vertexCount)
 *   - empty vertex table, or nothing left after dropping degenerate faces
 * Silently DROPPED (geometry kept): faces with <3 indices (zero-area slivers),
 * faces whose normal cannot be determined at all, and invalid `source` tags.
 */
export function smBodyToSolidBody(sm: SmBody, name: string): SolidBody | null {
  const raw = sm as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const { vertices: rawVerts, faces: rawFaces } = raw as { vertices?: unknown; faces?: unknown };
  if (!Array.isArray(rawVerts) || rawVerts.length === 0) return null;
  if (!Array.isArray(rawFaces)) return null;

  const vertices: Vec3[] = [];
  for (const t of rawVerts) {
    if (!Array.isArray(t) || t.length !== 3) return null;
    const [x, y, z] = t as [unknown, unknown, unknown];
    if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) return null;
    vertices.push({ x, y, z });
  }

  const faces: Face[] = [];
  for (const f of rawFaces) {
    if (!f || typeof f !== 'object') return null;
    const rec = f as { vertices?: unknown; normal?: unknown; source?: unknown };
    if (!Array.isArray(rec.vertices)) return null;
    const loop: Vec3[] = [];
    for (const i of rec.vertices) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= vertices.length) return null;
      loop.push(vertices[i]!);
    }
    if (loop.length < 3) continue; // degenerate sliver — dropping is lossless
    // Kernel normal wins (finite, non-zero → normalized); the loop's Newell
    // normal is the fallback so one bad normal never punches a hole in an
    // otherwise watertight mesh. Both degenerate → the face carries no
    // orientation at all and is dropped.
    const kernelN = validUnitNormal(rec.normal);
    const normal = kernelN ?? newellUnitNormal(loop);
    if (!normal) continue;
    const face: Face = { id: `face_sm_${nextId++}`, vertices: loop, normal };
    const source = sanitizeSmSource(rec.source);
    if (source) face.source = source;
    faces.push(face);
  }
  if (faces.length === 0) return null;

  return {
    id: `body_sm_${nextId++}`,
    name,
    // The kernel's vertex table passes through unreferenced-vertex- and all —
    // unlike booleanManifold's welded output there is nothing to compact, the
    // indices are already shared.
    vertices,
    faces,
    edges: buildEdgesFromFaces(faces),
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const SM_KINDS: readonly SmPrimitiveKind[] = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
const SM_OPS: readonly SmBooleanOp[] = ['union', 'difference', 'intersect'];

function fail(reason: SmFailureReason, error: string): SmOpResult {
  return { ok: false, reason, error };
}

function validatePrimitiveReq(req: SmPrimitiveReq, label: string): SmOpResult | null {
  if (!req || typeof req !== 'object') {
    return fail('bad-request', `${label} request must be an object`);
  }
  if (!(SM_KINDS as readonly string[]).includes(req.kind)) {
    return fail('bad-request', `${label}: unknown primitive kind '${String(req.kind)}'`);
  }
  if (!req.params || typeof req.params !== 'object' || Array.isArray(req.params)) {
    return fail('bad-request', `${label}: params must be an object`);
  }
  return null;
}

async function requireAvailable(): Promise<SmOpResult | null> {
  const st = await smStatus();
  if (st.available) return null;
  return fail('unavailable', st.error ?? 'SMLib service unavailable');
}

function parseBodyResult(raw: unknown, name: string): SmOpResult {
  if (!raw || typeof raw !== 'object') {
    return fail('bad-response', 'malformed SMLib result envelope');
  }
  const r = raw as { ok?: unknown; body?: unknown; brepVolumeMm3?: unknown; error?: unknown };
  if (typeof r.ok !== 'boolean') {
    return fail('bad-response', 'SMLib result missing the ok flag');
  }
  if (!r.ok) {
    return {
      ok: false,
      reason: 'backend',
      error: typeof r.error === 'string' && r.error ? r.error : 'SMLib operation failed',
    };
  }
  if (typeof r.brepVolumeMm3 !== 'number' || !Number.isFinite(r.brepVolumeMm3)) {
    return fail('bad-response', 'SMLib result missing a finite brepVolumeMm3');
  }
  const body = smBodyToSolidBody(r.body as SmBody, name);
  if (!body) {
    return fail('conversion', 'SMLib mesh failed validation (non-finite vertices or bad face indices)');
  }
  return { ok: true, body, brepVolumeMm3: r.brepVolumeMm3 };
}

async function invokeBodyResult(
  cmd: 'sm_primitive' | 'sm_boolean',
  args: Record<string, unknown>,
  name: string,
): Promise<SmOpResult> {
  let raw: unknown;
  try {
    raw = await invokeSm(cmd, args);
  } catch (e) {
    return fail('invoke', messageOf(e));
  }
  return parseBodyResult(raw, name);
}

function primitiveName(kind: SmPrimitiveKind): string {
  return `SM ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
}

/**
 * Build one kernel primitive (full-result form). Checks availability first,
 * validates the request client-side (no round-trip for typos), then invokes
 * and converts. Never rejects.
 */
export async function runSmPrimitive(req: SmPrimitiveReq): Promise<SmOpResult> {
  const gate = await requireAvailable();
  if (gate) return gate;
  const bad = validatePrimitiveReq(req, 'primitive');
  if (bad) return bad;
  return invokeBodyResult('sm_primitive', { req }, primitiveName(req.kind));
}

/** Exact two-body boolean (full-result form). Same contract as runSmPrimitive. */
export async function runSmBoolean(req: SmBooleanReq): Promise<SmOpResult> {
  const gate = await requireAvailable();
  if (gate) return gate;
  const badA = validatePrimitiveReq(req?.a, 'boolean.a');
  if (badA) return badA;
  const badB = validatePrimitiveReq(req?.b, 'boolean.b');
  if (badB) return badB;
  if (!(SM_OPS as readonly string[]).includes(req?.op)) {
    return fail('bad-request', `boolean: unknown op '${String(req?.op)}'`);
  }
  return invokeBodyResult('sm_boolean', { req }, `SM ${req.op[0]!.toUpperCase()}${req.op.slice(1)}`);
}

// ---------------------------------------------------------------------------
// Convenience wrappers (the surface the next wiring pass should consume)
// ---------------------------------------------------------------------------

/** Kernel primitive as a SolidBody, or null on ANY failure (see runSmPrimitive
 *  for the discriminated failure detail). */
export async function createSmPrimitive(
  kind: SmPrimitiveKind,
  params: SmPrimitiveParams,
  tessellation?: SmTessellation,
): Promise<SolidBody | null> {
  const r = await runSmPrimitive({ kind, params, tessellation });
  return r.ok ? r.body : null;
}

/** Exact boolean of two kernel primitives; `brepVolume` is the kernel's exact
 *  B-rep volume in mm³ (the tessellated mesh's volume only approximates it). */
export async function smBoolean(
  a: SmPrimitiveReq,
  b: SmPrimitiveReq,
  op: SmBooleanOp,
  tessellation?: SmTessellation,
): Promise<{ body: SolidBody; brepVolume: number } | null> {
  const r = await runSmBoolean({ a, b, op, tessellation });
  return r.ok ? { body: r.body, brepVolume: r.brepVolumeMm3 } : null;
}

// ---------------------------------------------------------------------------
// Analytic-primitive facade (P3 v1.5 UI wiring surface)
// ---------------------------------------------------------------------------

/**
 * Is `kind` (a PrimitiveKind in the UI's 9-kind space) one the kernel builds
 * exactly? Narrowing guard so dialog/store call sites can branch without
 * duplicating the kind list.
 */
export function isSmAnalyticKind(kind: string): kind is SmPrimitiveKind {
  return (SM_KINDS as readonly string[]).includes(kind);
}

/**
 * UI-facing facade over createSmPrimitive for the 5 analytic kinds.
 *
 * Input contract: `params` uses the PrimitiveDialog's field keys — box
 * {w,h,d}, cylinder {r,h}, sphere {r}, cone {rb,rt,h}, torus {R,r} — all plain
 * numbers; the mapping onto kernel params (size/majorRadius/...) and the
 * anchoring correction live HERE so callers stay one-liners.
 *
 * Anchoring parity with brep.ts (pinned by the bbox tests in smClient.test.ts):
 * the kernel centers box/sphere/torus on `center` and stands cylinder/cone on
 * their base circle there, while brep's createBox anchors the BOTTOM face at
 * y=0 (createCylinder/createCone already stand at y=0, createSphere and
 * createTorus are origin-centred). The only correction needed is therefore the
 * box center shift [0, h/2, 0]; a user toggling SMLib on/off must never see
 * the body jump.
 *
 * Tessellation: chordToleranceMm = DEFAULT_CHORD_TOLERANCE (0.005 mm), the
 * same deviation budget brep's adaptiveSegments spends on cylinders/cones, so
 * the kernel mesh is at least as faithful as the brep mesh. (brep's sphere=16
 * segments and torus=32×16 are coarser than that budget; the kernel comes out
 * denser but strictly closer to the true surface — visually indistinguishable
 * at scene scale. Planar faces are exact regardless of the tolerance.)
 *
 * Returns null on ANY failure — kernel unavailable, non-analytic kind,
 * invalid/missing params (including torus minor>major, which the brep
 * constructor rejects too) — so the caller falls back to its synchronous brep
 * constructor and reproduces today's behaviour byte-for-byte. Never rejects.
 */
export async function createAnalyticPrimitive(
  kind: SmPrimitiveKind,
  params: Record<string, number>,
): Promise<SolidBody | null> {
  const num = (v: number | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const pos = (v: number | undefined): number | null => {
    const n = num(v);
    return n !== null && n > 0 ? n : null;
  };
  const nonNeg = (v: number | undefined): number | null => {
    const n = num(v);
    return n !== null && n >= 0 ? n : null;
  };

  // Client-side validation: anything the KERNEL would reject (plus params it
  // cannot represent) returns null BEFORE the availability gate/round-trip, so
  // the brep fallback (whose own validation then decides, exactly as today) is
  // instant. Note brep accepts a few shapes the kernel cannot — cone rb=0
  // (inverted frustum) and torus minor>major reach brep through this null and
  // keep their historical behaviour there.
  let req: SmPrimitiveReq;
  switch (kind) {
    case 'box': {
      const w = pos(params.w);
      const h = pos(params.h);
      const d = pos(params.d);
      if (w === null || h === null || d === null) return null;
      req = { kind, params: { size: [w, h, d], center: [0, h / 2, 0] } };
      break;
    }
    case 'cylinder': {
      const r = pos(params.r);
      const h = pos(params.h);
      if (r === null || h === null) return null;
      req = { kind, params: { radius: r, height: h } };
      break;
    }
    case 'sphere': {
      const r = pos(params.r);
      if (r === null) return null;
      req = { kind, params: { radius: r } };
      break;
    }
    case 'cone': {
      // Kernel: bottomRadius > 0, topRadius >= 0 (0 = pointed). brep's
      // createCone additionally accepts rb=0 (rt>0); pos() sends those to the
      // brep fallback instead of a doomed kernel round-trip.
      const rb = pos(params.rb);
      const rt = nonNeg(params.rt);
      const h = pos(params.h);
      if (rb === null || rt === null || h === null) return null;
      req = { kind, params: { bottomRadius: rb, topRadius: rt, height: h } };
      break;
    }
    case 'torus': {
      const R = pos(params.R);
      const r = pos(params.r);
      if (R === null || r === null || r > R) return null;
      req = { kind, params: { majorRadius: R, minorRadius: r } };
      break;
    }
    default:
      return null; // non-analytic kind — caller's brep path owns it
  }
  try {
    const r = await runSmPrimitive({
      ...req,
      // See the tessellation note above: brep's chord budget, applied
      // uniformly (harmless for the box's planar faces).
      tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE },
    });
    return r.ok ? r.body : null;
  } catch {
    return null; // defensive: runSmPrimitive never rejects, the UI must not either
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Replace the native transport (null restores production `callNative`). Only
 * tests install an invoker; production code never touches this.
 */
export function __setSmInvokerForTests(fn: SmInvoker | null): void {
  invokerOverride = fn;
}

/** Forget the cached status and any test invoker — run each case cold. */
export function __resetSmClientForTests(): void {
  invokerOverride = null;
  statusPromise = null;
  statusSnapshot = null;
}
