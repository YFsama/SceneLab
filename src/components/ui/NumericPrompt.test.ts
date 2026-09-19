import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { FeatureTree } from '../../lib/features/tree';
import { createBox } from '../../lib/geometry/brep';
import { NumericPromptDialog } from './NumericPrompt';

// Real coverage for the store-driven numeric prompt that replaced every
// window.prompt in the context menus. The expression-input cases below render
// the real dialog (jsdom + createRoot + act) and type into the actual input,
// so evaluation, preview and commit run through the component's own code.
describe('numeric prompt state', () => {
  beforeEach(() => {
    useStore.setState({ numericPrompt: null });
  });

  it('opens with a payload and closes', () => {
    useStore.getState().openNumericPrompt({
      titleKey: 'feature.fillet',
      labelKey: 'feature.filletPrompt',
      initial: 2,
      min: 0.01,
      onApply: () => {},
    });
    const p = useStore.getState().numericPrompt;
    expect(p).not.toBeNull();
    expect(p!.titleKey).toBe('feature.fillet');
    expect(p!.min).toBe(0.01);
    useStore.getState().closeNumericPrompt();
    expect(useStore.getState().numericPrompt).toBeNull();
  });

  it('a real flow: prompt value drives a fillet on a direct body', () => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      undoStack: [],
      selectedIds: [],
    });
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    let applied = 0;
    useStore.getState().openNumericPrompt({
      titleKey: 'feature.fillet',
      labelKey: 'feature.filletPrompt',
      initial: 1.5,
      min: 0.01,
      onApply: (v) => {
        applied = v;
        useStore.getState().applyFilletFeature(v);
      },
    });
    const p = useStore.getState().numericPrompt!;
    // Simulate the dialog's Apply button: close, then run the callback.
    useStore.getState().closeNumericPrompt();
    p.onApply(1.5);

    expect(applied).toBe(1.5);
    const body = useStore.getState().bodies.find((b) => b.id === box.id)!;
    expect(body.faces.length).toBeGreaterThan(box.faces.length);
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

async function pressKey(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

/** The right-most button is the confirm/apply action in every dialog. */
function applyButton(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll('button');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

describe('numeric prompt expression input (rendered dialog)', () => {
  beforeEach(() => {
    useStore.setState({ numericPrompt: null });
  });

  async function openPrompt(onApply: (v: number) => void): Promise<Mounted> {
    useStore.setState({
      numericPrompt: {
        titleKey: 'feature.fillet',
        labelKey: 'feature.filletPrompt',
        initial: 1.5,
        min: 0.01,
        onApply,
      },
    });
    return mountDialog(createElement(NumericPromptDialog));
  }

  it('typing "20/2" previews "= 10" and commits the evaluated 10', async () => {
    let applied: number | null = null;
    const mounted = await openPrompt((v) => { applied = v; });
    try {
      const input = mounted.container.querySelector('#numeric-prompt-input') as HTMLInputElement;
      expect(input.value).toBe('1.5'); // initial value preserved

      await typeInto(input, '20/2');
      expect(input.value).toBe('20/2'); // raw expression survives in the field
      expect(mounted.container.textContent).toContain('= 10');
      expect(applyButton(mounted.container).disabled).toBe(false);

      await clickEl(applyButton(mounted.container));
      expect(applied).toBe(10);
      expect(useStore.getState().numericPrompt).toBeNull();
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('Enter commits the evaluated expression value', async () => {
    let applied: number | null = null;
    const mounted = await openPrompt((v) => { applied = v; });
    try {
      const input = mounted.container.querySelector('#numeric-prompt-input') as HTMLInputElement;
      await typeInto(input, '(30-6)/3');
      await pressKey(input, 'Enter');
      expect(applied).toBe(8);
      expect(useStore.getState().numericPrompt).toBeNull();
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('invalid text is refused inline: red-flagged, Apply disabled, prompt stays open', async () => {
    let called = false;
    const mounted = await openPrompt(() => { called = true; });
    try {
      const input = mounted.container.querySelector('#numeric-prompt-input') as HTMLInputElement;
      await typeInto(input, '5+');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const apply = applyButton(mounted.container);
      expect(apply.disabled).toBe(true);

      await clickEl(apply); // disabled click must be a no-op
      expect(called).toBe(false);
      expect(useStore.getState().numericPrompt).not.toBeNull();
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('an expression evaluating below min keeps the existing too-small rule', async () => {
    let called = false;
    const mounted = await openPrompt(() => { called = true; });
    try {
      const input = mounted.container.querySelector('#numeric-prompt-input') as HTMLInputElement;
      // 0.005 > 0 evals fine but is below min 0.01 → same refusal as before.
      await typeInto(input, '0.01/2');
      expect(mounted.container.textContent).toContain('Value must be greater than');
      expect(applyButton(mounted.container).disabled).toBe(true);
      expect(called).toBe(false);
    } finally {
      await unmountDialog(mounted);
    }
  });
});
