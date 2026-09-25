import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { ParametersPanel, OPEN_PARAMETERS_EVENT } from './ParametersPanel';
import { createSketchFeature, createExtrudeFeature } from '../../lib/features/tree';
import { createSketch, addRectangle, addCircle, addConstraint } from '../../lib/sketch/engine';
import { computeBoundingBox } from '../../lib/geometry';
import { getCommand, runCommand, initBuiltinCommands, clearCommands } from '../../lib/commands/registry';

// Real coverage for the Parameters dialog: the tests render the actual
// component (jsdom + createRoot + act, the project's mount-harness style —
// there is no testing-library), seed a genuine parametric project through the
// store's own actions (sketch feature → extrude, plus a driving radius
// constraint on the current sketch) and drive the real inline editors.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountPanel(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ParametersPanel />);
  });
  return { container, root };
}

async function unmountPanel({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

/** Open the dialog the way the palette command does. */
async function openDialog(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(OPEN_PARAMETERS_EVENT));
  });
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function pressKey(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Type into a controlled React input the way a real keystroke does. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The inline value editor of a row, located by its aria-label ("Edit value: …"). */
function valueButton(container: HTMLElement, paramLabel: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === `Edit value: ${paramLabel}`,
  );
  if (!el) throw new Error(`value button for "${paramLabel}" not found`);
  return el as HTMLButtonElement;
}

/**
 * Seed a parametric document: a 10×10 rectangle sketch driving a 20 mm
 * extrude, with a 5 mm radius constraint on a sketch circle — the same sketch
 * is the current one, so it contributes driving-dimension rows too.
 */
function seedProject(): void {
  useStore.getState().newProject();
  const sketch = createSketch('xy');
  addRectangle(sketch, -5, -5, 5, 5);
  const circle = addCircle(sketch, 0, 0, 5);
  addConstraint(sketch, 'radius', [circle.id], 5);
  const sf = createSketchFeature(sketch);
  const extrude = createExtrudeFeature(
    { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 20, symmetric: false },
    [sf.id],
  );
  useStore.getState().addFeature(sf);
  useStore.getState().addFeature(extrude);
  useStore.getState().setCurrentSketch(sketch);
}

describe('ParametersPanel (Fusion-style parameters dialog)', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    useStore.getState().setCurrentSketch(null);
    useStore.setState({ locale: 'en' });
  });

  it('renders nothing until the open event fires, then shows the dialog', async () => {
    seedProject();
    const mounted = await mountPanel();
    try {
      expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
      await openDialog();
      const dialog = mounted.container.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.getAttribute('aria-label')).toBe('Parameters');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('lists the seeded feature parameter and sketch dimension with the total count', async () => {
    seedProject();
    const mounted = await mountPanel();
    try {
      await openDialog();
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('2 parameters');
      // Extrude row: type | feature name | parameter label | value + unit.
      expect(text).toContain('Extrude');
      expect(text).toContain('Distance (mm)');
      expect(text).toContain('20mm');
      // Current-sketch driving dimension row.
      expect(text).toContain('Current sketch');
      expect(text).toContain('Radius (mm)');
      expect(text).toContain('5mm');
      // Semantic table structure.
      expect(mounted.container.querySelectorAll('[role="row"]').length).toBeGreaterThanOrEqual(3);
      expect(mounted.container.querySelector('[role="table"]')).not.toBeNull();
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('editing the extrude distance commits on Enter and the tree recomputes', async () => {
    seedProject();
    const versionBefore = useStore.getState().featureVersion;
    const bbBefore = computeBoundingBox(useStore.getState().bodies[0]!);
    expect(bbBefore.max.y - bbBefore.min.y).toBeCloseTo(20, 6); // extrusion height
    const mounted = await mountPanel();
    try {
      await openDialog();
      await clickEl(valueButton(mounted.container, 'Distance (mm)'));
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      expect(input.value).toBe('20');
      await typeInto(input, '30');
      await pressKey(input, 'Enter');

      const st = useStore.getState();
      const extrude = st.featureTree.features.find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(30);
      expect(st.featureVersion).toBeGreaterThan(versionBefore);
      const bb = computeBoundingBox(st.bodies[0]!);
      expect(bb.max.y - bb.min.y).toBeCloseTo(30, 6); // geometry followed the parameter
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('editing a sketch constraint updates the constraint and re-solves the circle', async () => {
    seedProject();
    const mounted = await mountPanel();
    try {
      await openDialog();
      await clickEl(valueButton(mounted.container, 'Radius (mm)'));
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      await typeInto(input, '9');
      await pressKey(input, 'Enter');

      const st = useStore.getState();
      const constraint = [...st.currentSketch!.constraints.values()].find((c) => c.type === 'radius')!;
      expect(constraint.value).toBe(9);
      const circle = [...st.currentSketch!.entities.values()].find((e) => e.type === 'circle') as { radius: number };
      expect(circle.radius).toBeCloseTo(9, 6);
      expect(st.sketchUndoStack).toHaveLength(1); // one undoable sketch edit
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('Escape cancels the inline edit (old value kept, dialog stays open)', async () => {
    seedProject();
    const mounted = await mountPanel();
    try {
      await openDialog();
      await clickEl(valueButton(mounted.container, 'Distance (mm)'));
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      await typeInto(input, '99');
      await pressKey(input, 'Escape');

      const extrude = useStore.getState().featureTree.features.find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(20);
      expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull(); // still open
      // The editor closed — the value is a button again showing the old value.
      expect(valueButton(mounted.container, 'Distance (mm)').textContent).toContain('20');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('empty or non-numeric input keeps the old value', async () => {
    seedProject();
    const mounted = await mountPanel();
    try {
      await openDialog();
      await clickEl(valueButton(mounted.container, 'Distance (mm)'));
      const input = mounted.container.querySelector('input') as HTMLInputElement;
      await typeInto(input, 'abc');
      await pressKey(input, 'Enter');
      let extrude = useStore.getState().featureTree.features.find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(20);

      // Empty input on a second edit also keeps the old value.
      await clickEl(valueButton(mounted.container, 'Distance (mm)'));
      const input2 = mounted.container.querySelector('input') as HTMLInputElement;
      await typeInto(input2, '');
      await pressKey(input2, 'Enter');
      extrude = useStore.getState().featureTree.features.find((f) => f.type === 'extrude');
      expect(extrude && extrude.type === 'extrude' && extrude.params.distance).toBe(20);
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('an empty project shows the empty state', async () => {
    const mounted = await mountPanel();
    try {
      await openDialog();
      expect(mounted.container.textContent).toContain('No parameters yet');
      expect(mounted.container.textContent).toContain('0 parameters');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('suppressed features render dimmed', async () => {
    seedProject();
    const extrude = useStore.getState().featureTree.features.find((f) => f.type === 'extrude')!;
    useStore.getState().updateFeature(extrude.id, (f) => ({ ...f, suppressed: true }));
    const mounted = await mountPanel();
    try {
      await openDialog();
      const row = mounted.container.querySelector('[role="row"][aria-disabled="true"]');
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain('Extrude');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('renders Chinese in the zh locale', async () => {
    seedProject();
    useStore.setState({ locale: 'zh' });
    const mounted = await mountPanel();
    try {
      await openDialog();
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('参数');
      expect(text).toContain('2 个参数');
      expect(text).toContain('距离 (mm)');
      expect(text).toContain('半径 (mm)');
    } finally {
      await unmountPanel(mounted);
      useStore.setState({ locale: 'en' });
    }
  });
});

describe('params.open palette command', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'en' });
    clearCommands();
    initBuiltinCommands();
  });

  it('is registered in the builtin command list', () => {
    const cmd = getCommand('params.open');
    expect(cmd).toBeDefined();
    expect(cmd!.category).toBe('Edit');
  });

  it('opens the dialog through the window event', async () => {
    useStore.getState().newProject();
    useStore.getState().setCurrentSketch(null);
    const mounted = await mountPanel();
    try {
      await act(async () => {
        expect(runCommand('params.open')).toBe(true);
      });
      expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      clearCommands();
      initBuiltinCommands(); // restore the registry for other suites
      await unmountPanel(mounted);
    }
  });

  it('label follows the locale while the panel is mounted', async () => {
    const mounted = await mountPanel();
    try {
      expect(getCommand('params.open')!.label).toBe('Parameters…');
      await act(async () => {
        useStore.setState({ locale: 'zh' });
      });
      expect(getCommand('params.open')!.label).toBe('参数…');
    } finally {
      await unmountPanel(mounted);
      useStore.setState({ locale: 'en' });
    }
  });
});
