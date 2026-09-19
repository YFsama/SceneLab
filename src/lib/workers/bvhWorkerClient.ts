/**
 * Client for the BVH worker. `buildBoundsTree` attaches a bounds tree to a
 * geometry, building it off-thread for large meshes and synchronously
 * otherwise (small meshes, or environments without Worker — vitest/jsdom).
 * The input arrays are COPIED before transfer because postMessage transfer
 * detaches the sender's buffers, and the caller's geometry still owns the
 * originals.
 *
 * The returned promise resolves once `geometry.boundsTree` is set; picking
 * works throughout — `acceleratedRaycast` simply falls back to the default
 * raycast until the tree lands.
 */
import type * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BvhWorkerRequest, BvhWorkerResponse } from './bvhWorker';

let worker: Worker | null | undefined;
const pending = new Map<number, { resolve: (v: { roots: ArrayBuffer[]; index: Uint32Array } | null) => void; reject: (e: Error) => void }>();
let nextReqId = 1;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') {
    worker = null; // tests / non-browser hosts: synchronous build below
    return worker;
  }
  try {
    worker = new Worker(new URL('./bvhWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<BvhWorkerResponse>) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve({ roots: msg.roots, index: msg.index });
      else entry.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error('BVH worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Meshes with at least this many triangles build their picking BVH in the
 * worker (a synchronous build there would block the main thread for a
 * noticeable stretch on import); smaller ones build synchronously — the
 * worker round-trip would cost more than the build itself.
 */
export const ASYNC_BVH_TRIANGLE_THRESHOLD = 15000;

/**
 * Attach a bounds tree to `geometry` (position attribute + index must already
 * be set). `positions`/`indices` must be the SAME data the geometry was built
 * from — the worker reconstructs an identical scratch geometry from copies.
 */
export async function buildBoundsTree(
  geometry: THREE.BufferGeometry,
  positions: Float32Array,
  indices: Uint32Array,
): Promise<void> {
  const w = getWorker();
  if (!w) {
    geometry.computeBoundsTree();
    return;
  }
  const id = nextReqId++;
  // Copy before transfer: the transfer detaches these arrays on the main side.
  const positionsCopy = positions.slice();
  const indicesCopy = indices.slice();
  try {
    const result = await new Promise<{ roots: ArrayBuffer[]; index: Uint32Array } | null>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const msg: BvhWorkerRequest = { id, positions: positionsCopy, indices: indicesCopy };
      w.postMessage(msg, [positionsCopy.buffer, indicesCopy.buffer] as Transferable[]);
    });
    if (result) {
      geometry.boundsTree = MeshBVH.deserialize(
        { roots: result.roots, index: result.index } as never,
        geometry,
      );
      return;
    }
  } catch {
    // Worker crashed or answered with an error — fall through to sync build.
  }
  // Late response for a geometry that no longer needs it, or worker failure:
  // build synchronously unless a tree already landed.
  if (!geometry.boundsTree) geometry.computeBoundsTree();
}

/** Test hook: pretend Workers are unavailable and clear the singleton. */
export function __disableBvhWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) entry.reject(new Error('BVH worker disabled'));
  pending.clear();
}
