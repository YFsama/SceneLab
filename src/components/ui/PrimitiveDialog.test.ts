import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore, type PrimitiveKind } from '../../store/app';
import { PrimitiveDialog, buildAnalyticBody, parseDialogValues, SPECS } from './PrimitiveDialog';
import { createBox } from '../../lib/geometry/brep';
import { isSmAnalyticKind, __setSmInvokerForTests, __resetSmClientForTests } from '../../lib/geometry/smClient';

// PrimitiveDialog is a React component — test the validation logic directly.

describe('PrimitiveDialog validation', () => {
  const validatePositive = (value: string): boolean => {
    const v = parseFloat(value);
    return Number.isFinite(v) && v > 0;
  };

  const validateNonNegative = (value: string): boolean => {
    const v = parseFloat(value);
    return Number.isFinite(v) && v >= 0;
  };

  describe('positive validation (width, height, depth, radius)', () => {
    it('accepts positive numbers', () => {
      expect(validatePositive('10')).toBe(true);
      expect(validatePositive('0.5')).toBe(true);
      expect(validatePositive('100')).toBe(true);
    });

    it('rejects zero', () => {
      expect(validatePositive('0')).toBe(false);
    });

    it('rejects negative', () => {
      expect(validatePositive('-5')).toBe(false);
    });

    it('rejects non-numeric', () => {
      expect(validatePositive('abc')).toBe(false);
      expect(validatePositive('')).toBe(false);
    });
  });

  describe('non-negative validation (top radius of cone)', () => {
    it('accepts zero', () => {
      expect(validateNonNegative('0')).toBe(true);
    });

    it('accepts positive', () => {
      expect(validateNonNegative('5')).toBe(true);
    });

    it('rejects negative', () => {
      expect(validateNonNegative('-1')).toBe(false);
    });
  });

  describe('primitive kind fields', () => {
    const SPECS: Record<PrimitiveKind, { fieldCount: number }> = {
      box: { fieldCount: 3 },
      cylinder: { fieldCount: 2 },
      sphere: { fieldCount: 1 },
      cone: { fieldCount: 3 },
      torus: { fieldCount: 2 },
      wedge: { fieldCount: 3 },
      prism: { fieldCount: 3 },
      tube: { fieldCount: 3 },
      coil: { fieldCount: 4 },
    };

    it('box has 3 fields (width, height, depth)', () => {
      expect(SPECS.box.fieldCount).toBe(3);
    });

    it('cylinder has 2 fields (radius, height)', () => {
      expect(SPECS.cylinder.fieldCount).toBe(2);
    });

    it('sphere has 1 field (radius)', () => {
      expect(SPECS.sphere.fieldCount).toBe(1);
    });

    it('cone has 3 fields (bottom radius, top radius, height)', () => {
      expect(SPECS.cone.fieldCount).toBe(3);
    });

    it('torus has 2 fields (ring radius, tube radius)', () => {
      expect(SPECS.torus.fieldCount).toBe(2);
    });

    it('wedge has 3 fields', () => {
      expect(SPECS.wedge.fieldCount).toBe(3);
    });

    it('prism has 3 fields', () => {
      expect(SPECS.prism.fieldCount).toBe(3);
    });

    it('tube has 3 fields', () => {
      expect(SPECS.tube.fieldCount).toBe(3);
    });

    it('coil has 4 fields', () => {
      expect(SPECS.coil.fieldCount).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// SMLib wiring (P3 v1.5): the 5 analytic kinds go through the kernel facade
// when it is available and fall back to the identical brep constructor when
// it is not. wedge/prism/tube/coil never touch the facade.
// ---------------------------------------------------------------------------

/** 10 mm cube mesh in kernel wire form (what a happy sm_primitive answers). */
const kernelCube = {
  vertices: [
    [-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5],
    [-5, 10, -5], [5, 10, -5], [5, 10, 5], [-5, 10, 5],
  ] as [number, number, number][],
  faces: [
    { vertices: [0, 1, 2, 3], normal: [0, -1, 0] },
    { vertices: [4, 7, 6, 5], normal: [0, 1, 0] },
    { vertices: [0, 4, 5, 1], normal: [0, 0, -1] },
    { vertices: [3, 2, 6, 7], normal: [0, 0, 1] },
    { vertices: [0, 3, 7, 4], normal: [-1, 0, 0] },
    { vertices: [1, 5, 6, 2], normal: [1, 0, 0] },
  ],
};

describe('PrimitiveDialog SMLib wiring', () => {
  beforeEach(() => {
    __resetSmClientForTests();
  });

  afterEach(() => {
    __resetSmClientForTests();
  });

  it('only the 5 analytic kinds are routed to the kernel', () => {
    const analytic: PrimitiveKind[] = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
    const brepOnly: PrimitiveKind[] = ['wedge', 'prism', 'tube', 'coil'];
    for (const k of analytic) expect(isSmAnalyticKind(k), k).toBe(true);
    for (const k of brepOnly) expect(isSmAnalyticKind(k), k).toBe(false);
  });

  it('parseDialogValues: per-field minimums + the torus cross-field rule', () => {
    // Historical per-field behaviour: plain invalid input fails SILENTLY.
    expect(parseDialogValues('box', SPECS.box, { w: '10', h: '0', d: '10' })).toEqual({ ok: false });
    expect(parseDialogValues('box', SPECS.box, { w: 'abc', h: '10', d: '10' })).toEqual({ ok: false });
    expect(parseDialogValues('cone', SPECS.cone, { rb: '10', rt: '-1', h: '20' })).toEqual({ ok: false });
    // Cross-field torus rule: r > R would make brep createTorus throw — it is
    // blocked here WITH a message key; r == R is legal (degenerate horn edge
    // both constructors accept).
    expect(parseDialogValues('torus', SPECS.torus, { R: '3', r: '10' }))
      .toEqual({ ok: false, errorKey: 'sm.torusRangeError' });
    expect(parseDialogValues('torus', SPECS.torus, { R: '10', r: '10' }).ok).toBe(true);
    expect(parseDialogValues('torus', SPECS.torus, { R: '10', r: '3' }))
      .toEqual({ ok: true, nums: { R: 10, r: 3 } });
    // Sanity: valid inputs of every other kind parse unchanged.
    expect(parseDialogValues('box', SPECS.box, { w: '20', h: '20', d: '20' }).ok).toBe(true);
    expect(parseDialogValues('cone', SPECS.cone, { rb: '10', rt: '0', h: '20' }).ok).toBe(true);
    expect(parseDialogValues('wedge', SPECS.wedge, { w: '1', h: '1', d: '1' }).ok).toBe(true);
  });

  it('kernel available: buildAnalyticBody returns the SMLib body and never calls the brep constructor', async () => {
    __setSmInvokerForTests(vi.fn(async (cmd: string) => {
      if (cmd === 'sm_status') return { available: true, version: 'smmesh-test' };
      if (cmd === 'sm_primitive') return { ok: true, body: kernelCube, brepVolumeMm3: 1000 };
      throw new Error(`unexpected ${cmd}`);
    }));
    const build = vi.fn(() => { throw new Error('brep fallback must not run when the kernel answers'); });
    const body = await buildAnalyticBody('box', { fields: SPECS.box.fields, build }, { w: 10, h: 10, d: 10 });
    expect(body.id).toMatch(/^body_sm_\d+$/);
    expect(body.name).toBe('SM Box');
    expect(body.faces).toHaveLength(6);
    expect(build).not.toHaveBeenCalled();
  });

  it('kernel unavailable: the fallback is byte-identical to the current brep path', async () => {
    // No invoker → jsdom transport rejects → facade returns null → the SAME
    // spec.build(nums) call the dialog has always made must be used verbatim.
    const sentinel = createBox(20, 20, 20);
    const build = vi.fn(() => sentinel);
    const nums = { w: 20, h: 20, d: 20 };
    const body = await buildAnalyticBody('box', { fields: SPECS.box.fields, build }, nums);
    expect(body).toBe(sentinel); // identical reference: no rewrap, no copy
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(nums); // same args as the pre-SMLib path
  });

  it('real SPECS fallback output equals today\'s constructor output (geometry + name)', async () => {
    // jsdom: kernel unavailable → buildAnalyticBody must produce exactly what
    // the dialog produced before SMLib existed. genId counters differ between
    // two createBox calls, so compare everything except generated ids.
    const body = await buildAnalyticBody('box', SPECS.box, { w: 20, h: 20, d: 20 });
    const today = createBox(20, 20, 20);
    expect(body.name).toBe(today.name);
    expect(body.vertices).toEqual(today.vertices);
    expect(body.faces.map((f) => ({ n: f.normal, v: f.vertices })))
      .toEqual(today.faces.map((f) => ({ n: f.normal, v: f.vertices })));
  });
});

// ---------------------------------------------------------------------------
// Confirm lifecycle (rendered dialog): the async SMLib path must not deadlock
// the dialog (P1) and must honour a cancel during the IPC window (P2).
// Mount harness mirrors ExtrudeDialog.test.ts (no testing-library in project).
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted { container: HTMLDivElement; root: Root }

async function mountDialog(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(component); });
  return { container, root };
}

async function unmountDialog({ container, root }: Mounted): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttons(container: HTMLElement): { cancel: HTMLButtonElement; apply: HTMLButtonElement } {
  const all = container.querySelectorAll('button');
  return { cancel: all[0] as HTMLButtonElement, apply: all[all.length - 1] as HTMLButtonElement };
}

describe('PrimitiveDialog confirm lifecycle (rendered)', () => {
  beforeEach(() => {
    __resetSmClientForTests();
    useStore.setState({
      pendingPrimitive: null,
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      lastPrimitiveParams: {},
      currentSketch: null,
      sketchActive: false,
    });
  });

  afterEach(() => {
    __resetSmClientForTests();
  });

  it('P1: torus r > R is rejected up front — no stuck busy, no body, visible error', async () => {
    // Kernel available, so the facade is genuinely tried: the regression is
    // that the facade declines (null) and the brep createTorus(3,10) THROWS,
    // which used to leave busy=true forever (unhandled rejection).
    __setSmInvokerForTests(vi.fn(async (cmd: string) => {
      if (cmd === 'sm_status') return { available: true, version: 'smmesh-test' };
      if (cmd === 'sm_primitive') return { ok: true, body: kernelCube, brepVolumeMm3: 1000 };
      throw new Error(`unexpected ${cmd}`);
    }));
    useStore.setState({ pendingPrimitive: 'torus' });
    const m = await mountDialog(createElement(PrimitiveDialog));
    try {
      const inputs = m.container.querySelectorAll('input');
      expect(inputs.length).toBe(2); // R, r
      await typeInto(inputs[0]!, '3'); // ring radius R
      await typeInto(inputs[1]!, '10'); // tube radius r — r > R, invalid
      await act(async () => { buttons(m.container).apply.click(); });
      // Let every pending microtask (facade attempt, any rejection) settle.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      expect(useStore.getState().directBodies).toHaveLength(0); // nothing inserted
      expect(useStore.getState().pendingPrimitive).toBe('torus'); // dialog still open
      // The cross-field error is surfaced (en locale default).
      expect(m.container.textContent).toContain('Tube radius must not exceed ring radius');
      // busy must not be stuck: both buttons usable again.
      expect(buttons(m.container).apply.disabled).toBe(false);
      expect(buttons(m.container).cancel.disabled).toBe(false);
    } finally {
      await unmountDialog(m);
    }
  });

  it('P2: Escape during the SMLib IPC window discards the result (cancel works)', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => { release = res; });
    __setSmInvokerForTests(vi.fn(async (cmd: string) => {
      if (cmd === 'sm_status') return { available: true, version: 'smmesh-test' };
      if (cmd === 'sm_primitive') return gate; // hold the round trip open
      throw new Error(`unexpected ${cmd}`);
    }));
    useStore.setState({ pendingPrimitive: 'box' });
    const m = await mountDialog(createElement(PrimitiveDialog));
    try {
      await act(async () => { buttons(m.container).apply.click(); });
      // IPC in flight: confirm locked AND cancel locked (one cancel story).
      expect(buttons(m.container).apply.disabled).toBe(true);
      expect(buttons(m.container).cancel.disabled).toBe(true);

      // Escape mid-flight closes the dialog (useEscapeClose → window keydown).
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(useStore.getState().pendingPrimitive).toBeNull();

      // The kernel answers AFTER the cancel: the body must be discarded.
      await act(async () => {
        release({ ok: true, body: kernelCube, brepVolumeMm3: 1000 });
        await Promise.resolve();
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      expect(useStore.getState().directBodies).toHaveLength(0);
      expect(useStore.getState().lastPrimitiveParams.box).toBeUndefined(); // remember skipped
      expect(useStore.getState().selectedIds).toEqual([]); // select skipped
    } finally {
      await unmountDialog(m);
    }
  });
});
