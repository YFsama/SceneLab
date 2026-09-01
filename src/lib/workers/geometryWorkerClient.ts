/**
 * Client for the geometry worker. Workers are created lazily on first heavy
 * op; environments without Worker (vitest/jsdom, SSR) transparently run the
 * same kernel synchronously via `fallback`, so every call site stays
 * environment-agnostic. Structured clone handles SolidBody (plain data).
 */
import type { SolidBody, PlaneDefinition } from '../geometry/types';
import type { BooleanOp } from '../geometry/booleanVoxel';
import type { GeometryWorkerResponse, GeometryWorkerRequest } from './geometryWorker';

let worker: Worker | null | undefined;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextReqId = 1;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') {
    worker = null; // tests / non-browser hosts: synchronous fallback
    return worker;
  }
  try {
    worker = new Worker(new URL('./geometryWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<GeometryWorkerResponse>) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      // Unrecoverable worker failure: reject everything and rebuild lazily.
      for (const entry of pending.values()) entry.reject(new Error('Geometry worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export interface GeometryOpPayloads {
  voxelBoolean: { a: SolidBody; b: SolidBody; op: BooleanOp; resolution?: number };
  voxelSplit: { body: SolidBody; plane: PlaneDefinition; resolution?: number };
  voxelHollow: { body: SolidBody; wallThickness: number; resolution?: number };
  voxelMirrorMerge: { body: SolidBody; plane: { origin: PlaneDefinition['origin']; normal: PlaneDefinition['normal'] }; resolution?: number };
}

/**
 * Run a voxel kernel: in the worker when available, otherwise the provided
 * synchronous fallback (same kernel, same arguments). `R` is the fallback's
 * return type — the worker's structured-clone reply has the same shape.
 */
export function runGeometryOp<K extends keyof GeometryOpPayloads, R>(
  op: K,
  payload: GeometryOpPayloads[K],
  fallback: () => R,
): Promise<R> {
  const w = getWorker();
  if (!w) return Promise.resolve(fallback());

  const id = nextReqId++;
  const message: Record<string, unknown> = { id, op, resolution: payload.resolution };
  if (op === 'voxelBoolean') {
    const p = payload as GeometryOpPayloads['voxelBoolean'];
    message.a = p.a;
    message.b = p.b;
    message.booleanOp = p.op;
  } else {
    const p = payload as GeometryOpPayloads['voxelSplit'] | GeometryOpPayloads['voxelHollow'] | GeometryOpPayloads['voxelMirrorMerge'];
    Object.assign(message, p);
  }

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(message as unknown as GeometryWorkerRequest);
  });
}

/** Test hook: pretend Workers are unavailable and clear the singleton. */
export function __disableWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) entry.reject(new Error('Geometry worker disabled'));
  pending.clear();
}
