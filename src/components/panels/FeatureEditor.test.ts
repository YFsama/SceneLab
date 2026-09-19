import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { FeatureEditDialog } from './FeatureEditor';
import {
  FeatureTree,
  createSketchFeature,
  createExtrudeFeature,
  createRevolveFeature,
  createSweepFeature,
  createLoftFeature,
  createFilletFeature,
  createChamferFeature,
  createShellFeature,
  createLinearArrayFeature,
  createCircularArrayFeature,
  createMirrorFeature,
} from '../../lib/features/tree';
import { serializeProject, deserializeFeatures, saveToFile, loadFromFile } from '../../lib/io';
import { createSketch, addRectangle } from '../../lib/sketch/engine';

// Real coverage: every feature type the FeatureEditor can list must survive a
// full project round-trip (serialize → deserialize), so editing/suppressing
// any of them keeps working after a save/reload. Previously this file
// re-declared a literal array and asserted it against itself.

describe('feature round-trip for every type', () => {
  function buildTreeWithEveryType(): FeatureTree {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 5, symmetric: false },
      [sf.id],
    ));
    tree.addFeature(createRevolveFeature(Math.PI, [sf.id]));
    tree.addFeature(createSweepFeature({ path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }], twist: 0.5 }, [sf.id]));
    tree.addFeature(createLoftFeature({}, [sf.id]));
    tree.addFeature(createFilletFeature([], 2, [sf.id]));
    tree.addFeature(createChamferFeature([], 1, [sf.id]));
    tree.addFeature(createShellFeature([], 1.5, [sf.id]));
    tree.addFeature(createLinearArrayFeature({ x: 1, y: 0, z: 0 }, 3, 10, [sf.id]));
    tree.addFeature(createCircularArrayFeature({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, 6, [sf.id]));
    tree.addFeature(createMirrorFeature({ origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, [sf.id]));
    return tree;
  }

  it('creates one feature of each of the 11 types', () => {
    const tree = buildTreeWithEveryType();
    expect(tree.features).toHaveLength(11);
    const types = new Set(tree.features.map((f) => f.type));
    expect(types.has('sweep')).toBe(true);
    expect(types.has('loft')).toBe(true);
  });

  it('every feature type survives serialize → deserialize', () => {
    const tree = buildTreeWithEveryType();
    const json = saveToFile(serializeProject('All', tree.features, []));
    const back = deserializeFeatures(loadFromFile(json));
    expect(back.map((f) => f.type)).toEqual(tree.features.map((f) => f.type));
    // Parameters survive too (spot-check the numeric ones).
    const fillet = back.find((f) => f.type === 'fillet');
    expect(fillet && fillet.type === 'fillet' && fillet.params.radius).toBe(2);
    const array = back.find((f) => f.type === 'linearArray');
    expect(array && array.type === 'linearArray' && array.params.count).toBe(3);
    const mirror = back.find((f) => f.type === 'mirror');
    expect(mirror && mirror.type === 'mirror' && mirror.params.keepOriginal).toBe(true);
  });

  it('suppressing a feature removes its bodies from the tree output', () => {
    const tree = buildTreeWithEveryType();
    tree.recompute();
    const before = tree.getLatestBodies().length;
    tree.updateFeature(tree.features[1]!.id, (f) => ({ ...f, suppressed: true }));
    tree.recompute();
    // The extrude feature (and its dependents) no longer produce bodies.
    expect(tree.getLatestBodies().length).toBeLessThan(before);
  });
});

// --- Rendered-dialog coverage: CAD-style expression input in NumericEditDialog
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

describe('NumericEditDialog expression fields (rendered dialog)', () => {
  let filletId = '';

  beforeEach(() => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sketchFeature = createSketchFeature(sketch);
    const tree = new FeatureTree();
    tree.addFeature(sketchFeature);
    const fillet = createFilletFeature([], 2, [sketchFeature.id]);
    tree.addFeature(fillet);
    filletId = fillet.id;
    useStore.setState({
      featureTree: tree,
      directBodies: [],
      bodies: [],
      undoStack: [],
      selectedIds: [],
    });
  });

  it('editing a fillet radius with "20/2" applies 10', async () => {
    const fillet = useStore.getState().featureTree.features
      .find((f) => f.id === filletId)!;
    const mounted = await mountDialog(
      createElement(FeatureEditDialog, { feature: fillet, onClose: () => {} }),
    );
    try {
      // The radius field is the dialog's first (and only) input.
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      expect(input.value).toBe('2');

      await typeInto(input, '20/2');
      expect(input.value).toBe('20/2');
      expect(mounted.container.textContent).toContain('= 10');
      expect(applyButton(mounted.container).disabled).toBe(false);

      await act(async () => {
        applyButton(mounted.container).click();
      });
      const updated = useStore.getState().featureTree.features
        .find((f) => f.type === 'fillet');
      expect(updated && updated.type === 'fillet' && updated.params.radius).toBe(10);
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('invalid text disables Apply and commits nothing', async () => {
    const fillet = useStore.getState().featureTree.features
      .find((f) => f.id === filletId)!;
    const mounted = await mountDialog(
      createElement(FeatureEditDialog, { feature: fillet, onClose: () => {} }),
    );
    try {
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      await typeInto(input, 'abc');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(applyButton(mounted.container).disabled).toBe(true);

      await act(async () => {
        applyButton(mounted.container).click();
      });
      const unchanged = useStore.getState().featureTree.features
        .find((f) => f.type === 'fillet');
      expect(unchanged && unchanged.type === 'fillet' && unchanged.params.radius).toBe(2);
    } finally {
      await unmountDialog(mounted);
    }
  });
});
