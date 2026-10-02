import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { createSketch, addLine } from '../../lib/sketch/engine';
import { createBox, translateBody, type SolidBody } from '../../lib/geometry';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { ViewportCanvas } from './ViewportCanvas';

// ViewportCanvas is a WebGL component; jsdom has neither WebGL nor a canvas
// rasterizer. Mount the REAL component with only the two GPU-bound classes
// faked (WebGLRenderer, OrbitControls) — everything else (scene graph, raycast
// picking, menu construction) is plain math and DOM and runs for real. The
// right-click → ContextMenu flow below is therefore the true component path.

vi.mock('three', async (importOriginal: () => Promise<typeof import('three')>) => {
  const actual = await importOriginal();
  class FakeWebGLRenderer {
    readonly domElement = document.createElement('canvas');
    outputColorSpace = '';
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    clippingPlanes: unknown[] = [];
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer } as unknown as typeof import('three');
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  /** Minimal stand-in: update() re-aims the camera at the target like the real one. */
  class FakeOrbitControls {
    target = new Vector3();
    object: unknown = null;
    enableRotate = true;
    enableDamping = false;
    dampingFactor = 0;
    screenSpacePanning = false;
    zoomToCursor = false;
    mouseButtons: unknown = {};
    update() {
      (this.object as { lookAt?: (t: unknown) => void } | null)?.lookAt?.(this.target);
      return false;
    }
    dispose() {}
    addEventListener() {}
    removeEventListener() {}
  }
  return { OrbitControls: FakeOrbitControls };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks ResizeObserver.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Canvas 2D contexts are null in jsdom — makeTextSprite would crash on the
// axis-gnomon labels. A no-op context is enough (sprites never upload).
const fake2d = {
  font: '',
  textBaseline: '',
  fillStyle: '',
  textAlign: '',
  measureText: () => ({ width: 8 }),
  fillText() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  setLineDash() {},
  save() {},
  restore() {},
  clip() {},
  arc() {},
  strokeRect() {},
};
const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
const realGetContext = canvasProto.getContext as (this: HTMLCanvasElement, type: string) => unknown;
canvasProto.getContext = function (this: HTMLCanvasElement, type: string) {
  if (type === '2d') return fake2d;
  return realGetContext.call(this, type);
};

// Elements report 0×0 in jsdom — a 0/0 camera aspect (NaN) breaks raycast
// picking, so give every element a sane viewport size. Mouse math uses
// getBoundingClientRect, which the tests override per element.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 400, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 300, configurable: true });

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

/** The viewport's interactive div (the one with onContextMenu). */
function viewportDiv(container: HTMLElement): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>('div[role="img"]');
  expect(el).not.toBeNull();
  return el!;
}

/** Menu labels ('▸' is the flyout affordance rendered inside the button). */
function menuLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .map((b) => (b.textContent ?? '').replace('▸', '').trim());
}

function menuButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((b) => (b.textContent ?? '').replace('▸', '').trim() === label) ?? null;
}

function fakeRect(): DOMRect {
  return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

async function openSketchMenu(m: Mounted) {
  const viewport = viewportDiv(m.container);
  viewport.getBoundingClientRect = fakeRect;
  await act(async () => {
    viewport.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

/** Two coincident boxes under a top view: the centre ray hits the top face. */
function twoSelectedBodies(): [SolidBody, SolidBody] {
  const b1 = createBox(4, 4, 4);
  const b2 = translateBody(createBox(4, 4, 4), { x: 0, y: 0, z: 0 }, 'Box 2');
  return [b1, b2];
}

async function openBodyMenu(m: Mounted) {
  const viewport = viewportDiv(m.container);
  viewport.getBoundingClientRect = fakeRect;
  await act(async () => {
    viewport.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  });
}

function toastMessages(): string[] {
  return getToasts().map((x) => x.message);
}

beforeEach(() => {
  clearToasts();
  useStore.setState({
    locale: 'en',
    workspace: 'model',
    sketchActive: false,
    sketchTool: 'select',
    sketchPlaneId: 'xy',
    currentSketch: null,
    selectedSketchId: null,
    selectedSketchIds: [],
    bodies: [],
    selectedIds: [],
    selectedEdgeIds: [],
    selectedFaceIds: [],
    hiddenIds: [],
    annotations: [],
    viewDirection: 'iso',
    projection: 'perspective',
    measureActive: false,
    visionSelectActive: false,
    numericPrompt: null,
  });
});

describe('ViewportCanvas sketch context menu (rendered)', () => {
  it('builds exactly ONE Add Constraint submenu for a two-line selection', async () => {
    const sketch = createSketch('xy');
    const l1 = addLine(sketch, 0, 0, 10, 0);
    const l2 = addLine(sketch, 0, 5, 10, 5);
    useStore.setState({ sketchActive: true, currentSketch: sketch });

    const m = await mount(createElement(ViewportCanvas));
    try {
      await openSketchMenu(m);
      // Right-clicking empty sketch space clears the single selection —
      // restore the two-line pair; the open menu rebuilds from the store.
      await act(async () => {
        useStore.setState({ selectedSketchId: l1.id, selectedSketchIds: [l1.id, l2.id] });
      });

      const addConstraint = translations.en!['sketch.addConstraint']!;
      const labels = menuLabels(m.container);
      expect(labels.filter((x) => x === addConstraint)).toHaveLength(1);

      // Opening the surviving submenu offers the two-line constraints.
      await act(async () => {
        menuButton(m.container, addConstraint)!.click();
      });
      const open = menuLabels(m.container);
      expect(open).toContain(translations.en!['constraint.parallel']!);
      expect(open).toContain(translations.en!['constraint.perpendicular']!);
    } finally {
      await unmount(m);
    }
  });

  it('shows the constraint submenu once in the zh locale too', async () => {
    const sketch = createSketch('xy');
    const l1 = addLine(sketch, 0, 0, 10, 0);
    const l2 = addLine(sketch, 0, 5, 10, 5);
    useStore.setState({ locale: 'zh', sketchActive: true, currentSketch: sketch });

    const m = await mount(createElement(ViewportCanvas));
    try {
      await openSketchMenu(m);
      await act(async () => {
        useStore.setState({ selectedSketchId: l1.id, selectedSketchIds: [l1.id, l2.id] });
      });
      const addConstraint = translations.zh!['sketch.addConstraint']!;
      expect(menuLabels(m.container).filter((x) => x === addConstraint)).toHaveLength(1);
    } finally {
      await unmount(m);
      useStore.setState({ locale: 'en' });
    }
  });
});

describe('ViewportCanvas body context menu — parametric arrays (rendered)', () => {
  it('Linear array › X chains count → spacing prompts into applyLinearArrayFeature', async () => {
    const applyLinear = vi.fn(() => true);
    const [b1, b2] = twoSelectedBodies();
    useStore.setState({ bodies: [b1, b2], selectedIds: [b1.id, b2.id], viewDirection: 'top', applyLinearArrayFeature: applyLinear });

    const m = await mount(createElement(ViewportCanvas));
    try {
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.feature']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['feature.linearArray']!)!.click(); });
      await act(async () => { menuButton(m.container, 'X')!.click(); });

      let prompt = useStore.getState().numericPrompt;
      expect(prompt).not.toBeNull();
      expect(prompt!.titleKey).toBe('feature.linearArray');
      expect(prompt!.labelKey).toBe('pattern.count');
      expect(prompt!.initial).toBe(3);
      expect(prompt!.min).toBe(1);

      await act(async () => { prompt!.onApply(4); });
      prompt = useStore.getState().numericPrompt;
      expect(prompt!.labelKey).toBe('pattern.spacing');
      expect(prompt!.titleKey).toBe('feature.linearArray');
      expect(prompt!.initial).toBe(10);
      expect(prompt!.min).toBe(0.01);

      await act(async () => { prompt!.onApply(12.5); });
      expect(applyLinear).toHaveBeenCalledTimes(1);
      expect(applyLinear).toHaveBeenCalledWith(4, 12.5, 'x');
      expect(toastMessages()).toContain(translations.en!['toast.featureApplied']!);
    } finally {
      await unmount(m);
    }
  });

  it('warns with toast.featureNeedsBody when the array feature is refused', async () => {
    const applyLinear = vi.fn(() => false);
    const [b1, b2] = twoSelectedBodies();
    useStore.setState({ bodies: [b1, b2], selectedIds: [b1.id, b2.id], viewDirection: 'top', applyLinearArrayFeature: applyLinear });

    const m = await mount(createElement(ViewportCanvas));
    try {
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.feature']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['feature.linearArray']!)!.click(); });
      await act(async () => { menuButton(m.container, 'Y')!.click(); });
      await act(async () => { useStore.getState().numericPrompt!.onApply(3); });
      await act(async () => { useStore.getState().numericPrompt!.onApply(10); });
      expect(applyLinear).toHaveBeenCalledWith(3, 10, 'y');
      expect(toastMessages()).toContain(translations.en!['toast.featureNeedsBody']!);
    } finally {
      await unmount(m);
    }
  });

  it('Circular array prompts count into applyCircularArrayFeature', async () => {
    const applyCircular = vi.fn(() => true);
    const [b1, b2] = twoSelectedBodies();
    useStore.setState({ bodies: [b1, b2], selectedIds: [b1.id, b2.id], viewDirection: 'top', applyCircularArrayFeature: applyCircular });

    const m = await mount(createElement(ViewportCanvas));
    try {
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.feature']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['feature.circularArray']!)!.click(); });

      const prompt = useStore.getState().numericPrompt;
      expect(prompt).not.toBeNull();
      expect(prompt!.titleKey).toBe('feature.circularArray');
      expect(prompt!.labelKey).toBe('pattern.count');
      expect(prompt!.initial).toBe(6);
      expect(prompt!.min).toBe(1);

      await act(async () => { prompt!.onApply(8); });
      expect(applyCircular).toHaveBeenCalledWith(8);
      expect(toastMessages()).toContain(translations.en!['toast.featureApplied']!);
    } finally {
      await unmount(m);
    }
  });
});

describe('ViewportCanvas combine menu (rendered)', () => {
  it('toasts toast.combineFailed on a null result and on rejection; stays quiet on success', async () => {
    const combine = vi.fn<(op: 'union' | 'difference' | 'intersect') => Promise<string | null>>(async () => null);
    const [b1, b2] = twoSelectedBodies();
    useStore.setState({ bodies: [b1, b2], selectedIds: [b1.id, b2.id], viewDirection: 'top', combineSelected: combine });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const failed = translations.en!['toast.combineFailed']!;

      // null result → warning toast.
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.combine']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['menu.union']!)!.click(); });
      expect(combine).toHaveBeenCalledWith('union');
      expect(toastMessages()).toContain(failed);

      // Rejected promise → same warning toast (the store guards, but be safe).
      combine.mockImplementation(async () => { throw new Error('boom'); });
      clearToasts();
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.combine']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['menu.subtract']!)!.click(); });
      expect(combine).toHaveBeenCalledWith('difference');
      expect(toastMessages()).toContain(failed);

      // Success returns the new body id — selection visibly changes, no toast.
      combine.mockImplementation(async () => 'body_new');
      clearToasts();
      await openBodyMenu(m);
      await act(async () => { menuButton(m.container, translations.en!['menu.combine']!)!.click(); });
      await act(async () => { menuButton(m.container, translations.en!['menu.intersect']!)!.click(); });
      expect(combine).toHaveBeenCalledWith('intersect');
      expect(toastMessages()).toEqual([]);
    } finally {
      await unmount(m);
    }
  });
});
