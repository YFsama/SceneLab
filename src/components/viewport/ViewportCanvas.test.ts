import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { useStore } from '../../store/app';
import { useViewBookmarks } from '../../store/viewBookmarks';
import { createSketch, addLine, addArc } from '../../lib/sketch/engine';
import { createBox, translateBody, type SolidBody } from '../../lib/geometry';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { captureFreshCanvas } from '../../lib/render/capture';
import { defaultCamSetup } from '../../lib/cam';
import { ViewportCanvas } from './ViewportCanvas';

// ViewportCanvas is a WebGL component; jsdom has neither WebGL nor a canvas
// rasterizer. Mount the REAL component with only the two GPU-bound classes
// faked (WebGLRenderer, OrbitControls) — everything else (scene graph, raycast
// picking, menu construction) is plain math and DOM and runs for real. The
// right-click → ContextMenu flow below is therefore the true component path.

// Every EllipseCurve the component constructs (circle + arc previews). The arc
// sweep-direction tests below read the recorded instances; behaviour is the
// real class's (the recorder only subclasses and notes `this`).
const recordedCurves = vi.hoisted(() => [] as unknown[]);
// Scenes passed to renderer.render — the CAM overlay tests reach the live
// scene graph through them (the component keeps it in a private ref).
const recordedScenes = vi.hoisted(() => [] as unknown[]);

vi.mock('three', async (importOriginal: () => Promise<typeof import('three')>) => {
  const actual = await importOriginal();
  class RecordingEllipseCurve extends actual.EllipseCurve {
    constructor(...args: ConstructorParameters<typeof actual.EllipseCurve>) {
      super(...args);
      recordedCurves.push(this);
    }
  }
  class FakeWebGLRenderer {
    readonly domElement = document.createElement('canvas');
    outputColorSpace = '';
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    clippingPlanes: unknown[] = [];
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene: unknown) {
      recordedScenes.push(scene);
    }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer, EllipseCurve: RecordingEllipseCurve } as unknown as typeof import('three');
});

const recordedControls = vi.hoisted(() => [] as unknown[]);

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
    constructor() {
      // Recorded so tests can reach the ACTIVE camera (controls.object is
      // re-seated to the ortho camera when the projection is orthographic).
      recordedControls.push(this);
    }
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

/** applyHoleToBody's signature — typed mocks keep the full 5-arg call shape
 *  (id, ⌀, depth, center?, direction?) without naming unused parameters. */
type ApplyHoleFn = (
  id: string, diameter: number, depth: number | null,
  center?: { x: number; y: number; z: number }, direction?: { x: number; y: number; z: number },
) => boolean;

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
    object: { userData: { bodyId?: string; planeId?: string }; matrixWorld?: THREE.Matrix4 };
    faceIndex: number;
    /** Local-space face normal (what three.js reports on hit.face). */
    face?: { normal: THREE.Vector3 };
  }
  let mockHits: MockHit[] | null = null;
  /** When set, raycasts against the datum-plane group return these instead. */
  let mockPlaneHits: MockHit[] | null = null;
  const hit = (bodyId: string, x: number, y: number, z: number): MockHit => ({
    point: new THREE.Vector3(x, y, z),
    object: { userData: { bodyId } },
    faceIndex: 0,
  });
  /** A hit carrying a face normal + a mesh world matrix (side-face click). */
  const faceHit = (
    bodyId: string, x: number, y: number, z: number,
    normal: THREE.Vector3, matrixWorld = new THREE.Matrix4(),
  ): MockHit => ({
    point: new THREE.Vector3(x, y, z),
    object: { userData: { bodyId }, matrixWorld },
    faceIndex: 0,
    face: { normal },
  });
  /** A datum-plane quad hit (object carries userData.planeId instead). */
  const planeHit = (planeId: string): MockHit => ({
    point: new THREE.Vector3(0, 0, 0),
    object: { userData: { planeId } },
    faceIndex: 0,
  });

  beforeAll(() => {
    raycasterProto.setFromCamera = function (coords, camera) {
      camera.updateMatrixWorld();
      originalSetFromCamera.call(this, coords, camera);
    };
    raycasterProto.intersectObjects = function (objects, recursive) {
      // Route by the query's target group: datum-plane quads carry
      // userData.planeId, body meshes userData.bodyId — so a test can mock
      // "the shaft misses the body but the ray reaches the plane" separately
      // from body-mesh hits.
      if (objects.some((o) => o.userData != null && 'planeId' in o.userData)) {
        if (mockPlaneHits) return mockPlaneHits as unknown[];
      } else if (mockHits) {
        return mockHits as unknown[];
      }
      return originalIntersectObjects.call(this, objects, recursive);
    };
  });
  afterAll(() => {
    raycasterProto.setFromCamera = originalSetFromCamera;
    raycasterProto.intersectObjects = originalIntersectObjects;
  });

  beforeEach(() => {
    mockHits = null;
    mockPlaneHits = null;
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
    const applyHole = vi.fn<ApplyHoleFn>(() => true);
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

  // ---- pass-27 review #1: drill along the clicked face's INWARD normal ----

  it('drills along the clicked face’s inward world normal (side face → lateral direction)', async () => {
    const applyHole = vi.fn<ApplyHoleFn>(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);

      // Mesh rotated 90° about Y: the local +X face normal maps to world −Z,
      // so the drill direction (inward, into the body) is world +Z — NOT the
      // world −Y default that gouges a side-face click.
      mockHits = [faceHit(
        box.id, 10, 0, 0,
        new THREE.Vector3(1, 0, 0),
        new THREE.Matrix4().makeRotationY(Math.PI / 2),
      )];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });

      expect(applyHole).toHaveBeenCalledTimes(1);
      const args = applyHole.mock.calls[0]!;
      expect(args[0]).toBe(box.id);
      expect(args[3]).toEqual({ x: 10, y: 0, z: 0 });
      expect(args).toHaveLength(5);
      const dir = args[4] as { x: number; y: number; z: number };
      expect(dir.x).toBeCloseTo(0, 5);
      expect(dir.y).toBeCloseTo(0, 5);
      expect(dir.z).toBeCloseTo(1, 5);
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('omits the direction when the normal transform is degenerate (world −Y fallback)', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);

      // A singular world matrix collapses the transformed normal to the zero
      // vector → the direction argument is OMITTED (not null), preserving
      // applyHoleToBody's locked "omitted = world −Y" contract.
      mockHits = [faceHit(box.id, 1, 2, 3, new THREE.Vector3(1, 0, 0), new THREE.Matrix4().makeScale(0, 0, 0))];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });

      expect(applyHole).toHaveBeenCalledTimes(1);
      expect(applyHole.mock.calls[0]!).toHaveLength(4);
      expect(applyHole).toHaveBeenCalledWith(box.id, 4, null, { x: 1, y: 2, z: 3 });
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  // ---- pass-27 review #2: while armed, placement owns the click over every mode ----

  it('armed + Alt+click drills; the edge sub-selection never toggles', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);

      mockHits = [hit(box.id, 0, 2, 0)];
      await act(async () => {
        viewport.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 0, altKey: true,
        }));
      });
      expect(applyHole).toHaveBeenCalledTimes(1);
      expect(useStore.getState().selectedEdgeIds).toEqual([]);
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('armed + sketch-mode click drills; the sketch tool never sees the click', async () => {
    // The mode is active FIRST and the placement is armed through the
    // component's real arming event (the disarm effect only fires on mode
    // TRANSITIONS, so this constructs the worst case: armed while a mode is
    // already active) — the branch order must still route the click to the
    // placement, never to the sketch select tool.
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    const sketch = createSketch('xy');
    addLine(sketch, -5, -5, 5, 5); // a line under the cursor for the select tool to grab
    useStore.setState({
      bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole,
      sketchActive: true, workspace: 'sketch', currentSketch: sketch,
    });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('scenelab:arm-hole', {
          detail: { bodyId: box.id, diameter: 4, depth: null },
        }));
      });
      expect(hintPill(m.container)!.style.display).not.toBe('none');

      mockHits = [hit(box.id, 0, 2, 0)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledTimes(1);
      // The sketch select branch (which runs next in the handler) would have
      // picked the line under the cursor — it must never run.
      expect(useStore.getState().selectedSketchId).toBeNull();
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('armed + measure-mode click drills; no measure point is dropped', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({
      bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole,
      measureActive: true, measurePts: [],
    });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('scenelab:arm-hole', {
          detail: { bodyId: box.id, diameter: 4, depth: null },
        }));
      });

      mockHits = [hit(box.id, 0, 2, 0)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).toHaveBeenCalledTimes(1);
      expect(useStore.getState().measurePts).toEqual([]);
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  it('entering sketch or measure mode disarms a live placement (no dead pill)', async () => {
    const applyHole = vi.fn(() => true);
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [box.id], applyHoleToBody: applyHole });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await armHoleViaMenu(m, 4, 0);
      expect(hintPill(m.container)!.style.display).not.toBe('none');

      // Entering sketch mode clears the pill…
      await act(async () => { useStore.setState({ sketchActive: true }); });
      expect(hintPill(m.container)!.style.display).toBe('none');
      // …and a click after the disarm is an ordinary sketch click: no hole.
      mockHits = [hit(box.id, 0, 2, 0)];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(applyHole).not.toHaveBeenCalled();

      // Same for measure mode: arm again, enter, pill gone.
      await act(async () => { useStore.setState({ sketchActive: false }); });
      await act(async () => {
        window.dispatchEvent(new CustomEvent('scenelab:arm-hole', {
          detail: { bodyId: box.id, diameter: 4, depth: null },
        }));
      });
      expect(hintPill(m.container)!.style.display).not.toBe('none');
      await act(async () => { useStore.setState({ measureActive: true }); });
      expect(hintPill(m.container)!.style.display).toBe('none');
    } finally {
      mockHits = null;
      await unmount(m);
    }
  });

  // ---- pass-27 review #4: a click through a through-hole shaft never starts a sketch ----

  it('a ray that pierces a body’s bounds selects the body — the datum plane never starts a sketch', async () => {
    const box = createBox(4, 4, 4);
    useStore.setState({ bodies: [box], selectedIds: [] });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      // Floor: a body MESH hit anywhere along the ray (even a far face)
      // already wins over a nearer plane hit — the plane is never consulted.
      mockHits = [hit(box.id, 0, -2, 0)];
      mockPlaneHits = [planeHit('xy')];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(useStore.getState().selectedIds).toContain(box.id);
      expect(useStore.getState().sketchActive).toBe(false);

      // The shaft case: after a through-all hole, the ray dives down the
      // empty shaft, misses every triangle, and reaches the plane behind —
      // but the body's bounding volume still blocks the plane pick.
      await act(async () => { useStore.setState({ selectedIds: [] }); });
      mockHits = [];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(useStore.getState().selectedIds).toContain(box.id); // body preferred
      expect(useStore.getState().sketchActive).toBe(false);      // no sketch started
      expect(useStore.getState().currentSketch).toBeNull();
    } finally {
      mockHits = null;
      mockPlaneHits = null;
      await unmount(m);
    }
  });

  it('still starts a sketch on a plane when no body is in the line of sight', async () => {
    useStore.setState({ bodies: [], selectedIds: [] });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;

      mockHits = [];
      mockPlaneHits = [planeHit('xy')];
      await act(async () => { viewport.dispatchEvent(click(50, 50)); });
      expect(useStore.getState().sketchActive).toBe(true);
      expect(useStore.getState().currentSketch).not.toBeNull();
    } finally {
      mockHits = null;
      mockPlaneHits = null;
      await unmount(m);
    }
  });
});

// Camera view bookmarks (Fusion-style): capture the live camera pose from the
// empty-space context menu, then restore it through the SAME
// 'viewport-camera-snap' event the standard views dispatch (the 250 ms tween
// listener). The camera itself is the component's real PerspectiveCamera,
// positioned by the real viewDirection effect — no camera mocking needed.
describe('ViewportCanvas camera view bookmarks (rendered)', () => {
  beforeEach(() => {
    clearToasts();
    localStorage.clear();
    useViewBookmarks.setState({ bookmarks: [] });
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
      viewDirection: 'front',
      projection: 'perspective',
      measureActive: false,
      visionSelectActive: false,
      numericPrompt: null,
    });
  });

  it('captures via the menu, lists the bookmark, and restores it through the standard snap event', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      const bookmarkLabel = translations.en!['menu.bookmarkCurrent']!;

      // CAPTURE at the front view: the viewDirection effect put the camera at
      // (0,0,10) aimed at the origin with up +Y (identity orientation).
      await openBodyMenu(m);
      expect(menuLabels(m.container)).toContain(bookmarkLabel);
      // No bookmarks yet: neither a restore entry nor the clear item.
      expect(menuLabels(m.container)).not.toContain(translations.en!['menu.clearBookmarks']!);
      await act(async () => { menuButton(m.container, bookmarkLabel)!.click(); });

      const bms = useViewBookmarks.getState().bookmarks;
      expect(bms).toHaveLength(1);
      expect(bms[0]!.name).toBe('View 1');
      expect(bms[0]!.position).toEqual({ x: 0, y: 0, z: 10 });
      expect(bms[0]!.target).toEqual({ x: 0, y: 0, z: 0 });
      expect(bms[0]!.quaternion.x).toBeCloseTo(0, 6);
      expect(bms[0]!.quaternion.y).toBeCloseTo(0, 6);
      expect(bms[0]!.quaternion.z).toBeCloseTo(0, 6);
      expect(bms[0]!.quaternion.w).toBeCloseTo(1, 6);

      // RESTORE: move the camera away (top view), then click the listed
      // bookmark — it must dispatch the standard-view snap event with the
      // bookmarked direction and up.
      await act(async () => { useStore.setState({ viewDirection: 'top' }); });
      await openBodyMenu(m);
      const restore = menuButton(m.container, '1. View 1');
      expect(restore).not.toBeNull();

      const snaps: CustomEvent[] = [];
      const onSnap = (e: Event) => { snaps.push(e as CustomEvent); };
      window.addEventListener('viewport-camera-snap', onSnap);
      try {
        await act(async () => { restore!.click(); });
      } finally {
        window.removeEventListener('viewport-camera-snap', onSnap);
      }
      expect(snaps).toHaveLength(1);
      const detail = snaps[0]!.detail as { position: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } };
      // position = the bookmarked direction from its target (the snap handler
      // normalizes it — same field semantics the standard views send).
      expect(detail.position).toEqual({ x: 0, y: 0, z: 10 });
      // up = the captured orientation's up axis (identity → world +Y).
      expect(detail.up.x).toBeCloseTo(0, 6);
      expect(detail.up.y).toBeCloseTo(1, 6);
      expect(detail.up.z).toBeCloseTo(0, 6);
    } finally {
      await unmount(m);
    }
  });

  it('restores a bookmarked orbit TARGET and dispatches its direction + captured up', async () => {
    // A bookmark looking at a non-origin target, captured orientation from a
    // real camera pose: camera (10,0,10) aimed at (5,0,0) with up +Y.
    const pose = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000);
    pose.position.set(10, 0, 10);
    pose.up.set(0, 1, 0);
    pose.lookAt(5, 0, 0);
    useViewBookmarks.getState().add({
      position: { x: 10, y: 0, z: 10 },
      target: { x: 5, y: 0, z: 0 },
      quaternion: {
        x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w,
      },
    });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      await openBodyMenu(m);

      const snaps: CustomEvent[] = [];
      const updates: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }[] = [];
      const onSnap = (e: Event) => { snaps.push(e as CustomEvent); };
      const onUpdate = (e: Event) => {
        updates.push((e as CustomEvent).detail);
      };
      window.addEventListener('viewport-camera-snap', onSnap);
      window.addEventListener('viewport-camera-update', onUpdate);
      try {
        await act(async () => {
          menuButton(m.container, '1. View 1')!.click();
          // Let the rAF render loop publish the re-seated camera state
          // (restoreBookmark marks the frame dirty synchronously).
          await new Promise((r) => { setTimeout(r, 60); });
        });
      } finally {
        window.removeEventListener('viewport-camera-snap', onSnap);
        window.removeEventListener('viewport-camera-update', onUpdate);
      }

      // The snap payload: direction = position − target, up = the captured
      // orientation's up axis.
      expect(snaps).toHaveLength(1);
      const detail = snaps[0]!.detail as { position: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } };
      expect(detail.position).toEqual({ x: 5, y: 0, z: 10 });
      const expectedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      expect(detail.up.x).toBeCloseTo(expectedUp.x, 5);
      expect(detail.up.y).toBeCloseTo(expectedUp.y, 5);
      expect(detail.up.z).toBeCloseTo(expectedUp.z, 5);

      // The orbit centre was re-seated to the bookmarked target before the
      // dispatch — the published camera state carries it (constant through
      // the tween, which never touches the target).
      expect(updates.some((u) =>
        Math.abs(u.target.x - 5) < 1e-6 && Math.abs(u.target.y) < 1e-6 && Math.abs(u.target.z) < 1e-6,
      )).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('shows Clear view bookmarks only while bookmarks exist, and clearing empties the store', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const viewport = viewportDiv(m.container);
      viewport.getBoundingClientRect = fakeRect;
      const clearLabel = translations.en!['menu.clearBookmarks']!;

      await openBodyMenu(m);
      expect(menuLabels(m.container)).not.toContain(clearLabel);
      await act(async () => { menuButton(m.container, translations.en!['menu.bookmarkCurrent']!)!.click(); });
      expect(useViewBookmarks.getState().bookmarks).toHaveLength(1);

      await openBodyMenu(m);
      expect(menuLabels(m.container)).toContain('1. View 1');
      expect(menuLabels(m.container)).toContain(clearLabel);
      await act(async () => { menuButton(m.container, clearLabel)!.click(); });
      expect(useViewBookmarks.getState().bookmarks).toEqual([]);
      expect(localStorage.getItem('scenelab.viewBookmarks')).toBe('[]');

      await openBodyMenu(m);
      expect(menuLabels(m.container)).not.toContain('1. View 1');
      expect(menuLabels(m.container)).not.toContain(clearLabel);
    } finally {
      await unmount(m);
    }
  });
});

// CW arcs (negative signed sweep) must preview as their own clockwise span,
// not the CCW complement EllipseCurve falls back to. The arc entities are
// built with the real engine and rendered by the component's real sketch
// effect; the constructed EllipseCurve instances are captured by the
// recording subclass in the three mock above.
describe('ViewportCanvas arc preview sweep direction (rendered)', () => {
  beforeEach(() => {
    recordedCurves.length = 0;
    clearToasts();
    useStore.setState({
      locale: 'en',
      workspace: 'sketch',
      sketchActive: true,
      sketchTool: 'select',
      sketchPlaneId: 'xy',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      bodies: [],
      selectedIds: [],
      hiddenIds: [],
      annotations: [],
      viewDirection: 'top',
      projection: 'perspective',
      measureActive: false,
      numericPrompt: null,
    });
  });

  /** Recorded EllipseCurve instances that are NOT full circles. */
  function recordedArcs(): THREE.EllipseCurve[] {
    return recordedCurves
      .filter((c): c is THREE.EllipseCurve => c instanceof THREE.EllipseCurve)
      .filter((c) => !(c.aStartAngle === 0 && c.aEndAngle === Math.PI * 2));
  }

  it('renders a CW arc as the clockwise quarter from 0 to −π/2, not its 3/4 CCW complement', async () => {
    const sketch = createSketch('xy');
    addArc(sketch, 0, 0, 5, 0, -Math.PI / 2); // CW quarter: (5,0) → (0,−5)
    addArc(sketch, 10, 0, 4, 0, Math.PI / 2); // CCW control: (14,0) → (10,4)
    useStore.setState({ currentSketch: sketch });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const arcs = recordedArcs();
      expect(arcs).toHaveLength(2); // Map insertion order: CW first, CCW second
      const [cw, ccw] = arcs as [THREE.EllipseCurve, THREE.EllipseCurve];

      // CW arc: sweep sign passed through as aClockwise, so the traced points
      // walk 0 → −π/2 clockwise.
      expect(cw.aClockwise).toBe(true);
      const cwPts = cw.getPoints(64);
      expect(cwPts[0]!.x).toBeCloseTo(5, 6);
      expect(cwPts[0]!.y).toBeCloseTo(0, 6);
      const cwMid = cwPts[32]!;
      expect(cwMid.x).toBeCloseTo(5 * Math.cos(-Math.PI / 4), 5);
      expect(cwMid.y).toBeCloseTo(5 * Math.sin(-Math.PI / 4), 5);
      expect(cwPts[64]!.x).toBeCloseTo(0, 6);
      expect(cwPts[64]!.y).toBeCloseTo(-5, 6);

      // CCW control arc: unchanged behaviour (aClockwise stays false, quarter
      // counterclockwise) — the fix must not invert positive sweeps.
      expect(ccw.aClockwise).toBe(false);
      const ccwMid = ccw.getPoints(64)[32]!;
      expect(ccwMid.x).toBeCloseTo(10 + 4 * Math.cos(Math.PI / 4), 5);
      expect(ccwMid.y).toBeCloseTo(4 * Math.sin(Math.PI / 4), 5);
    } finally {
      await unmount(m);
    }
  });

  it('the mirror image of a CCW arc (which carries a negative sweep) previews as the same span', async () => {
    // Mirroring an arc across a line flips the sweep sign by construction
    // (lib/sketch/mirror swaps the reflected angles); e.g. the CCW quarter
    // 0→π/2 mirrored across Y becomes π/2→0 — negative, previously rendered
    // as the 3/4 complement.
    const sketch = createSketch('xy');
    addArc(sketch, 0, 0, 5, Math.PI / 2, 0); // negative sweep −π/2
    useStore.setState({ currentSketch: sketch });

    const m = await mount(createElement(ViewportCanvas));
    try {
      const [arc] = recordedArcs() as [THREE.EllipseCurve];
      expect(arc).toBeDefined();
      expect(arc.aClockwise).toBe(true);
      const pts = arc.getPoints(64);
      // Starts at the reflected start (0,5) and walks CLOCKWISE to (5,0) —
      // the mirror image of the CCW quarter, not the long way round.
      expect(pts[0]!.x).toBeCloseTo(0, 6);
      expect(pts[0]!.y).toBeCloseTo(5, 6);
      expect(pts[32]!.x).toBeCloseTo(5 * Math.cos(Math.PI / 4), 5);
      expect(pts[32]!.y).toBeCloseTo(5 * Math.sin(Math.PI / 4), 5);
      expect(pts[64]!.x).toBeCloseTo(5, 6);
      expect(pts[64]!.y).toBeCloseTo(0, 6);
    } finally {
      await unmount(m);
    }
  });
});

// CAM toolpath overlay: the real generator produces the toolpath (through the
// store's addCamOperation), the real component renders it. The overlay group
// is reached through the scenes the fake renderer records.
describe('ViewportCanvas CAM toolpath overlay (rendered)', () => {
  beforeEach(() => {
    clearToasts();
    recordedControls.length = 0;
    recordedScenes.length = 0;
    useStore.setState({
      locale: 'en',
      workspace: 'cam',
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
      camSetup: defaultCamSetup(),
      camToolpaths: {},
      undoStack: [],
      redoStack: [],
    });
  });

  /** A box body + one ENABLED pocket op added through the real store action
   * (which runs the real generator and caches the toolpath). */
  function seedCamOperation(): string {
    const box = createBox(20, 15, 10);
    useStore.setState({ bodies: [box], directBodies: [box], objectIds: [box.id] });
    return useStore.getState().addCamOperation({
      name: 'Pocket — Box',
      enabled: true,
      type: 'pocket',
      bodyId: box.id,
      toolId: 'em-6mm',
      params: { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 10, stockBottom: -5 },
    });
  }

  function lastScene(): THREE.Scene {
    const scene = recordedScenes[recordedScenes.length - 1];
    expect(scene).toBeDefined();
    return scene as THREE.Scene;
  }

  function camGroup(): THREE.Group {
    const group = lastScene().getObjectByName('cam-toolpaths');
    expect(group).toBeDefined();
    return group as THREE.Group;
  }

  it('builds cut polylines and rapid segments from the cached toolpath in the cam workspace', async () => {
    const id = seedCamOperation();
    const cache = useStore.getState().camToolpaths[id]!;
    expect(cache.toolpath.points.length).toBeGreaterThan(4); // a real zigzag, not a stub

    const m = await mount(createElement(ViewportCanvas));
    try {
      const group = camGroup();
      expect(group.visible).toBe(true);
      const lines = group.children.filter((c): c is THREE.Line => c instanceof THREE.Line);
      expect(lines.length).toBeGreaterThan(0);
      // Cut polylines in the cut material (0x89b4fa, opaque-ish)…
      const cuts = lines.filter((l) => l.name === 'cam-cut');
      expect(cuts.length).toBeGreaterThan(0);
      expect((cuts[0]!.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x89b4fa);
      // …and rapid/plunge segments in the dashed rapid material (0xf38ba8,
      // depthTest false, drawn on top).
      const moves = lines.filter((l) => l.name === 'cam-move');
      expect(moves.length).toBeGreaterThan(0);
      const rapidMat = moves[0]!.material as THREE.LineDashedMaterial;
      expect(rapidMat.color.getHex()).toBe(0xf38ba8);
      expect(rapidMat.depthTest).toBe(false);
      // Contiguous cutting runs have ≥ 2 vertices each.
      for (const cut of cuts) {
        expect((cut.geometry.getAttribute('position') as THREE.BufferAttribute).count).toBeGreaterThanOrEqual(2);
      }
      // Points are world coordinates used VERBATIM: every cut vertex is a
      // toolpath point (x, y, z) with no remap (Float32 attribute storage, so
      // compare within float32 rounding).
      const pts3 = cache.toolpath.points;
      const isToolpathPoint = (x: number, y: number, z: number) =>
        pts3.some((p) => Math.abs(p.x - x) < 1e-4 && Math.abs(p.y - y) < 1e-4 && Math.abs(p.z - z) < 1e-4);
      for (const cut of cuts) {
        const attr = cut.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < attr.count; i++) {
          expect(isToolpathPoint(attr.getX(i), attr.getY(i), attr.getZ(i))).toBe(true);
        }
      }
    } finally {
      await unmount(m);
    }
  });

  it('renders no toolpath lines outside the cam workspace, and a switch rebuilds them', async () => {
    seedCamOperation();
    useStore.setState({ workspace: 'model' });

    const m = await mount(createElement(ViewportCanvas));
    try {
      // Model workspace: the group exists but is empty and hidden.
      let group = camGroup();
      expect(group.children).toHaveLength(0);
      expect(group.visible).toBe(false);

      // Entering the cam workspace rebuilds the overlay from the same cache.
      await act(async () => { useStore.setState({ workspace: 'cam' }); });
      group = camGroup();
      expect(group.visible).toBe(true);
      expect(group.children.filter((c) => c instanceof THREE.Line).length).toBeGreaterThan(0);
    } finally {
      await unmount(m);
    }
  });

  it('disposes line geometries on unmount', async () => {
    seedCamOperation();
    const m = await mount(createElement(ViewportCanvas));
    const group = camGroup();
    const lines = group.children.filter((c): c is THREE.Line => c instanceof THREE.Line);
    expect(lines.length).toBeGreaterThan(0);
    const spies = lines.map((l) => vi.spyOn(l.geometry, 'dispose'));
    await unmount(m);
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  });
});

// Machine simulation (pass-29 CAM-PLUS T1): the panel dispatches
// 'scenelab:cam-sim' window events; the viewport owns the sim in refs and
// walks the FIRST enabled cached op. A fake rAF drives the ticks with exact
// timestamps so speeds (rapid = 5× cut feed) are asserted deterministically.
describe('ViewportCanvas CAM machine simulation (rendered)', () => {
  /** Deterministic rAF: callbacks queue up and only run when flushed. */
  function installFakeRaf() {
    const realRaf = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    let now = 0;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      pending.delete(id);
    }) as typeof cancelAnimationFrame;
    return {
      /** Advance the clock by `ms` and run everything scheduled. */
      flush: (ms: number) => {
        now += ms;
        const cbs = [...pending.entries()];
        pending.clear();
        for (const [, cb] of cbs) cb(now);
      },
      restore: () => {
        window.requestAnimationFrame = realRaf;
        window.cancelAnimationFrame = realCancel;
      },
    };
  }

  function seedCamOperation(): string {
    const box = createBox(20, 15, 10);
    useStore.setState({ bodies: [box], directBodies: [box], objectIds: [box.id] });
    return useStore.getState().addCamOperation({
      name: 'Pocket — Box',
      enabled: true,
      type: 'pocket',
      bodyId: box.id,
      toolId: 'em-6mm',
      params: { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 10, stockBottom: -5 },
    });
  }

  function lastScene(): THREE.Scene {
    const scene = recordedScenes[recordedScenes.length - 1];
    expect(scene).toBeDefined();
    return scene as THREE.Scene;
  }

  function simGroup(): THREE.Group {
    const group = lastScene().getObjectByName('cam-sim-group');
    expect(group).toBeDefined();
    return group as THREE.Group;
  }

  function simTool(): THREE.Object3D {
    const tool = simGroup().children[0]!;
    expect(tool).toBeDefined();
    expect(tool.name).toBe('cam-sim-tool');
    return tool;
  }

  function camCutLines(): THREE.Line[] {
    const group = lastScene().getObjectByName('cam-toolpaths') as THREE.Group;
    return group.children.filter(
      (c): c is THREE.Line => c instanceof THREE.Line && c.name === 'cam-cut',
    );
  }

  const dispatchSim = (detail: Record<string, unknown>) => {
    act(() => {
      window.dispatchEvent(new CustomEvent('scenelab:cam-sim', { detail }));
    });
  };

  beforeEach(() => {
    clearToasts();
    recordedControls.length = 0;
    recordedScenes.length = 0;
    useStore.setState({
      locale: 'en',
      workspace: 'cam',
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
      camSetup: defaultCamSetup(),
      camToolpaths: {},
      undoStack: [],
      redoStack: [],
    });
  });

  it('play creates the tool mesh and rAF ticks advance it along the path', async () => {
    const id = seedCamOperation();
    const cache = useStore.getState().camToolpaths[id]!;
    const start = cache.toolpath.points[0]!;

    const raf = installFakeRaf();
    const m = await mount(createElement(ViewportCanvas));
    try {
      // No sim yet: the group is empty and hidden.
      expect(simGroup().children).toHaveLength(0);

      dispatchSim({ action: 'play' });
      raf.flush(16); // arms the dt clock (lastT)
      const afterArm = simTool().position.clone();
      expect(afterArm.x).toBeCloseTo(start.x, 5);
      expect(afterArm.y).toBeCloseTo(start.y, 5);
      expect(afterArm.z).toBeCloseTo(start.z, 5);

      // 100 ms at rapid speed (5×1000 mm/min ≈ 83 mm/s) ≈ 8.3 mm of travel.
      raf.flush(100);
      const pos = simTool().position.clone();
      expect(pos.distanceTo(new THREE.Vector3(start.x, start.y, start.z))).toBeGreaterThan(3);
      // Descending towards the feed plane (first moves are vertical drops).
      expect(pos.y).toBeLessThan(start.y);
      // Further ticks keep moving the tool.
      raf.flush(100);
      expect(simTool().position.distanceTo(pos)).toBeGreaterThan(0.01);
    } finally {
      await unmount(m);
      raf.restore();
    }
  });

  it('pause freezes the tool; reset returns it to the path start', async () => {
    seedCamOperation();
    const raf = installFakeRaf();
    const m = await mount(createElement(ViewportCanvas));
    try {
      dispatchSim({ action: 'play' });
      raf.flush(16);
      raf.flush(100);
      const moving = simTool().position.clone();

      dispatchSim({ action: 'pause' });
      raf.flush(100);
      raf.flush(100);
      expect(simTool().position.equals(moving)).toBe(true);

      const cache = useStore.getState().camToolpaths[Object.keys(useStore.getState().camToolpaths)[0]!]!;
      const start = cache.toolpath.points[0]!;
      dispatchSim({ action: 'reset' });
      raf.flush(16); // paused: the position must not run away
      expect(simTool().position.x).toBeCloseTo(start.x, 5);
      expect(simTool().position.y).toBeCloseTo(start.y, 5);
      expect(simTool().position.z).toBeCloseTo(start.z, 5);
    } finally {
      await unmount(m);
      raf.restore();
    }
  });

  it('seek lands the tool at the exact fraction of total path length', async () => {
    const id = seedCamOperation();
    const pts = useStore.getState().camToolpaths[id]!.toolpath.points;
    // Expected position at half the cumulative length (test-side walk).
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const total = cum[cum.length - 1]!;
    const D = total / 2;
    let seg = 1;
    while (seg < cum.length && cum[seg]! < D) seg++;
    const segLen = cum[seg]! - cum[seg - 1]!;
    const k = (D - cum[seg - 1]!) / segLen;
    const a = pts[seg - 1]!;
    const b = pts[seg]!;
    const expected = new THREE.Vector3(
      a.x + (b.x - a.x) * k,
      a.y + (b.y - a.y) * k,
      a.z + (b.z - a.z) * k,
    );

    const raf = installFakeRaf();
    const m = await mount(createElement(ViewportCanvas));
    try {
      dispatchSim({ action: 'seek', t: 0.5 });
      const pos = simTool().position;
      expect(pos.x).toBeCloseTo(expected.x, 4);
      expect(pos.y).toBeCloseTo(expected.y, 4);
      expect(pos.z).toBeCloseTo(expected.z, 4);
    } finally {
      await unmount(m);
      raf.restore();
    }
  });

  it('dims the uncut remainder and re-brightens it as the walk passes', async () => {
    seedCamOperation();
    const raf = installFakeRaf();
    const m = await mount(createElement(ViewportCanvas));
    try {
      const opacity = (l: THREE.Line) => (l.material as THREE.LineBasicMaterial).opacity;
      // Before any sim: all cut lines bright (0.9).
      for (const l of camCutLines()) expect(opacity(l)).toBeCloseTo(0.9, 5);

      // Reset to the start: nothing walked → everything dim (0.25).
      dispatchSim({ action: 'reset' });
      for (const l of camCutLines()) expect(opacity(l)).toBeCloseTo(0.25, 5);

      // Seek to the very end: everything bright again.
      dispatchSim({ action: 'seek', t: 1 });
      for (const l of camCutLines()) expect(opacity(l)).toBeCloseTo(0.9, 5);
    } finally {
      await unmount(m);
      raf.restore();
    }
  });

  it('sizes the tool mesh from the op tool diameter (cylinder + cone)', async () => {
    seedCamOperation(); // em-6mm → ⌀6
    const raf = installFakeRaf();
    const m = await mount(createElement(ViewportCanvas));
    try {
      dispatchSim({ action: 'play' });
      const tool = simTool();
      const meshes = tool.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      expect(meshes.length).toBe(2);
      const radii = meshes
        .map((mesh) => mesh.geometry as THREE.CylinderGeometry)
        .map((g) => g.parameters.radiusTop)
        .sort((a, b) => a - b);
      expect(radii[0]).toBeCloseTo(3, 5); // ⌀6/2
    } finally {
      await unmount(m);
      raf.restore();
    }
  });
});

// Camera sync regression (pre-v0.23 bug): renderScene used to copy the
// INACTIVE camera's transform ONTO the active one, silently reverting every
// orbit/zoom gesture on each rendered frame. The active camera (the one
// OrbitControls drive — controls.object is re-seated on projection toggles)
// must be the source of truth; a forced render must leave its position intact.
describe('ViewportCanvas camera sync — active camera persists (rendered)', () => {
  beforeEach(() => {
    clearToasts();
    recordedControls.length = 0;
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
      viewDirection: 'front',
      projection: 'perspective',
      measureActive: false,
      visionSelectActive: false,
      numericPrompt: null,
    });
  });

  /** The controls of the CURRENT mount (the last created instance). */
  function activeControls(): { object: THREE.Camera } {
    const controls = recordedControls[recordedControls.length - 1];
    expect(controls).toBeDefined();
    return controls as { object: THREE.Camera };
  }

  it('keeps a perspective-mode gesture across a forced render and mirrors it to the ortho twin', async () => {
    const m = await mount(createElement(ViewportCanvas));
    try {
      const { object: cam } = activeControls();
      expect(cam).toBeInstanceOf(THREE.PerspectiveCamera); // controls drive the ACTIVE camera
      // The front view put both cameras at (0, 0, 10).
      expect(cam.position.z).toBeCloseTo(10, 6);

      // Simulated gesture (what OrbitControls does to its object on orbit/zoom).
      await act(async () => { cam.position.set(2, 3, 4); });
      // Force renderScene NOW (the capture service runs it synchronously) —
      // the recorded-scene count must grow, proving the render (and therefore
      // the camera sync inside it) really executed before the assertions.
      const scenesBefore = recordedScenes.length;
      await act(async () => { captureFreshCanvas(); });
      expect(recordedScenes.length).toBeGreaterThan(scenesBefore);

      // The gesture PERSISTS — the old inverted sync reset this to the stale
      // ortho position (0, 0, 10) every rendered frame.
      expect(cam.position.x).toBeCloseTo(2, 6);
      expect(cam.position.y).toBeCloseTo(3, 6);
      expect(cam.position.z).toBeCloseTo(4, 6);

      // And it propagated to the inactive twin: switching projection puts
      // OrbitControls on the ortho camera, which must already sit at the
      // gestured position (the sync's whole purpose).
      await act(async () => { useStore.setState({ projection: 'orthographic' }); });
      const { object: ortho } = activeControls();
      expect(ortho).toBeInstanceOf(THREE.OrthographicCamera);
      expect(ortho.position.x).toBeCloseTo(2, 6);
      expect(ortho.position.y).toBeCloseTo(3, 6);
      expect(ortho.position.z).toBeCloseTo(4, 6);
    } finally {
      await unmount(m);
    }
  });

  it('keeps an orthographic-mode gesture across a forced render', async () => {
    useStore.setState({ projection: 'orthographic' });
    const m = await mount(createElement(ViewportCanvas));
    try {
      const { object: ortho } = activeControls();
      expect(ortho).toBeInstanceOf(THREE.OrthographicCamera);
      expect(ortho.position.z).toBeCloseTo(10, 6); // front view, synced at mount

      await act(async () => { ortho.position.set(5, 6, 7); });
      await act(async () => { captureFreshCanvas(); });

      // PERSISTS — the old inverted sync overwrote the active ortho camera
      // with the stale perspective twin (0, 0, 10) every rendered frame.
      expect(ortho.position.x).toBeCloseTo(5, 6);
      expect(ortho.position.y).toBeCloseTo(6, 6);
      expect(ortho.position.z).toBeCloseTo(7, 6);
    } finally {
      await unmount(m);
    }
  });
});

