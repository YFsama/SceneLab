/// <reference lib="webworker" />
/**
 * BVH worker: builds a three-mesh-bvh bounds tree off the main thread for
 * very large meshes (big STL/STEP imports), where a synchronous build blocks
 * for hundreds of milliseconds. The finished tree is serialized zero-copy
 * (`cloneBuffers: false` + transfer list) and rehydrated on the main thread
 * with `MeshBVH.deserialize` — no geometry data travels back, only the node
 * buffers.
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export type BvhWorkerRequest = {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
};

export type BvhWorkerResponse =
  | { id: number; ok: true; roots: ArrayBuffer[]; index: Uint32Array }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<BvhWorkerRequest>) => {
  const { id, positions, indices } = e.data;
  try {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const bvh = new MeshBVH(geometry);
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const roots = serialized.roots as ArrayBuffer[];
    const index = serialized.index as Uint32Array;
    (self as unknown as Worker).postMessage(
      { id, ok: true, roots, index } satisfies BvhWorkerResponse,
      [...roots, index.buffer] as Transferable[],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies BvhWorkerResponse);
  }
};
