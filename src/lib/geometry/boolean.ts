/**
 * Boolean / split / hollow entry points. Exact WASM (Manifold) results first;
 * the voxel approximation backs everything up. The async variants offload the
 * slow voxel path to a Web Worker (see lib/workers) so the main thread stays
 * responsive, falling back to synchronous execution where Workers are absent
 * (tests, non-browser hosts).
 *
 * Voxel-fallback guardrails: when the exact engine cannot help, that is no
 * longer silent. Every fallback records WHY in `lastBooleanFallbackReason()`;
 * a non-manifold input (e.g. a fillet/chamfer overlay body, an open mesh)
 * that can never go through the exact path additionally raises a visible
 * warning (console.warn + toast by default, override with
 * `setBooleanFallbackNotifier`) — those ops are the 15–19 s blocky-voxel
 * cliff on every recompute, and callers deserve to know. Callers that only
 * ever want exact results can pass `{ allowVoxelFallback: false }` and get
 * null instead of a blocky substitute.
 */
import type { SolidBody, Vec3, PlaneDefinition } from './types';
import { applyMirror } from './operations';
import { checkManifold } from './brep';
import { showToast } from '../toast';
import {
  booleanOpVoxel,
  mirrorMergeVoxel,
  splitByPlaneVoxel,
  hollowBodyVoxel,
} from './booleanVoxel';
import type { BooleanOp } from './booleanVoxel';
import { booleanOpManifold, splitByPlaneManifold, warmUpBooleanEngine, isManifoldEngineReady } from './booleanManifold';
import { runGeometryOp } from '../workers/geometryWorkerClient';

export type { BooleanOp } from './booleanVoxel';
// NOTE: __resetManifoldEngineForTests (booleanManifold.ts) is intentionally NOT
// re-exported here — the vite ssr transform drops `__`-prefixed names from
// value re-exports, so tests import it directly from './booleanManifold',
// matching the __setExactStepLoaderForTests precedent.
export { warmUpBooleanEngine, isManifoldEngineReady };

/** Why a boolean left the exact (Manifold) path, in the order checked. */
export type BooleanFallbackReason =
  /** An input body is not a closed 2-manifold — the exact path can NEVER
   * accept it, so every op on it is a slow blocky-voxel result. */
  | 'non-manifold-input'
  /** Both inputs are clean but the WASM engine has not finished warming. */
  | 'engine-not-ready'
  /** Engine warm, inputs clean, but the exact result was empty (e.g.
   * intersect of disjoint bodies) — the voxel pass-through will be too. */
  | 'empty-exact-result';

/** Options for booleanOp / asyncBooleanOp. */
export interface BooleanOpOptions {
  /**
   * Default true: fall back to the voxel approximation whenever the exact
   * engine cannot produce a result (previous behavior). Set false for
   * "exact-only" semantics: null comes back instead, and
   * lastBooleanFallbackReason() says why.
   */
  allowVoxelFallback?: boolean;
}

/** Structured payload handed to fallback notifiers (see setBooleanFallbackNotifier). */
export interface BooleanFallbackInfo {
  op: BooleanOp;
  reason: BooleanFallbackReason;
  /** Names of the input bodies that failed the manifold compatibility check. */
  incompatibleBodies: string[];
}

export type BooleanFallbackNotifier = (info: BooleanFallbackInfo) => void;

let fallbackNotifier: BooleanFallbackNotifier | null = null;
let lastReason: BooleanFallbackReason | null = null;

/** Reason the LAST booleanOp/asyncBooleanOp call left the exact path (null
 *  when it succeeded exactly, or before any call). Cheap to poll after an
 *  unexpectedly slow or blocky result. */
export function lastBooleanFallbackReason(): BooleanFallbackReason | null {
  return lastReason;
}

/**
 * Replace the default non-manifold-fallback warning (console.warn + toast)
 * with a custom sink, or pass null to restore the default. The geometry
 * layer stays UI-agnostic: the app wires its own toast/no-op here if it
 * wants different presentation.
 */
export function setBooleanFallbackNotifier(fn: BooleanFallbackNotifier | null): void {
  fallbackNotifier = fn;
}

/**
 * True when `body` is a closed 2-manifold surface (every edge shared by
 * exactly two faces, no boundary) — the precondition Manifold's ofMesh
 * needs, checked cheaply via brep's checkManifold edge-adjacency count
 * (measured ~2 ms on a 12,980-face voxel mesh; the voxel op it guards
 * takes 15–19 s). Fillet/chamfer OVERLAY bodies deliberately fail this:
 * their spine edges carry 4 faces, so every boolean after them warns.
 */
export function isBodyManifoldCompatible(body: SolidBody): boolean {
  return checkManifold(body).isManifold;
}

function classifyFallback(a: SolidBody, b: SolidBody): { reason: BooleanFallbackReason; incompatible: { name: string; id: string }[] } {
  const incompatible: { name: string; id: string }[] = [];
  if (!isBodyManifoldCompatible(a)) incompatible.push({ name: a.name, id: a.id });
  if (!isBodyManifoldCompatible(b)) incompatible.push({ name: b.name, id: b.id });
  if (incompatible.length > 0) return { reason: 'non-manifold-input', incompatible };
  if (!isManifoldEngineReady()) return { reason: 'engine-not-ready', incompatible };
  return { reason: 'empty-exact-result', incompatible };
}

let lastAnnounceKey: string | null = null;

/**
 * Visible warning for non-manifold fallbacks, throttled to one per fallback
 * EPISODE: consecutive fallbacks on the same body (a 16-hole drill chain on
 * a filleted body) warn once, not once per op. The throttle clears whenever
 * any boolean succeeds exactly again, so the next episode re-warns.
 */
function announceFallback(op: BooleanOp, incompatible: { name: string; id: string }[]): void {
  const key = incompatible.map((x) => x.id).sort().join('|');
  if (key === lastAnnounceKey) return;
  lastAnnounceKey = key;
  const info: BooleanFallbackInfo = {
    op,
    reason: 'non-manifold-input',
    incompatibleBodies: incompatible.map((x) => x.name),
  };
  if (fallbackNotifier) {
    fallbackNotifier(info);
    return;
  }
  const detail = `Boolean (${info.op}) on non-manifold body ${info.incompatibleBodies.join(', ')}: the exact engine can never convert it, falling back to a slow blocky voxel result.`;
  console.warn(detail);
  showToast(detail, 'warning');
}

function noteExactSuccess(): void {
  lastReason = null;
  lastAnnounceKey = null; // new episode: the next fallback warns again
}

/**
 * Boolean of two solids (union / difference A−B / intersect). Exact (Manifold)
 * when the engine is warm; otherwise a voxel approximation — occupancy sampled
 * on a grid via point-in-mesh tests, boundary faces emitted between solid and
 * empty cells. The voxel result is blocky, with fidelity growing with
 * `resolution`. Returns null if the result is empty, or when
 * `options.allowVoxelFallback === false` and the exact path could not run.
 *
 * The sync path records why it fell off the exact path
 * (lastBooleanFallbackReason) but stays quiet — CAM and feature recompute
 * loops call it dozens of times per rebuild; the visible warning lives on
 * asyncBooleanOp.
 */
export function booleanOp(
  a: SolidBody,
  b: SolidBody,
  op: BooleanOp,
  resolution = 32,
  options: BooleanOpOptions = {},
): SolidBody | null {
  // Exact path first — null covers "not ready" and "fell back internally".
  const exact = booleanOpManifold(a, b, op);
  if (exact) {
    noteExactSuccess();
    return exact;
  }
  lastReason = classifyFallback(a, b).reason;
  if (options.allowVoxelFallback === false) return null;
  return booleanOpVoxel(a, b, op, resolution);
}

/** Worker-offloaded boolean: exact on the main thread (it's milliseconds),
 *  voxel sampling in the background when the exact engine can't help. A
 *  non-manifold input announces the fallback (console.warn + toast by
 *  default) before offloading; the voxel result is still returned so CAM
 *  and feature-recompute chains keep working — the guardrail makes the
 *  15–19 s cliff visible, not fatal. */
export function asyncBooleanOp(
  a: SolidBody,
  b: SolidBody,
  op: BooleanOp,
  resolution = 32,
  options: BooleanOpOptions = {},
): Promise<SolidBody | null> {
  const exact = booleanOpManifold(a, b, op);
  if (exact) {
    noteExactSuccess();
    return Promise.resolve(exact);
  }
  const { reason, incompatible } = classifyFallback(a, b);
  lastReason = reason;
  if (options.allowVoxelFallback === false) return Promise.resolve(null);
  if (reason === 'non-manifold-input') {
    announceFallback(op, incompatible);
  }
  return runGeometryOp('voxelBoolean', { a, b, op, resolution }, () => booleanOpVoxel(a, b, op, resolution));
}

/**
 * Mirror a body across a plane and fuse the original with its reflection into
 * a single symmetric solid (SolidWorks Mirror with "merge solids"). Voxel
 * union; blocky result, raise `resolution` for fidelity.
 */
export function mirrorMerge(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3 },
  resolution = 40,
): SolidBody | null {
  return mirrorMergeVoxel(body, plane, resolution);
}
export type { Vec3 } from './types';

/**
 * Split a solid with a datum plane (SolidWorks "Split" / planar cut). Uses the
 * exact WASM engine when warm (intersect with two half-space boxes — a clean
 * planar cut surface); otherwise voxel-partition by the side of the plane each
 * cell centre falls on. Each side is a watertight solid; a side with no volume
 * comes back null.
 */
export function splitByPlane(
  body: SolidBody,
  plane: PlaneDefinition,
  resolution = 40,
): { positive: SolidBody | null; negative: SolidBody | null } {
  // Exact path first; nulls mean "not ready / not convertible".
  const exact = splitByPlaneManifold(body, plane);
  if (exact.positive || exact.negative) return exact;
  return splitByPlaneVoxel(body, plane, resolution);
}

/** Worker-offloaded split: exact on the main thread, voxel in the background. */
export function asyncSplitByPlane(
  body: SolidBody,
  plane: PlaneDefinition,
  resolution = 40,
): Promise<{ positive: SolidBody | null; negative: SolidBody | null }> {
  const exact = splitByPlaneManifold(body, plane);
  if (exact.positive || exact.negative) return Promise.resolve(exact);
  return runGeometryOp('voxelSplit', { body, plane, resolution }, () => splitByPlaneVoxel(body, plane, resolution));
}

/**
 * Hollow a solid into a closed shell of approximately `wallThickness` — a true
 * lightweighting hollow (unlike the placeholder applyShell). Voxel-only (no
 * exact path yet), so the async variant is the one UI paths should prefer.
 */
export function hollowBody(body: SolidBody, wallThickness: number, resolution = 40): SolidBody | null {
  return hollowBodyVoxel(body, wallThickness, resolution);
}

export function asyncHollowBody(body: SolidBody, wallThickness: number, resolution = 40): Promise<SolidBody | null> {
  return runGeometryOp('voxelHollow', { body, wallThickness, resolution }, () => hollowBodyVoxel(body, wallThickness, resolution));
}

export { applyMirror };
