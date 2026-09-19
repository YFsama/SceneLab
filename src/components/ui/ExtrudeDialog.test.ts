import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { FeatureTree } from '../../lib/features/tree';
import { createSketch, addRectangle } from '../../lib/sketch/engine';
import { computeVolume, findBoundaryLoops } from '../../lib/geometry/brep';
import { ExtrudeDialog } from './ExtrudeDialog';

// Real coverage for the flows the ExtrudeDialog drives: the dialog collects a
// distance + symmetric flag and calls performExtrude — test that store action
// (and its sweep sibling) end to end. Previously this file re-implemented the
// clamp locally and tested the copy. The expression-input cases below render
// the real dialog (jsdom + createRoot + act) and type into the actual field.

describe('performExtrude (what the dialog submits to)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      currentSketch: null,
      sketchActive: false,
    });
  });

  const rectangleSketch = () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 5);
    return sketch;
  };

  it('extrudes the current sketch into a parametric feature and a body', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(8, false);
    const s = useStore.getState();
    expect(s.sketchActive).toBe(false);
    expect(s.workspace).toBe('model');
    const types = s.featureTree.features.map((f) => f.type);
    expect(types).toContain('sketch');
    expect(types).toContain('extrude');
    expect(s.bodies).toHaveLength(1);
    expect(computeVolume(s.bodies[0]!)).toBeCloseTo(10 * 5 * 8, 0);
  });

  it('symmetric extrude centers the profile on the sketch plane', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(10, true);
    const body = useStore.getState().bodies[0]!;
    const ys = body.vertices.map((v) => v.y);
    expect(Math.min(...ys)).toBeCloseTo(-5, 3);
    expect(Math.max(...ys)).toBeCloseTo(5, 3);
  });

  it('non-positive distance is refused (no features added)', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(0, false);
    expect(useStore.getState().featureTree.features).toHaveLength(0);
  });
});

describe('performSweep (twisted extrude)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      currentSketch: null,
    });
  });

  it('sweeps the sketch profile into a sweep feature with twist', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, -5, -5, 5, 5);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performSweep(20, 90);
    const s = useStore.getState();
    const sweep = s.featureTree.features.find((f) => f.type === 'sweep');
    expect(sweep && sweep.type === 'sweep' && sweep.params.twist).toBeCloseTo(Math.PI / 2, 5);
    expect(s.bodies).toHaveLength(1);
    const body = s.bodies[0]!;
    // The path is subdivided so the 90° twist applies gradually; a bilinear
    // sweep through rotated rings constricts the section, landing between the
    // untwisted prism volume (2000) and a conservative lower bound.
    const volume = computeVolume(body);
    expect(volume).toBeGreaterThan(1500);
    expect(volume).toBeLessThanOrEqual(2000 + 1e-6);
    // Watertight despite the twist.
    expect(findBoundaryLoops(body).loops.length).toBe(0);
  });
});

// --- Rendered-dialog coverage: CAD-style expression input --------------------
// Minimal mount harness (the project has no testing-library): render with
// createRoot inside act(), drive the real <input> with native value setters +
// input events, click the real buttons.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountDialog(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmountDialog({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

/** Type into a controlled React input the way a real keystroke does. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The right-most button is the confirm/apply action in every dialog. */
function applyButton(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll('button');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

describe('ExtrudeDialog distance field (rendered dialog)', () => {
  beforeEach(() => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 5);
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      currentSketch: sketch,
      sketchActive: true,
      showExtrudeDialog: true,
    });
  });

  it('accepts an expression: typing "20/2" extrudes 10 mm', async () => {
    const mounted = await mountDialog(createElement(ExtrudeDialog));
    try {
      const input = mounted.container.querySelector('#extrude-distance') as HTMLInputElement;

      await typeInto(input, '20/2');
      expect(input.value).toBe('20/2');
      expect(mounted.container.textContent).toContain('= 10');

      await act(async () => {
        applyButton(mounted.container).click();
      });
      const s = useStore.getState();
      expect(s.showExtrudeDialog).toBe(false);
      const extrude = s.featureTree.features.find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(10);
      expect(computeVolume(s.bodies[0]!)).toBeCloseTo(10 * 5 * 10, 0);
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('keeps intermediate typing intact: "20/" is not destroyed and cannot be committed', async () => {
    const mounted = await mountDialog(createElement(ExtrudeDialog));
    try {
      const input = mounted.container.querySelector('#extrude-distance') as HTMLInputElement;

      await typeInto(input, '20/');
      // The raw partial expression survives (previously each keystroke was
      // coerced with Math.max(0.1, Number(...)), wiping it out).
      expect(input.value).toBe('20/');
      expect(applyButton(mounted.container).disabled).toBe(true);
      expect(useStore.getState().featureTree.features).toHaveLength(0);

      // Finishing the expression re-enables commit.
      await typeInto(input, '20/2');
      expect(applyButton(mounted.container).disabled).toBe(false);
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('clamps an expression that evaluates below the 0.1 mm floor at commit', async () => {
    const mounted = await mountDialog(createElement(ExtrudeDialog));
    try {
      const input = mounted.container.querySelector('#extrude-distance') as HTMLInputElement;

      await typeInto(input, '0.02/2'); // 0.01 < 0.1 floor → clamped like before
      await act(async () => {
        applyButton(mounted.container).click();
      });
      const extrude = useStore.getState().featureTree.features
        .find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(0.1);
    } finally {
      await unmountDialog(mounted);
    }
  });
});
