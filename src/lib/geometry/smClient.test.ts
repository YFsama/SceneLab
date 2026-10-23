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
  createAnalyticPrimitive,
  isSmAnalyticKind,
  smBoolean,
  smBodyToSolidBody,
  __setSmInvokerForTests,
  __resetSmClientForTests,
} from './smClient';
import type { SmBody, SmPrimitiveKind, SmPrimitiveReq, SmStatus } from './smClient';
import type { SolidBody } from './types';
import { computeVolume, computeBoundingBox, DEFAULT_CHORD_TOLERANCE } from './brep';
import {
  createBox, createCylinder, createSphere, createCone, createTorus,
} from './brep';
import {
  smStatus as smStatusViaIndex,
  createSmPrimitive as createViaIndex,
  createAnalyticPrimitive as createAnalyticViaIndex,
} from './index';

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

// ---------------------------------------------------------------------------
// createAnalyticPrimitive — the UI facade (P3 v1.5)
// ---------------------------------------------------------------------------

/** Mesh generator honouring the SMLib anchoring contract exactly as the Rust
 *  golden tests pin it: box/sphere/torus centred on `center`, cylinder/cone
 *  standing on their base circle at `center`, Y-up. Doubles as the oracle for
 *  the bbox-parity tests below — if the facade's center mapping is wrong the
 *  bboxes diverge. */
function anchoredMockBody(req: { kind: string; params: Record<string, unknown> }): SmBody {
  // Strict tuple types throughout: the project compiles tests with
  // noUncheckedIndexedAccess, so `number[]` destructuring would be
  // number|undefined; the wire contract is a [x,y,z] triple anyway.
  const c = (req.params.center as [number, number, number] | undefined) ?? [0, 0, 0];
  const [cx, cy, cz] = c;
  // Wire FaceSource spells Vec3 fields as {x,y,z} objects.
  const vec = (x: number, y: number, z: number) => ({ x, y, z });
  const N = 16;
  const ring = (y: number, r: number): [number, number, number][] =>
    Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 2;
      return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r] as [number, number, number];
    });

  if (req.kind === 'box') {
    const [sx, sy, sz] = req.params.size as [number, number, number];
    const [hx, hy, hz] = [sx / 2, sy / 2, sz / 2];
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    return {
      vertices: [
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
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

  if (req.kind === 'cylinder') {
    const r = req.params.radius as number;
    const h = req.params.height as number;
    const bot = ring(cy, r);
    const top = ring(cy + h, r);
    const vertices = [...bot, ...top];
    const faces: SmBody['faces'] = [
      { vertices: [...Array(N).keys()].reverse(), normal: [0, -1, 0] },
      { vertices: Array.from({ length: N }, (_, i) => N + i), normal: [0, 1, 0] },
    ];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = ((i + 0.5) / N) * Math.PI * 2;
      faces.push({
        vertices: [i, j, N + j, N + i],
        normal: [Math.cos(a), 0, Math.sin(a)],
        source: { kind: 'cylinder', origin: vec(cx, cy, cz), axis: vec(0, 1, 0), radius: r },
      });
    }
    return { vertices, faces };
  }

  if (req.kind === 'sphere') {
    const r = req.params.radius as number;
    // Octahedron through the 6 axis endpoints — extremes are exact.
    const vertices: [number, number, number][] = [
      [cx + r, cy, cz], [cx - r, cy, cz],
      [cx, cy + r, cz], [cx, cy - r, cz],
      [cx, cy, cz + r], [cx, cy, cz - r],
    ];
    const faces: SmBody['faces'] = [];
    for (const tri of [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [3, 4, 2], [3, 2, 1], [3, 1, 5], [3, 5, 0]] as const) {
      const n = tri.map((i) => vertices[i]!).reduce(
        (s, v) => [s[0] + v[0] / 3 - cx, s[1] + v[1] / 3 - cy, s[2] + v[2] / 3 - cz],
        [0, 0, 0] as [number, number, number],
      );
      const len = Math.hypot(...n);
      faces.push({
        vertices: [...tri],
        normal: [n[0]! / len, n[1]! / len, n[2]! / len],
        source: { kind: 'sphere', center: vec(cx, cy, cz), radius: r },
      });
    }
    return { vertices, faces };
  }

  if (req.kind === 'cone') {
    const rb = req.params.bottomRadius as number;
    const rt = req.params.topRadius as number;
    const h = req.params.height as number;
    const pointed = rt < 1e-9;
    const bot = ring(cy, rb);
    const vertices: [number, number, number][] = [...bot];
    const faces: SmBody['faces'] = [
      { vertices: [...Array(N).keys()].reverse(), normal: [0, -1, 0] },
    ];
    if (pointed) {
      vertices.push([cx, cy + h, cz]);
      const apexIdx = N;
      for (let i = 0; i < N; i++) {
        faces.push({
          vertices: [i, (i + 1) % N, apexIdx],
          normal: [0, 0, 0], // Newell fallback exercises the converter path
          source: { kind: 'cone', apex: vec(cx, cy + h, cz), axis: vec(0, -1, 0), halfAngle: Math.atan2(rb, h) },
        });
      }
    } else {
      const top = ring(cy + h, rt);
      vertices.push(...top);
      faces.push({ vertices: Array.from({ length: N }, (_, i) => N + i), normal: [0, 1, 0] });
      const apexY = cy + (h * rb) / (rb - rt);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        faces.push({
          vertices: [i, j, N + j, N + i],
          normal: [0, 0, 0],
          source: { kind: 'cone', apex: vec(cx, apexY, cz), axis: vec(0, -1, 0), halfAngle: Math.atan2(rb - rt, h) },
        });
      }
    }
    return { vertices, faces };
  }

  // torus
  const R = req.params.majorRadius as number;
  const r = req.params.minorRadius as number;
  // SIDES must be a multiple of 4 so the y extremes (v = 90°/270°) are
  // sampled exactly — the bbox-parity oracle needs ±minorRadius, not a
  // chord-tol approximation of them (the real kernel is finer than that).
  const SEG = 12, SIDES = 12;
  const vertices: [number, number, number][] = [];
  for (let i = 0; i < SEG; i++) {
    const u = (i / SEG) * Math.PI * 2;
    for (let j = 0; j < SIDES; j++) {
      const v = (j / SIDES) * Math.PI * 2;
      vertices.push([
        cx + (R + r * Math.cos(v)) * Math.cos(u),
        cy + r * Math.sin(v),
        cz + (R + r * Math.cos(v)) * Math.sin(u),
      ]);
    }
  }
  const faces: SmBody['faces'] = [];
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SIDES; j++) {
      const ni = (i + 1) % SEG;
      const nj = (j + 1) % SIDES;
      faces.push({
        vertices: [i * SIDES + j, ni * SIDES + j, ni * SIDES + nj, i * SIDES + nj],
        normal: [0, 0, 0],
        source: { kind: 'torus', center: vec(cx, cy, cz), axis: vec(0, 1, 0), majorRadius: R, minorRadius: r },
      });
    }
  }
  return { vertices, faces };
}

/** Kernel fake that ANSWERS FROM THE REQUEST: sm_primitive returns a mesh
 *  anchored per the SMLib contract (see anchoredMockBody). */
function anchoredKernelInvoker() {
  return vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'sm_status') return { available: true, version: 'smmesh-test' };
    if (cmd === 'sm_primitive') {
      const req = (args as { req: { kind: string; params: Record<string, unknown> } }).req;
      return { ok: true, body: anchoredMockBody(req), brepVolumeMm3: 1 };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe('createAnalyticPrimitive (UI facade)', () => {
  it('maps the dialog field keys onto kernel params, incl. the box center shift', async () => {
    const invoker = anchoredKernelInvoker();
    __setSmInvokerForTests(invoker);

    await createAnalyticPrimitive('box', { w: 20, h: 20, d: 20 });
    // brep boxes sit on y=0; the kernel centres them — the facade must shift.
    expect(invoker.mock.calls.at(-1)).toEqual(['sm_primitive', {
      req: {
        kind: 'box',
        params: { size: [20, 20, 20], center: [0, 10, 0] },
        tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE },
      },
    }]);

    await createAnalyticPrimitive('cylinder', { r: 10, h: 20 });
    expect(invoker.mock.calls.at(-1)![1]).toEqual({
      req: { kind: 'cylinder', params: { radius: 10, height: 20 }, tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE } },
    });

    await createAnalyticPrimitive('sphere', { r: 10 });
    expect(invoker.mock.calls.at(-1)![1]).toEqual({
      req: { kind: 'sphere', params: { radius: 10 }, tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE } },
    });

    await createAnalyticPrimitive('cone', { rb: 10, rt: 0, h: 20 });
    expect(invoker.mock.calls.at(-1)![1]).toEqual({
      req: {
        kind: 'cone',
        params: { bottomRadius: 10, topRadius: 0, height: 20 },
        tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE },
      },
    });

    await createAnalyticPrimitive('torus', { R: 10, r: 3 });
    expect(invoker.mock.calls.at(-1)![1]).toEqual({
      req: {
        kind: 'torus',
        params: { majorRadius: 10, minorRadius: 3 },
        tessellation: { chordToleranceMm: DEFAULT_CHORD_TOLERANCE },
      },
    });
  });

  it('returns a tagged kernel body: cylinder walls, torus faces (first wired producer)', async () => {
    __setSmInvokerForTests(anchoredKernelInvoker());

    const cyl = await createAnalyticPrimitive('cylinder', { r: 10, h: 20 });
    expect(cyl).not.toBeNull();
    expect(cyl!.id).toMatch(/^body_sm_\d+$/);
    expect(cyl!.name).toBe('SM Cylinder');
    const walls = cyl!.faces.filter((f) => f.source?.kind === 'cylinder');
    expect(walls.length).toBeGreaterThanOrEqual(1);
    for (const f of walls) {
      expect(f.source).toEqual({
        kind: 'cylinder',
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 1, z: 0 },
        radius: 10,
      });
    }
    // caps stay plane-ish (untagged here) — at least the wall carries provenance
    expect(cyl!.faces.length).toBeGreaterThan(walls.length);

    const tor = await createAnalyticPrimitive('torus', { R: 10, r: 3 });
    expect(tor).not.toBeNull();
    expect(tor!.faces.length).toBeGreaterThan(0);
    for (const f of tor!.faces) {
      expect(f.source).toEqual({
        kind: 'torus',
        center: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 1, z: 0 },
        majorRadius: 10,
        minorRadius: 3,
      });
    }
  });

  it('bbox parity: the kernel body occupies exactly the brep body\'s box (per dimension, chord-level tolerance)', async () => {
    __setSmInvokerForTests(anchoredKernelInvoker());
    const tol = DEFAULT_CHORD_TOLERANCE;
    const cases: Array<[string, SmPrimitiveKind, Record<string, number>, () => SolidBody]> = [
      ['box', 'box', { w: 20, h: 20, d: 20 }, () => createBox(20, 20, 20)],
      ['cylinder', 'cylinder', { r: 10, h: 20 }, () => createCylinder(10, 20)],
      ['sphere', 'sphere', { r: 10 }, () => createSphere(10)],
      ['pointed cone', 'cone', { rb: 10, rt: 0, h: 20 }, () => createCone(10, 0, 20)],
      ['frustum cone', 'cone', { rb: 10, rt: 5, h: 20 }, () => createCone(10, 5, 20)],
      ['torus', 'torus', { R: 10, r: 3 }, () => createTorus(10, 3)],
    ];
    for (const [label, kind, params, brepBuild] of cases) {
      const sm = await createAnalyticPrimitive(kind, params);
      expect(sm, label).not.toBeNull();
      const a = computeBoundingBox(sm!);
      const b = computeBoundingBox(brepBuild());
      for (const dim of ['x', 'y', 'z'] as const) {
        expect(Math.abs(a.min[dim] - b.min[dim]), `${label} min.${dim}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(a.max[dim] - b.max[dim]), `${label} max.${dim}`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('returns null (→ brep fallback) for every failure class', async () => {
    const invoker = anchoredKernelInvoker();
    __setSmInvokerForTests(invoker);

    // Non-analytic kind: refused before ANY invoke (not even sm_status).
    expect(await createAnalyticPrimitive('wedge' as never, { w: 1, h: 1, d: 1 })).toBeNull();
    expect(await createAnalyticPrimitive('prism' as never, {})).toBeNull();
    expect(invoker).not.toHaveBeenCalled();

    // Invalid/missing params: refused client-side, no sm_primitive round trip.
    const bad: Array<[string, Parameters<typeof createAnalyticPrimitive>[1]]> = [
      ['box missing h', { w: 10, d: 10 }],
      ['box zero w', { w: 0, h: 10, d: 10 }],
      ['box NaN d', { w: 10, h: 10, d: Number.NaN }],
      ['cylinder negative r', { r: -1, h: 10 }],
      ['sphere zero r', { r: 0 }],
      ['cone both radii 0', { rb: 0, rt: 0, h: 10 }],
      ['cone negative rt', { rb: 10, rt: -1, h: 10 }],
      ['torus minor > major', { R: 3, r: 10 }],
      ['torus missing R', { r: 3 }],
    ];
    for (const [label, params] of bad) {
      const kind = label.split(' ')[0] as Parameters<typeof createAnalyticPrimitive>[0];
      expect(await createAnalyticPrimitive(kind, params), label).toBeNull();
    }
    expect(invoker.mock.calls.filter(([cmd]) => cmd === 'sm_primitive')).toHaveLength(0);

    // Backend decline.
    __resetSmClientForTests();
    __setSmInvokerForTests(kernelInvoker({ primitive: { ok: false, error: 'kernel said no' } }));
    expect(await createAnalyticPrimitive('box', { w: 10, h: 10, d: 10 })).toBeNull();

    // Kernel unavailable (no invoker: jsdom transport rejects, cached).
    __resetSmClientForTests();
    expect(await createAnalyticPrimitive('sphere', { r: 10 })).toBeNull();
  });

  it('isSmAnalyticKind splits the 9 UI kinds', () => {
    for (const k of ['box', 'cylinder', 'sphere', 'cone', 'torus']) {
      expect(isSmAnalyticKind(k), k).toBe(true);
    }
    for (const k of ['wedge', 'prism', 'tube', 'coil']) {
      expect(isSmAnalyticKind(k), k).toBe(false);
    }
    expect(isSmAnalyticKind('hypercube')).toBe(false);
  });

  it('facade is re-exported from the geometry index', () => {
    expect(typeof createAnalyticViaIndex).toBe('function');
  });
});

describe('module surface', () => {
  it('is re-exported from the geometry index', () => {
    expect(typeof smStatusViaIndex).toBe('function');
    expect(typeof createViaIndex).toBe('function');
  });
});
