// Tests for the SMLib typed client. The native transport is swapped via the
// `__setSmInvokerForTests` seam (jsdom has no Tauri runtime — see the module
// header of smClient.ts for why we do not mock @tauri-apps modules).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  smStatus,
  isSmAvailable,
  runSmPrimitive,
  runSmBoolean,
  createSmPrimitive,
  smBoolean,
  smBodyToSolidBody,
  __setSmInvokerForTests,
  __resetSmClientForTests,
} from './smClient';
import type { SmBody, SmPrimitiveReq, SmStatus } from './smClient';
import { computeVolume } from './brep';
import { smStatus as smStatusViaIndex, createSmPrimitive as createViaIndex } from './index';

/** 10 mm cube centred at the origin, Y-up, consistently wound CCW-outward. */
function cubeBody(): SmBody {
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return {
    vertices: [
      v(-5, -5, -5), v(5, -5, -5), v(5, -5, 5), v(-5, -5, 5),
      v(-5, 5, -5), v(5, 5, -5), v(5, 5, 5), v(-5, 5, 5),
    ],
    faces: [
      { vertices: [0, 1, 2, 3], normal: [0, -1, 0] },
      { vertices: [4, 7, 6, 5], normal: [0, 1, 0] },
      { vertices: [0, 4, 5, 1], normal: [0, 0, -1] },
      { vertices: [3, 2, 6, 7], normal: [0, 0, 1] },
      { vertices: [0, 3, 7, 4], normal: [-1, 0, 0] },
      { vertices: [1, 5, 6, 2], normal: [1, 0, 0] },
    ],
  };
}

/** Transport fake answering sm_status positively and sm_* from a payload map.
 *  (`key in opts` rather than `??` so explicit null/undefined payloads are
 *  delivered verbatim instead of falling back to the happy default.) */
function kernelInvoker(opts?: { status?: SmStatus | Error; primitive?: unknown; boolean?: unknown }) {
  const pick = (key: 'status' | 'primitive' | 'boolean', fallback: unknown): unknown =>
    opts && key in opts ? opts[key] : fallback;
  return vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'sm_status') {
      const s = pick('status', { available: true, version: 'SMLib 1.2.3' });
      if (s instanceof Error) throw s;
      return s;
    }
    if (cmd === 'sm_primitive') {
      const p = pick('primitive', { ok: true, body: cubeBody(), brepVolumeMm3: 1000 });
      if (p instanceof Error) throw p;
      return p;
    }
    if (cmd === 'sm_boolean') {
      const b = pick('boolean', { ok: true, body: cubeBody(), brepVolumeMm3: 500 });
      if (b instanceof Error) throw b;
      return b;
    }
    throw new Error(`unexpected command ${cmd} ${JSON.stringify(args)}`);
  });
}

const BOX_REQ: SmPrimitiveReq = { kind: 'box', params: { size: [10, 10, 10] } };

beforeEach(() => {
  __resetSmClientForTests();
});

afterEach(() => {
  __resetSmClientForTests();
});

// ---------------------------------------------------------------------------
// smBodyToSolidBody — the pure conversion
// ---------------------------------------------------------------------------

describe('smBodyToSolidBody', () => {
  it('converts an indexed cube into a watertight SolidBody', () => {
    const body = smBodyToSolidBody(cubeBody(), 'SM Box')!;
    expect(body).not.toBeNull();
    expect(body.name).toBe('SM Box');
    expect(body.id).toMatch(/^body_sm_\d+$/);
    expect(body.vertices).toHaveLength(8);
    expect(body.faces).toHaveLength(6);
    expect(body.edges).toHaveLength(12); // unique undirected edges of a cube
    for (const f of body.faces) expect(f.id).toMatch(/^face_sm_\d+$/);
    expect(computeVolume(body)).toBeCloseTo(1000, 6);
  });

  it('passes through all five valid source kinds and normalizes directions', () => {
    const sm = cubeBody();
    const v = (x: number, y: number, z: number) => ({ x, y, z });
    // Deliberately non-unit axes/directions — the converter must normalize.
    sm.faces[0]!.source = { kind: 'plane', point: v(0, -5, 0), normal: v(0, -3, 0) };
    sm.faces[1]!.source = { kind: 'cylinder', origin: v(0, 0, 0), axis: v(0, 2, 0), radius: 5 };
    sm.faces[2]!.source = { kind: 'cone', apex: v(0, 5, 0), axis: v(0, -4, 0), halfAngle: Math.PI / 4 };
    sm.faces[3]!.source = { kind: 'sphere', center: v(0, 0, 0), radius: 8.66 };
    sm.faces[4]!.source = { kind: 'torus', center: v(0, 0, 0), axis: v(5, 0, 0), majorRadius: 5, minorRadius: 2 };
    const body = smBodyToSolidBody(sm, 'Tagged')!;

    expect(body.faces[0]!.source).toEqual({ kind: 'plane', point: { x: 0, y: -5, z: 0 }, normal: { x: 0, y: -1, z: 0 } });
    expect(body.faces[1]!.source).toEqual({ kind: 'cylinder', origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius: 5 });
    expect(body.faces[2]!.source).toMatchObject({ kind: 'cone', apex: { x: 0, y: 5, z: 0 }, axis: { x: 0, y: -1, z: 0 }, halfAngle: Math.PI / 4 });
    expect(body.faces[3]!.source).toEqual({ kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 8.66 });
    expect(body.faces[4]!.source).toEqual({ kind: 'torus', center: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, majorRadius: 5, minorRadius: 2 });
    expect(body.faces[5]!.source).toBeUndefined(); // none set → none attached
  });

  it('tolerates tuple-form Vec3 fields in wire sources (envelope style)', () => {
    const sm = cubeBody();
    sm.faces[1]!.source = {
      kind: 'cylinder',
      origin: [0, 0, 0],
      axis: [0, 2, 0],
      radius: 5,
    } as unknown as NonNullable<SmBody['faces'][number]['source']>;
    const body = smBodyToSolidBody(sm, 'X')!;
    expect(body.faces[1]!.source).toEqual({ kind: 'cylinder', origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius: 5 });
  });

  it('drops invalid source tags but keeps the geometry', () => {
    const cases: Array<[string, unknown]> = [
      ['NaN radius', { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 1, 0], radius: Number.NaN }],
      ['zero axis', { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 0], radius: 5 }],
      ['unknown kind', { kind: 'hyperboloid', origin: [0, 0, 0], axis: [0, 1, 0], radius: 5 }],
      ['negative sphere radius', { kind: 'sphere', center: [0, 0, 0], radius: -1 }],
      ['NaN plane point', { kind: 'plane', point: [Number.NaN, 0, 0], normal: [0, 1, 0] }],
      ['zero-length plane normal', { kind: 'plane', point: [0, 0, 0], normal: [0, 0, 0] }],
      ['zero cone halfAngle', { kind: 'cone', apex: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0 }],
      ['right-angle cone halfAngle', { kind: 'cone', apex: [0, 0, 0], axis: [0, 1, 0], halfAngle: Math.PI / 2 }],
      ['torus minor > major', { kind: 'torus', center: [0, 0, 0], axis: [0, 1, 0], majorRadius: 2, minorRadius: 6 }],
      ['non-object source', 42],
      ['source without kind', { radius: 5 }],
    ];
    for (const [label, source] of cases) {
      const sm = cubeBody();
      for (const f of sm.faces) f.source = source as never;
      const body = smBodyToSolidBody(sm, 'X');
      expect(body, label).not.toBeNull();
      expect(body!.faces, label).toHaveLength(6); // geometry kept
      for (const f of body!.faces) expect(f.source, label).toBeUndefined(); // tag dropped
      expect(computeVolume(body!), label).toBeCloseTo(1000, 6);
    }
  });

  it('returns null for structurally corrupt meshes', () => {
    const oob = cubeBody();
    oob.faces[0]!.vertices = [0, 1, 99];
    expect(smBodyToSolidBody(oob, 'X')).toBeNull();

    const negative = cubeBody();
    negative.faces[2]!.vertices = [0, 1, -1];
    expect(smBodyToSolidBody(negative, 'X')).toBeNull();

    const fractional = cubeBody();
    fractional.faces[0]!.vertices = [0, 1, 1.5];
    expect(smBodyToSolidBody(fractional, 'X')).toBeNull();

    const nanVertex = cubeBody();
    nanVertex.vertices[3] = [0, Number.NaN, 0];
    expect(smBodyToSolidBody(nanVertex, 'X')).toBeNull();

    const shortTriple = cubeBody();
    shortTriple.vertices[3] = [1, 2] as unknown as [number, number, number];
    expect(smBodyToSolidBody(shortTriple, 'X')).toBeNull();

    const noFaces = cubeBody();
    noFaces.faces = [];
    expect(smBodyToSolidBody(noFaces, 'X')).toBeNull();

    const notArray = cubeBody();
    (notArray as unknown as { faces: unknown }).faces = 'nope';
    expect(smBodyToSolidBody(notArray, 'X')).toBeNull();

    const faceNoRing = cubeBody();
    delete (faceNoRing.faces[0] as unknown as { vertices?: number[] }).vertices;
    expect(smBodyToSolidBody(faceNoRing, 'X')).toBeNull();
  });

  it('drops degenerate faces (<3 indices) without failing the body', () => {
    const sm = cubeBody();
    sm.faces.push({ vertices: [0, 1], normal: [0, 1, 0] });
    sm.faces.push({ vertices: [], normal: [0, 1, 0] });
    const body = smBodyToSolidBody(sm, 'X')!;
    expect(body.faces).toHaveLength(6);
  });

  it('falls back to the loop normal when the kernel normal is unusable', () => {
    const zeroN = cubeBody();
    zeroN.faces[1]!.normal = [0, 0, 0]; // top face — Newell of [4,7,6,5] is +Y
    const body = smBodyToSolidBody(zeroN, 'X')!;
    expect(body.faces[1]!.normal).toEqual({ x: 0, y: 1, z: 0 });

    const nanN = cubeBody();
    nanN.faces[0]!.normal = [Number.NaN, 0, 0];
    const body2 = smBodyToSolidBody(nanN, 'X')!;
    expect(body2.faces[0]!.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(computeVolume(body2)).toBeCloseTo(1000, 6);
  });

  it('drops a face only when neither kernel nor loop normal exists (collinear loop)', () => {
    const sm: SmBody = {
      vertices: [
        [0, 0, 0], [1, 0, 0], [2, 0, 0], // collinear triple
        [0, 0, 0], [1, 0, 0], [0, 1, 0], // a healthy triangle
      ],
      faces: [
        { vertices: [0, 1, 2], normal: [0, 0, 0] },
        { vertices: [3, 4, 5], normal: [0, 0, 1] },
      ],
    };
    const body = smBodyToSolidBody(sm, 'X')!;
    expect(body.faces).toHaveLength(1); // collinear one dropped, triangle kept
  });

  it('normalizes a valid kernel normal to unit length', () => {
    const sm = cubeBody();
    sm.faces[1]!.normal = [0, 7, 0];
    const body = smBodyToSolidBody(sm, 'X')!;
    expect(body.faces[1]!.normal).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('converts a ~10k-vertex grid in well under the 50 ms design target', () => {
    // 100×100 grid → 10,000 vertices, 9,801 quads, 19,800 unique edges.
    const N = 100;
    const vertices: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) vertices.push([i * 0.1, 0, j * 0.1]);
    }
    const faces: SmBody['faces'] = [];
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < N - 1; j++) {
        const a = i * N + j;
        faces.push({ vertices: [a, a + N, a + N + 1, a + 1], normal: [0, 1, 0] });
      }
    }
    const sm: SmBody = { vertices, faces };
    const t0 = performance.now();
    const body = smBodyToSolidBody(sm, 'Grid')!;
    const elapsed = performance.now() - t0;
    expect(body.vertices).toHaveLength(10000);
    expect(body.faces).toHaveLength(9801);
    expect(body.edges).toHaveLength(19800); // deduplicated shared grid edges
    // Design target is 50 ms; the loose 200 ms bound keeps CI jitter from
    // flaking the assertion while still catching an O(n²) regression.
    expect(elapsed).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Availability + caching
// ---------------------------------------------------------------------------

describe('smStatus / isSmAvailable', () => {
  it('degrades gracefully outside Tauri (no invoker, jsdom): never throws', async () => {
    const st = await smStatus();
    expect(st.available).toBe(false);
    expect(typeof st.error).toBe('string');
    expect(isSmAvailable()).toBe(false);
  });

  it('caches the first answer — repeated and concurrent calls invoke once', async () => {
    const invoker = kernelInvoker();
    __setSmInvokerForTests(invoker);
    const a = await smStatus();
    const b = await smStatus();
    expect(a).toEqual({ available: true, version: 'SMLib 1.2.3' });
    expect(b).toBe(a);
    expect(invoker).toHaveBeenCalledTimes(1);

    __resetSmClientForTests();
    const invoker2 = kernelInvoker();
    __setSmInvokerForTests(invoker2);
    await Promise.all([smStatus(), smStatus(), smStatus()]);
    expect(invoker2).toHaveBeenCalledTimes(1);
  });

  it('caches failures too (a throwing transport is probed exactly once)', async () => {
    const invoker = kernelInvoker({ status: new Error('command sm_status not found') });
    __setSmInvokerForTests(invoker);
    const a = await smStatus();
    const b = await smStatus();
    expect(a.available).toBe(false);
    expect(a.error).toContain('sm_status');
    expect(b).toBe(a);
    expect(invoker).toHaveBeenCalledTimes(1);
    expect(isSmAvailable()).toBe(false);
  });

  it('reports malformed status payloads as unavailable rather than throwing', async () => {
    __setSmInvokerForTests(vi.fn(async () => ({ nope: true })));
    const st = await smStatus();
    expect(st.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Operations through the (mocked) transport
// ---------------------------------------------------------------------------

describe('runSmPrimitive / runSmBoolean', () => {
  it('happy path: converts the kernel body and keeps the exact volume', async () => {
    const invoker = kernelInvoker();
    __setSmInvokerForTests(invoker);
    const r = await runSmPrimitive(BOX_REQ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.name).toBe('SM Box');
    expect(computeVolume(r.body)).toBeCloseTo(1000, 6);
    expect(r.brepVolumeMm3).toBe(1000);
    expect(isSmAvailable()).toBe(true);
    expect(invoker).toHaveBeenCalledWith('sm_primitive', { req: BOX_REQ });
    // The status gate ran exactly once and was not re-queried for the op.
    expect(invoker.mock.calls.filter(([cmd]) => cmd === 'sm_status')).toHaveLength(1);
  });

  it('boolean happy path forwards the request shape and returns the kernel volume', async () => {
    const invoker = kernelInvoker();
    __setSmInvokerForTests(invoker);
    const cyl: SmPrimitiveReq = { kind: 'cylinder', params: { radius: 3, height: 8 } };
    const r = await runSmBoolean({ a: BOX_REQ, b: cyl, op: 'difference' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.name).toBe('SM Difference');
    expect(r.brepVolumeMm3).toBe(500);
    expect(invoker).toHaveBeenCalledWith('sm_boolean', {
      req: { a: BOX_REQ, b: cyl, op: 'difference', tessellation: undefined },
    });
  });

  it('passes backend { ok: false } errors through verbatim', async () => {
    __setSmInvokerForTests(kernelInvoker({ primitive: { ok: false, error: 'zero-thickness slab' } }));
    const r = await runSmPrimitive(BOX_REQ);
    expect(r).toEqual({ ok: false, reason: 'backend', error: 'zero-thickness slab' });
  });

  it('returns unavailable (without invoking ops) when the kernel is not usable', async () => {
    // No invoker installed → jsdom, callNative rejects → cached unavailable.
    const r = await runSmPrimitive(BOX_REQ);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unavailable');
    expect(typeof r.error).toBe('string');

    const r2 = await runSmBoolean({ a: BOX_REQ, b: BOX_REQ, op: 'union' });
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.reason).toBe('unavailable');
  });

  it('surfaces transport rejections as reason invoke (never throws)', async () => {
    __setSmInvokerForTests(kernelInvoker({ primitive: new Error('IPC died') }));
    const r = await runSmPrimitive(BOX_REQ);
    expect(r).toEqual({ ok: false, reason: 'invoke', error: 'IPC died' });
  });

  it('classifies malformed envelopes as bad-response', async () => {
    for (const payload of [null, 42, 'ok', { ok: 'yes' }, { ok: true }, { ok: true, body: cubeBody() }]) {
      __resetSmClientForTests();
      __setSmInvokerForTests(kernelInvoker({ primitive: payload }));
      const r = await runSmPrimitive(BOX_REQ);
      expect(r.ok, JSON.stringify(payload)).toBe(false);
      expect(!r.ok && r.reason).toBe('bad-response');
    }
  });

  it('reports meshes that fail conversion as reason conversion', async () => {
    const corrupt = cubeBody();
    corrupt.faces[0]!.vertices = [0, 1, 77];
    __setSmInvokerForTests(kernelInvoker({ primitive: { ok: true, body: corrupt, brepVolumeMm3: 1 } }));
    const r = await runSmPrimitive(BOX_REQ);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('conversion');
  });

  it('rejects malformed requests client-side without any op invoke', async () => {
    const invoker = kernelInvoker();
    __setSmInvokerForTests(invoker);
    await runSmPrimitive({ kind: 'hypercube' as never, params: {} });
    await runSmPrimitive({ kind: 'box', params: [] as never });
    await runSmBoolean({ a: BOX_REQ, b: BOX_REQ, op: 'xor' as never });
    const opCalls = invoker.mock.calls.filter(([cmd]) => cmd !== 'sm_status');
    expect(opCalls).toHaveLength(0);
    const reasons = [
      await runSmPrimitive({ kind: 'box' } as never),
      await runSmBoolean({ a: BOX_REQ, b: { kind: 'box' } as never, op: 'union' }),
    ];
    for (const r of reasons) expect(!r.ok && r.reason).toBe('bad-request');
  });
});

// ---------------------------------------------------------------------------
// Convenience wrappers + module surface
// ---------------------------------------------------------------------------

describe('createSmPrimitive / smBoolean convenience', () => {
  it('returns a SolidBody on success and null on failure', async () => {
    __setSmInvokerForTests(kernelInvoker());
    const body = await createSmPrimitive('box', { size: [10, 10, 10] }, { chordToleranceMm: 0.02 });
    expect(body).not.toBeNull();
    expect(body!.id).toMatch(/^body_sm_\d+$/);
    expect(computeVolume(body!)).toBeCloseTo(1000, 6);
  });

  it('returns null when the kernel is unavailable', async () => {
    const body = await createSmPrimitive('sphere', { radius: 4 });
    expect(body).toBeNull();
  });

  it('returns null on backend failure', async () => {
    __setSmInvokerForTests(kernelInvoker({ boolean: { ok: false, error: 'degenerate input' } }));
    const r = await smBoolean(BOX_REQ, { kind: 'sphere', params: { radius: 2 } }, 'intersect');
    expect(r).toBeNull();
  });

  it('smBoolean returns the body plus the exact B-rep volume', async () => {
    __setSmInvokerForTests(kernelInvoker());
    const r = await smBoolean(BOX_REQ, { kind: 'cylinder', params: { radius: 3, height: 8 } }, 'difference');
    expect(r).not.toBeNull();
    expect(r!.brepVolume).toBe(500);
    expect(r!.body.faces).toHaveLength(6);
  });
});

describe('module surface', () => {
  it('is re-exported from the geometry index', () => {
    expect(typeof smStatusViaIndex).toBe('function');
    expect(typeof createViaIndex).toBe('function');
  });
});
