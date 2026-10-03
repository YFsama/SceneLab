import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
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

// Click-click drawing (F7): every commercial sketcher's primary interaction.
// The real render loop keeps the camera's matrixWorld fresh before pointer
// events fire; the fake renderer never calls updateMatrixWorld, so refresh it
// inside setFromCamera for these gesture tests (afterwards the raycast is the
// same pure math production uses).
describe('ViewportCanvas click-click drawing (rendered)', () => {
  type SetFromCamera = (this: THREE.Raycaster, coords: THREE.Vector2, camera: THREE.Camera) => void;
  const raycasterProto = THREE.Raycaster.prototype as unknown as { setFromCamera: SetFromCamera };
  const originalSetFromCamera: SetFromCamera = raycasterProto.setFromCamera;

  beforeAll(() => {
    raycasterProto.setFromCamera = function (coords, camera) {
      camera.updateMatrixWorld();
      originalSetFromCamera.call(this, coords, camera);
    };
  });
  afterAll(() => {
    raycasterProto.setFromCamera = originalSetFromCamera;
  });

  beforeEach(() => {
    clearToasts();
    useStore.setState({
      locale: 'en',
      workspace: 'sketch',
      sketchActive: true,
      sketchTool: 'line',
      sketchPlaneId: 'xy',
      currentSketch: createSketch('xy'),
      selectedSketchId: null,
      selectedSketchIds: [],
      bodies: [],
      selectedIds: [],
      drawStart: null,
      polylineLast: null,
    });
  });

  function mouse(type: 'mousedown' | 'mouseup', x: number, y: number): MouseEvent {
    return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  }

  function linesInState(): number {
    const sketch = useStore.getState().currentSketch!;
    return [...sketch.entities.values()].filter((e) => e.type === 'line').length;
  }

  it('first press arms, its own release keeps the draw armed, second press commits', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      // Click 1: press arms the start point…
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      const armed = useStore.getState().drawStart;
      expect(armed).not.toBeNull();
      // …and its own (motionless) release KEEPS it armed — clearing it here is
      // exactly what used to make click-click silently do nothing.
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 25, 50)); });
      expect(useStore.getState().drawStart).toEqual(armed);
      expect(linesInState()).toBe(0);

      // Click 2 at a different point: the press itself commits the line.
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 75, 50)); });
      expect(linesInState()).toBe(1);
      expect(useStore.getState().drawStart).toBeNull();
      // The trailing release must not commit anything more.
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 75, 50)); });
      expect(linesInState()).toBe(1);
    } finally {
      await unmount(m);
    }
  });

  it('press-drag-release still commits exactly one entity and re-arms fresh', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      expect(useStore.getState().drawStart).not.toBeNull();
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 75, 50)); });
      expect(linesInState()).toBe(1);
      expect(useStore.getState().drawStart).toBeNull();

      // A second drag draws a second line from the new start.
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 75, 90)); });
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 25, 90)); });
      expect(linesInState()).toBe(2);
    } finally {
      await unmount(m);
    }
  });

  it('a zero-size second press commits nothing and stays armed (no junk entities)', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 25, 50)); });
      // Second press at the SAME point: refused, draw still armed.
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      expect(linesInState()).toBe(0);
      expect(useStore.getState().drawStart).not.toBeNull();
    } finally {
      await unmount(m);
    }
  });

  it('a start armed by another tool is discarded and re-armed fresh (P2 #7)', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      // Arm a LINE at the first point (press + stationary release)…
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 25, 50)); });
      const armed = useStore.getState().drawStart;
      expect(armed).not.toBeNull();

      // …then switch tools. setSketchTool does NOT clear drawStart, so the
      // stale line start survives — the next press must NOT commit a rect
      // from the OLD point.
      await act(async () => { useStore.getState().setSketchTool('rect'); });
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 75, 60)); });
      // The stale start was discarded at the press: nothing committed yet
      // (the unfixed code would have committed a rect from the line's start).
      expect([...useStore.getState().currentSketch!.entities.values()].filter((e) => e.type === 'line')).toHaveLength(0);
      expect(useStore.getState().drawStart).not.toBeNull();
      // The press re-armed FRESH under the rect tool…
      expect(useStore.getState().drawStart).not.toEqual(armed);
      // …so the drag's release commits exactly one rect from the new start.
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 95, 90)); });
      const entities = [...useStore.getState().currentSketch!.entities.values()];
      expect(entities.filter((e) => e.type === 'line')).toHaveLength(4); // rect = 4 lines
    } finally {
      await unmount(m);
    }
  });

  it('a middle-button press (orbit) does not re-arm the draw start', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      // Arm a line at the first point…
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 25, 50)); });
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 25, 50)); });
      const armed = useStore.getState().drawStart;
      expect(armed).not.toBeNull();

      // A middle press (orbit) elsewhere must leave the armed start alone —
      // the old code re-armed (moved) the start point to the orbit location.
      await act(async () => {
        viewport.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 70, clientY: 80, button: 1 }));
      });
      expect(useStore.getState().drawStart).toEqual(armed);

      // The next LEFT press still commits from the original start.
      await act(async () => { viewport.dispatchEvent(mouse('mousedown', 75, 50)); });
      expect(linesInState()).toBe(1);
      await act(async () => { viewport.dispatchEvent(mouse('mouseup', 75, 50)); });
      expect(linesInState()).toBe(1);
    } finally {
      await unmount(m);
    }
  });
});

// Hole click-to-place (usability audit F2): Feature → Hole asks ⌀/depth and
// then ARMS — the next left click on that body drills at the clicked world
// point. The raycast at pick time is intercepted (mockHits) so the applied
// center is exactly the synthetic intersection point; the menu/arm path is
// otherwise the real rendered flow.
describe('ViewportCanvas hole click-to-place (rendered)', () => {
  type SetFromCamera = (this: THREE.Raycaster, coords: THREE.Vector2, camera: THREE.Camera) => void;
  type IntersectObjects = (this: THREE.Raycaster, objects: THREE.Object3D[], recursive?: boolean) => unknown[];
  const raycasterProto = THREE.Raycaster.prototype as unknown as {
    setFromCamera: SetFromCamera;
    intersectObjects: IntersectObjects;
  };
  const originalSetFromCamera: SetFromCamera = raycasterProto.setFromCamera;
  const originalIntersectObjects: IntersectObjects = raycasterProto.intersectObjects;

  interface MockHit {
    point: THREE.Vector3;
    object: { userData: { bodyId?: string } };
    faceIndex: number;
  }
  let mockHits: MockHit[] | null = null;
  const hit = (bodyId: string, x: number, y: number, z: number): MockHit => ({
    point: new THREE.Vector3(x, y, z),
    object: { userData: { bodyId } },
    faceIndex: 0,
  });

  beforeAll(() => {
    raycasterProto.setFromCamera = function (coords, camera) {
      camera.updateMatrixWorld();
      originalSetFromCamera.call(this, coords, camera);
    };
    raycasterProto.intersectObjects = function (objects, recursive) {
      if (mockHits) return mockHits as unknown[];
      return originalIntersectObjects.call(this, objects, recursive);
    };
  });
  afterAll(() => {
    raycasterProto.setFromCamera = originalSetFromCamera;
    raycasterProto.intersectObjects = originalIntersectObjects;
  });

  beforeEach(() => {
    mockHits = null;
    clearToasts();
    useStore.setState({
      locale: 'en',
      workspace: 'model',
      sketchActive: false,
      sketchTool: 'select',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      bodies: [],
      selectedIds: [],
      selectedEdgeIds: [],
      selectedFaceIds: [],
      hiddenIds: [],
      annotations: [],
      viewDirection: 'top',
      projection: 'perspective',
      measureActive: false,
      visionSelectActive: false,
      numericPrompt: null,
    });
  });

  function click(x: number, y: number): MouseEvent {
    return new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  }

  /** The armed-placement hint pill: the only div[aria-live] in the viewport
   *  (the drag readout is a span), so it is findable even while hidden. */
  function hintPill(container: HTMLElement): HTMLDivElement | null {
    return (container.querySelector('div[aria-live="polite"]') as HTMLDivElement | null) ?? null;
  }

  /** Drive the real menu flow (⌀ then depth) into the ARMED state. */
  async function armHoleViaMenu(m: Mounted, diameter: number, depth: number): Promise<void> {
    await openBodyMenu(m);
    await act(async () => { menuButton(m.container, translations.en!['menu.feature']!)!.click(); });
    await act(async () => { menuButton(m.container, translations.en!['feature.hole']!)!.click(); });
    let prompt = useStore.getState().numericPrompt;
    expect(prompt!.labelKey).toBe('feature.holeDiameter');
    await act(async () => { prompt!.onApply(diameter); });
    prompt = useStore.getState().numericPrompt;
    expect(prompt!.labelKey).toBe('feature.holeDepth');
    await act(async () => { prompt!.onApply(depth); });
  }

  it('arms after the prompts; the next body click drills at the clicked point, then disarms', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);

      // ARMED, not applied: the existing holePickHint key shows as a pill.
      expect(applyHole).not.toHaveBeenCalled();
      const hint = hintPill(m.container);
      expect(hint).not.toBeNull();
      expect(hint!.style.display).not.toBe('none');

      // The next left click's raycast intersection drills there (depth 0 = through-all).
      mockHits = [hit(box.id, 1, 2, 3)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledTimes(1);
      expect(applyHole).toHaveBeenCalledWith(box.id, 4, null, { x: 1, y: 2, z: 3 });
      expect(toastMessages()).toContain(translations.en!['toast.featureApplied']!);

      // Disarmed: the pill hides and a further click applies nothing more.
      expect(hint!.style.display).toBe('none');
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledTimes(1);
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('a positive depth passes through as a finite depth value', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 2, 5);
      mockHits = [hit(box.id, 0, 4, 0)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledWith(box.id, 2, 5, { x: 0, y: 4, z: 0 });
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('clicking another body or empty space toasts featureNeedsBody and STAYS armed', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    const other = translateBody(createBox(4, 4, 4), { x: 20, y: 0, z: 0 }, 'Other');
    // Mount with ONE body (the empty-scene auto-fit then centres on it), and
    // add the second only after arming — a two-body mount would frame the
    // PAIR, moving the first body off the screen centre the menu click uses.
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 3, 0);
      await act(async () => { useStore.setState({ bodies: [box, other] }); });

      // A different body under the click: refused, armed kept.
      mockHits = [hit(other.id, 20, 4, 0)];
      await act(async () => { viewport.dispatchEvent(click(80, 50)); });
      expect(applyHole).not.toHaveBeenCalled();
      expect(toastMessages()).toContain(translations.en!['toast.featureNeedsBody']!);

      // Empty space: same refusal, still armed.
      clearToasts();
      mockHits = [];
      await act(async () => { viewport.dispatchEvent(click(20, 80)); });
      expect(applyHole).not.toHaveBeenCalled();
      expect(toastMessages()).toContain(translations.en!['toast.featureNeedsBody']!);
      expect(hintPill(m.container)!.style.display).not.toBe('none');

      // The armed body is still clickable afterwards.
      mockHits = [hit(box.id, 2, 2, 2)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledWith(box.id, 3, null, { x: 2, y: 2, z: 2 });
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('Escape cancels the armed placement (no hole, hint hidden)', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      });
      expect(hintPill(m.container)!.style.display).toBe('none');

      mockHits = [hit(box.id, 1, 2, 3)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).not.toHaveBeenCalled();
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });
});

