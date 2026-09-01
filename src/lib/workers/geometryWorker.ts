/// <reference lib="webworker" />
/**
 * Geometry worker: runs the slow voxel kernels off the main thread. The exact
 * Manifold path is NOT bundled here (it answers in milliseconds on the main
 * thread); only the seconds-long occupancy sampling is worth offloading.
 */
import {
  booleanOpVoxel,
  mirrorMergeVoxel,
  splitByPlaneVoxel,
  hollowBodyVoxel,
  type BooleanOp,
} from '../geometry/booleanVoxel';
import type { SolidBody, PlaneDefinition } from '../geometry/types';

export type GeometryWorkerRequest =
  | { id: number; op: 'voxelBoolean'; a: SolidBody; b: SolidBody; booleanOp: BooleanOp; resolution: number }
  | { id: number; op: 'voxelSplit'; body: SolidBody; plane: PlaneDefinition; resolution: number }
  | { id: number; op: 'voxelHollow'; body: SolidBody; wallThickness: number; resolution: number }
  | { id: number; op: 'voxelMirrorMerge'; body: SolidBody; plane: { origin: PlaneDefinition['origin']; normal: PlaneDefinition['normal'] }; resolution: number };

export type GeometryWorkerResponse =
  | { id: number; ok: true; result: SolidBody | null }
  | { id: number; ok: true; result: { positive: SolidBody | null; negative: SolidBody | null } }
  | { id: number; ok: false; error: string };

// The incoming payload mirrors GeometryWorkerRequest with `booleanOp` spelled
// as `op` in the discriminated union; treat it loosely at the boundary.
interface IncomingMessage {
  id: number;
  op: 'voxelBoolean' | 'voxelSplit' | 'voxelHollow' | 'voxelMirrorMerge';
  a?: SolidBody;
  b?: SolidBody;
  body?: SolidBody;
  plane?: PlaneDefinition;
  booleanOp?: BooleanOp;
  wallThickness?: number;
  resolution?: number;
}

self.onmessage = (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  try {
    let response: GeometryWorkerResponse;
    switch (msg.op) {
      case 'voxelBoolean': {
        const result = booleanOpVoxel(msg.a!, msg.b!, msg.booleanOp!, msg.resolution ?? 32);
        response = { id: msg.id, ok: true, result };
        break;
      }
      case 'voxelSplit': {
        const result = splitByPlaneVoxel(msg.body!, msg.plane!, msg.resolution ?? 40);
        response = { id: msg.id, ok: true, result };
        break;
      }
      case 'voxelHollow': {
        const result = hollowBodyVoxel(msg.body!, msg.wallThickness ?? 1, msg.resolution ?? 40);
        response = { id: msg.id, ok: true, result };
        break;
      }
      case 'voxelMirrorMerge': {
        const result = mirrorMergeVoxel(msg.body!, msg.plane!, msg.resolution ?? 40);
        response = { id: msg.id, ok: true, result };
        break;
      }
    }
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies GeometryWorkerResponse);
  }
};
