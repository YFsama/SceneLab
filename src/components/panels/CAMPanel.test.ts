import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CAMPanel } from './CAMPanel';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry/brep';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { defaultCamSetup, generateMultiToolGCode, getAllTools, getTool, clearCustomTools } from '../../lib/cam';
import { downloadFile } from '../../lib/io/studio3d';

// The panel is rendered for real (jsdom + createRoot + act, the project's
// mount-harness style). Only the two SIDE-EFFECTFUL leaves are mocked — the
// G-code post-processor (to assert the export call) and the file download —
// everything else (store actions, the real generator, detection) runs live.

vi.mock('../../lib/cam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam')>();
  return { ...actual, generateMultiToolGCode: vi.fn(actual.generateMultiToolGCode) };
});

vi.mock('../../lib/io/studio3d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/io/studio3d')>();
  return { ...actual, downloadFile: vi.fn() };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mount(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmount({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function buttonByTitle(container: HTMLElement, title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

function buttonById(container: HTMLElement, id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button#${id}`);
}

/** Change a controlled React number input the way a real user edit does. */
async function setNumberInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => (b.textContent ?? '').trim() === text) ?? null;
}

/** Change a controlled React select the way a real user pick does. */
async function chooseOption(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const params = {
  feedRate: 1000, plungeRate: 300, spindleSpeed: 10000,
  depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -10,
};

function seedBox(): ReturnType<typeof createBox> {
  const box = createBox(20, 15, 10);
  useStore.setState({
    bodies: [box], directBodies: [box], objectIds: [box.id],
    camSetup: defaultCamSetup(), camToolpaths: {},
    undoStack: [], redoStack: [], projectDirty: false,
  });
  return box;
}

describe('CAMPanel (rendered, store-driven)', () => {
  beforeEach(() => {
    clearToasts();
    vi.mocked(generateMultiToolGCode).mockClear();
    vi.mocked(downloadFile).mockClear();
    clearCustomTools();
    localStorage.removeItem('scenelab.customTools');
    seedBox();
  });

  it('renders the operations list and cached times from store state', async () => {
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket — Box', enabled: true, type: 'pocket', bodyId: box.id, toolId: 'em-6mm', params,
    });
    const m = await mount(createElement(CAMPanel));
    try {
      expect(m.container.textContent).toContain('Pocket — Box');
      expect(m.container.textContent).toContain(translations.en!['cam.minutes']!);
      // Stock + body selector + profile picker are present.
      expect(m.container.querySelector('#cam-stock-mode')).not.toBeNull();
      expect(m.container.querySelector('#cam-body-select')).not.toBeNull();
      expect(m.container.querySelector('#cam-profile-select')).not.toBeNull();
      // The cache drives the per-row time: a fresh (non-cached) copy would show '—'.
      const cache = useStore.getState().camToolpaths[id]!;
      expect(m.container.textContent).toContain(cache.timeMin.toFixed(1));
    } finally {
      await unmount(m);
    }
  });

  it('Generate adds a store operation for the SELECTED body with a cached toolpath', async () => {
    const boxA = useStore.getState().bodies[0]!;
    const boxB = createBox(8, 8, 8);
    useStore.setState({ bodies: [boxA, boxB], directBodies: [boxA, boxB], objectIds: [boxA.id, boxB.id] });

    const m = await mount(createElement(CAMPanel));
    try {
      const bodySelect = m.container.querySelector<HTMLSelectElement>('#cam-body-select')!;
      await chooseOption(bodySelect, boxB.id); // NOT bodies[0]
      await act(async () => { buttonByText(m.container, translations.en!['cam.generate']!)!.click(); });

      const ops = useStore.getState().camSetup.operations;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.bodyId).toBe(boxB.id);
      expect(ops[0]!.type).toBe('pocket');
      // Stock heights are SEEDED from the target body's bbox (the raw
      // 0/−10 defaults would plan below a body resting on the origin plane).
      expect(ops[0]!.params.stockTop).toBeCloseTo(8, 6);
      expect(ops[0]!.params.stockBottom).toBeCloseTo(0, 6);
      expect(useStore.getState().camToolpaths[ops[0]!.id]).toBeDefined();
      expect(getToasts().some((t) => t.message === translations.en!['cam.generated']!)).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('Remove drops the operation; the enabled checkbox patches it', async () => {
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Contour — Box', enabled: true, type: 'contour', bodyId: box.id, toolId: 'em-3mm', params,
    });

    const m = await mount(createElement(CAMPanel));
    try {
      // Disable via the row checkbox → cache dropped, op kept.
      const checkbox = m.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      await act(async () => {
        checkbox.click();
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // jsdom checkbox: set .checked then dispatch change like a real toggle.
      const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
      expect(op.enabled).toBe(false);
      expect(useStore.getState().camToolpaths[id]).toBeUndefined();

      // Remove → gone entirely.
      await act(async () => { buttonByTitle(m.container, translations.en!['cam.remove']!)!.click(); });
      expect(useStore.getState().camSetup.operations).toHaveLength(0);
    } finally {
      await unmount(m);
    }
  });

  it('Regenerate re-caches toolpaths through the store action', async () => {
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Face — Box', enabled: true, type: 'face', bodyId: box.id, toolId: 'em-6mm', params,
    });
    useStore.setState({ camToolpaths: {} }); // simulate a cold/lost cache

    const m = await mount(createElement(CAMPanel));
    try {
      // The mount auto-regenerate (stale-cache healing while the CAM
      // workspace is open) already re-cached the resolvable op — assert that
      // first, then the explicit button still works.
      expect(useStore.getState().camToolpaths[id]).toBeDefined();
      await act(async () => { buttonByTitle(m.container, translations.en!['cam.regenerate']!)!.click(); });
      const cache = useStore.getState().camToolpaths[id];
      expect(cache).toBeDefined();
      expect(cache!.toolpath.points.length).toBeGreaterThan(0);
    } finally {
      await unmount(m);
    }
  });

  it('Export posts the cached toolpaths through generateMultiToolGCode with the picked profile', async () => {
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket — Box', enabled: true, type: 'pocket', bodyId: box.id, toolId: 'em-6mm', params,
    });

    const m = await mount(createElement(CAMPanel));
    try {
      const profile = m.container.querySelector<HTMLSelectElement>('#cam-profile-select')!;
      await chooseOption(profile, 'linuxcnc');
      await act(async () => { buttonByText(m.container, translations.en!['cam.exportGCode']!)!.click(); });

      expect(generateMultiToolGCode).toHaveBeenCalledTimes(1);
      const [tps, machine] = vi.mocked(generateMultiToolGCode).mock.calls[0]! as unknown as [
        Array<{ id: string }>, string,
      ];
      expect(tps).toHaveLength(1);
      // The mount auto-regenerate may have re-cached (new toolpath id) — the
      // export must post whatever is CURRENTLY cached for the op.
      const current = useStore.getState().camToolpaths[id]!;
      expect(tps[0]!.id).toBe(current.toolpath.id);
      expect(machine).toBe('linuxcnc');
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(downloadFile).mock.calls[0]![1]).toBe('toolpath.nc');
      expect(vi.mocked(downloadFile).mock.calls[0]![0]).toContain('Profile: linuxcnc');
      expect(getToasts().some((t) => t.message === translations.en!['cam.gcodeExported']!)).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('Export with an UNRESOLVABLE op (dead bodyId) warns and never calls the post-processor', async () => {
    useStore.getState().addCamOperation({
      name: 'Pocket — Ghost', enabled: true, type: 'pocket', bodyId: 'body-gone', toolId: 'em-6mm', params,
    });
    useStore.setState({ camToolpaths: {} });

    const m = await mount(createElement(CAMPanel));
    try {
      await act(async () => { buttonByText(m.container, translations.en!['cam.exportGCode']!)!.click(); });
      expect(generateMultiToolGCode).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
      expect(getToasts().some((t) => t.message === translations.en!['cam.noToolpaths']!)).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('the stock margin input writes through to setCamStock', async () => {
    const m = await mount(createElement(CAMPanel));
    try {
      const margin = m.container.querySelector<HTMLInputElement>('#cam-stock-margin')!;
      expect(margin).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(margin, '6');
        margin.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(useStore.getState().camSetup.stock).toEqual({ mode: 'bounding-box', margin: 6 });
    } finally {
      await unmount(m);
    }
  });

  it('Generate seeds safeZAboveStock from the setup into the op params (review #10)', async () => {
    useStore.setState({ camSetup: { ...defaultCamSetup(), safeZAboveStock: 8 } });

    const m = await mount(createElement(CAMPanel));
    try {
      await act(async () => { buttonByText(m.container, translations.en!['cam.generate']!)!.click(); });
      const op = useStore.getState().camSetup.operations[0]!;
      expect(op.params.safeZAboveStock).toBe(8);
      // …and the generated toolpath actually traverses at stockTop + 8.
      const cache = useStore.getState().camToolpaths[op.id]!;
      const stockTop = op.params.stockTop;
      expect(Math.max(...cache.toolpath.points.map((p) => p.y))).toBeCloseTo(stockTop + 8, 6);
    } finally {
      await unmount(m);
    }
  });

  it('Sim transport dispatches scenelab:cam-sim events; per-row ▶ targets that op', async () => {
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket — Box', enabled: true, type: 'pocket', bodyId: box.id, toolId: 'em-6mm', params,
    });

    const details: Array<Record<string, unknown>> = [];
    const onSim = (e: Event) => details.push((e as CustomEvent).detail as Record<string, unknown>);
    window.addEventListener('scenelab:cam-sim', onSim);

    const m = await mount(createElement(CAMPanel));
    try {
      // Cached toolpath exists → transport enabled.
      expect(buttonById(m.container, 'cam-sim-play')!.disabled).toBe(false);
      expect(buttonById(m.container, 'cam-sim-pause')!.disabled).toBe(false);
      expect(buttonById(m.container, 'cam-sim-reset')!.disabled).toBe(false);

      await act(async () => { buttonById(m.container, 'cam-sim-play')!.click(); });
      await act(async () => { buttonById(m.container, 'cam-sim-pause')!.click(); });
      await act(async () => { buttonById(m.container, 'cam-sim-reset')!.click(); });
      // The per-row ▶ dispatches play WITH the op id (user-picked op).
      await act(async () => { buttonByTitle(m.container, translations.en!['cam.simulate']!)!.click(); });

      expect(details.map((d) => d.action)).toEqual(['play', 'pause', 'reset', 'play']);
      expect(details[3]!.opId).toBe(id);
      expect(details[0]!.opId).toBeUndefined(); // transport walks the first enabled op
    } finally {
      await unmount(m);
      window.removeEventListener('scenelab:cam-sim', onSim);
    }
  });

  it('Sim transport is disabled when no cached toolpath exists', async () => {
    useStore.getState().addCamOperation({
      name: 'Pocket — Ghost', enabled: true, type: 'pocket', bodyId: 'body-gone', toolId: 'em-6mm', params,
    });
    useStore.setState({ camToolpaths: {} });

    const m = await mount(createElement(CAMPanel));
    try {
      expect(buttonById(m.container, 'cam-sim-play')!.disabled).toBe(true);
      expect(buttonById(m.container, 'cam-sim-pause')!.disabled).toBe(true);
      expect(buttonById(m.container, 'cam-sim-reset')!.disabled).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('Tool library: Add duplicates the selected tool as an editable, persisted custom', async () => {
    const m = await mount(createElement(CAMPanel));
    try {
      const toolSelect = m.container.querySelector<HTMLSelectElement>('#cam-tool-select')!;
      await chooseOption(toolSelect, 'em-3mm'); // duplicate the 3 mm end mill

      // No editor for a DEFAULT tool.
      expect(m.container.querySelector('#cam-tool-diameter')).toBeNull();

      await act(async () => { buttonById(m.container, 'cam-add-tool')!.click(); });

      // The custom is selected and the editor appeared with its numbers.
      const sel = m.container.querySelector<HTMLSelectElement>('#cam-tool-select')!;
      const customId = sel.value;
      expect(customId).not.toBe('em-3mm');
      expect(getTool(customId)!.diameter).toBe(3);
      expect(m.container.querySelector<HTMLInputElement>('#cam-tool-diameter')!.value).toBe('3');
      expect(m.container.querySelector<HTMLInputElement>('#cam-tool-flutes')!.value).toBe('2');

      // Edit diameter → upsert into the (persisted) library, name follows.
      const dia = m.container.querySelector<HTMLInputElement>('#cam-tool-diameter')!;
      await setNumberInput(dia, '4.5');
      expect(getTool(customId)!.diameter).toBe(4.5);
      expect(getTool(customId)!.name).toBe('⌀4.5 Z2');
      const raw = localStorage.getItem('scenelab.customTools')!;
      expect(raw).toContain(customId);
      expect(raw).toContain('4.5');

      // Remove → gone, selection falls back to a default.
      await act(async () => { buttonById(m.container, 'cam-tool-remove')!.click(); });
      expect(getTool(customId)).toBeUndefined();
      expect(m.container.querySelector<HTMLSelectElement>('#cam-tool-select')!.value).toBe('em-6mm');
      expect(m.container.querySelector('#cam-tool-diameter')).toBeNull();
    } finally {
      clearCustomTools();
      await unmount(m);
    }
  });

  it('renders custom tools from the library (reload persistence is lib-level)', async () => {
    // Seeded through the real API — exactly the in-memory + storage state a
    // previous session leaves behind (the boot round-trip itself is covered
    // in toolLibrary.test.ts).
    const { addCustomTool } = await import('../../lib/cam');
    addCustomTool({
      id: 'tool-prev', name: '⌀8 Z4', type: 'endmill',
      diameter: 8, fluteLength: 25, overallLength: 70, flutes: 4, material: 'carbide',
    });

    const m = await mount(createElement(CAMPanel));
    try {
      const options = [...m.container.querySelectorAll<HTMLSelectElement>('#cam-tool-select option')];
      const custom = options.find((o) => o.value === 'tool-prev');
      expect(custom).toBeDefined();
      expect(custom!.textContent).toContain('⌀8 Z4');
      // The default library is still intact.
      expect(options.some((o) => o.value === 'em-6mm')).toBe(true);
      expect(getAllTools().some((tl) => tl.id === 'tool-prev')).toBe(true);
    } finally {
      clearCustomTools();
      await unmount(m);
    }
  });

  it('a drill op on an UNDRILLED body stays uncached and shows the stale flag — no crash', async () => {
    // The old generator silently drilled the body centre; now it throws
    // inside resolveCamToolpath's try/catch → no cache → the stale hint.
    const box = useStore.getState().bodies[0]!;
    const id = useStore.getState().addCamOperation({
      name: 'Drill — Box', enabled: true, type: 'drill', bodyId: box.id, toolId: 'drill-3mm', params,
    });
    expect(useStore.getState().camToolpaths[id]).toBeUndefined();

    const m = await mount(createElement(CAMPanel));
    try {
      expect(m.container.textContent).toContain(translations.en!['cam.stale']!);
    } finally {
      await unmount(m);
    }
  });

  // --- Regen throttling (perf pass #31) ---------------------------------------
  // The effect used to re-run the whole toolpath pipeline synchronously on
  // EVERY featureVersion bump. These tests pin the two guards: a 200 ms
  // trailing debounce (burst → one regen) and the input fingerprint (no
  // change → zero regens). Regen calls are counted by observing the ONLY
  // store mutation regenerateCamToolpaths makes: a fresh camToolpaths object.
  describe('regen throttling', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function countRegens(): { get: () => number; stop: () => void } {
      let count = 0;
      const stop = useStore.subscribe((s, prev) => {
        if (s.camToolpaths !== prev.camToolpaths) count++;
      });
      return { get: () => count, stop };
    }

    async function seedOp(): Promise<string> {
      const box = useStore.getState().bodies[0]!;
      const id = useStore.getState().addCamOperation({
        name: 'Pocket — Box', enabled: true, type: 'pocket', bodyId: box.id, toolId: 'em-6mm', params,
      });
      useStore.setState({ camToolpaths: {} }); // cold cache → mount must heal
      return id;
    }

    async function bumpFeatureVersion(): Promise<void> {
      await act(async () => {
        useStore.setState((s) => ({ featureVersion: s.featureVersion + 1 }));
      });
    }

    it('rapid featureVersion bumps coalesce into ONE debounced regenerate', async () => {
      vi.useFakeTimers();
      await seedOp();
      const regens = countRegens();
      const m = await mount(createElement(CAMPanel)); // cold-cache heal: +1
      try {
        expect(regens.get()).toBe(1);
        // A real editing burst: every tree edit recompute ROTATES the body
        // objects (ids included), so each bump genuinely moves the ops'
        // inputs — a regen is due, but only ONE for the whole burst.
        for (let i = 0; i < 5; i++) {
          await act(async () => {
            useStore.setState((s) => ({
              featureVersion: s.featureVersion + 1,
              bodies: [createBox(20, 15, 10)],
            }));
          });
        }
        expect(regens.get()).toBe(1); // nothing fired mid-burst
        await act(async () => { vi.advanceTimersByTime(199); });
        expect(regens.get()).toBe(1); // still inside the window
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(regens.get()).toBe(2); // exactly one regen for the burst
      } finally {
        regens.stop();
        await unmount(m);
      }
    });

    it('skips the regen entirely when no op input changed (same body reference)', async () => {
      vi.useFakeTimers();
      await seedOp();
      const regens = countRegens();
      const m = await mount(createElement(CAMPanel));
      try {
        expect(regens.get()).toBe(1);
        // A featureVersion bump that left the ops' bodies untouched (sketch
        // edit far from the solid, direct-body move, …): the fingerprint
        // matches and the cache is complete → no work at all.
        await bumpFeatureVersion();
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(regens.get()).toBe(1);
        const op = useStore.getState().camSetup.operations[0]!;
        expect(useStore.getState().camToolpaths[op.id]).toBeDefined();
      } finally {
        regens.stop();
        await unmount(m);
      }
    });

    it('still regenerates when the resolved body actually changed (rotated ids)', async () => {
      vi.useFakeTimers();
      const id = await seedOp();
      const regens = countRegens();
      const m = await mount(createElement(CAMPanel));
      try {
        expect(regens.get()).toBe(1);
        // Simulate a tree recompute: fresh body objects with fresh ids — the
        // op's bodyId now dangles, the fingerprint moved → one regen, and it
        // DROPS the dead op's cache instead of leaving a stale entry.
        const rotated = createBox(20, 15, 10);
        await act(async () => {
          useStore.setState((s) => ({ bodies: [rotated], featureVersion: s.featureVersion + 1 }));
        });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(regens.get()).toBe(2);
        expect(useStore.getState().camToolpaths[id]).toBeUndefined();
      } finally {
        regens.stop();
        await unmount(m);
      }
    });

    it('heals a LOST cache even when the fingerprint is unchanged', async () => {
      vi.useFakeTimers();
      await seedOp();
      const regens = countRegens();
      const m = await mount(createElement(CAMPanel));
      try {
        expect(regens.get()).toBe(1);
        // Someone wiped the cache out from under the setup (undo snapshot of
        // an older cache) without touching op inputs: completeness alone
        // must trigger the rebuild. (The wipe itself swaps the camToolpaths
        // reference, so compare relative to the post-wipe count.)
        await act(async () => {
          useStore.setState((s) => ({ camToolpaths: {}, featureVersion: s.featureVersion + 1 }));
        });
        const afterWipe = regens.get();
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(regens.get()).toBe(afterWipe + 1);
        const op = useStore.getState().camSetup.operations[0]!;
        expect(useStore.getState().camToolpaths[op.id]).toBeDefined();
      } finally {
        regens.stop();
        await unmount(m);
      }
    });
  });
});
