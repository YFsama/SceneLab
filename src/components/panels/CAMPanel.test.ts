import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CAMPanel } from './CAMPanel';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry/brep';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { defaultCamSetup, generateMultiToolGCode } from '../../lib/cam';
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
});
