import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { SectionPanel } from './SectionPanel';

// Real coverage for the Fusion-style live section-analysis panel: the tests
// render the actual component (jsdom + createRoot + act, the project's
// mount-harness style — there is no testing-library) in the model workspace
// and click the real buttons / drag the real slider, asserting the store's
// sectionAnalysis state after each interaction (viewport-only: geometry is
// never touched).

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
    root.render(createElement(SectionPanel));
  });
  return { container, root };
}

async function unmountPanel({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Move a controlled React range slider like a real drag would. */
async function setSlider(input: HTMLInputElement, value: number): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function section() {
  return useStore.getState().sectionAnalysis;
}

describe('SectionPanel (live section analysis)', () => {
  beforeEach(() => {
    useStore.setState({
      workspace: 'model',
      bodies: [],
      locale: 'en',
      sectionAnalysis: { active: false, axis: 'z', offset: 0, flip: false },
    });
  });

  it('renders collapsed in the model workspace; the toggle activates section analysis', async () => {
    const mounted = await mountPanel();
    try {
      // The floating scissors toggle is always there; the controls only exist
      // while section analysis is active.
      const toggle = mounted.container.querySelector('button[aria-label="Section analysis"]') as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(mounted.container.querySelector('[role="group"]')).toBeNull();

      await clickEl(toggle);
      expect(section().active).toBe(true);
      const group = mounted.container.querySelector('[role="group"]');
      expect(group).not.toBeNull();
      expect(group!.getAttribute('aria-label')).toBe('Section analysis');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('the X/Y/Z axis tabs switch the store axis (and reset the offset)', async () => {
    const mounted = await mountPanel();
    try {
      await clickEl(mounted.container.querySelector('button[aria-label="Section analysis"]')!);
      // Pre-condition: slide the offset off zero so the reset is observable.
      const slider = mounted.container.querySelector('input[aria-label="Offset"]') as HTMLInputElement;
      await setSlider(slider, 12.5);
      expect(section().offset).toBe(12.5);

      const tabs = [...mounted.container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
      expect(taps(tabs)).toEqual(['X', 'Y', 'Z']);
      const y = tabs.find((t) => t.textContent === 'Y')!;
      await clickEl(y);
      expect(section().axis).toBe('y');
      expect(section().offset).toBe(0); // switching axis re-centres the plane
      expect(y.getAttribute('aria-selected')).toBe('true');
      expect(tabs.find((t) => t.textContent === 'Z')!.getAttribute('aria-selected')).toBe('false');

      const x = tabs.find((t) => t.textContent === 'X')!;
      await clickEl(x);
      expect(section().axis).toBe('x');
      expect(x.getAttribute('aria-selected')).toBe('true');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('the offset slider updates the store offset within the empty-scene range', async () => {
    const mounted = await mountPanel();
    try {
      await clickEl(mounted.container.querySelector('button[aria-label="Section analysis"]')!);
      const slider = mounted.container.querySelector('input[aria-label="Offset"]') as HTMLInputElement;
      expect(slider).toBeTruthy();
      // Empty scene → the sweep covers the default ±50 mm range.
      expect(Number(slider.min)).toBe(-50);
      expect(Number(slider.max)).toBe(50);

      await setSlider(slider, -7.5);
      expect(section().offset).toBe(-7.5);
      // The readout next to the slider shows the live value.
      expect(mounted.container.textContent).toContain('-7.5 mm');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('Flip toggles which half is kept', async () => {
    const mounted = await mountPanel();
    try {
      await clickEl(mounted.container.querySelector('button[aria-label="Section analysis"]')!);
      const flip = mounted.container.querySelector('button[aria-label="Flip side"]') as HTMLButtonElement;
      expect(flip).toBeTruthy();
      expect(flip.getAttribute('aria-pressed')).toBe('false');

      await clickEl(flip);
      expect(section().flip).toBe(true);
      expect(flip.getAttribute('aria-pressed')).toBe('true');

      await clickEl(flip);
      expect(section().flip).toBe(false);
      expect(flip.getAttribute('aria-pressed')).toBe('false');
    } finally {
      await unmountPanel(mounted);
    }
  });

  it('toggling off clears the active section (panel collapses, state stays configurable)', async () => {
    const mounted = await mountPanel();
    try {
      const toggle = mounted.container.querySelector('button[aria-label="Section analysis"]')!;
      await clickEl(toggle);
      // Leave a non-default configuration behind…
      await clickEl(mounted.container.querySelector('button[aria-label="Flip side"]')!);
      expect(section().active).toBe(true);

      // …then toggle off via the same scissors button.
      await clickEl(mounted.container.querySelector('button[aria-label="Section analysis"]')!);
      expect(section().active).toBe(false);
      expect(mounted.container.querySelector('[role="group"]')).toBeNull();
      expect(toggle.getAttribute('aria-pressed')).toBe('false');

      // The panel's Close (X) button also deactivates.
      await clickEl(toggle);
      const close = mounted.container.querySelector('[role="group"] button[aria-label="Close"]') as HTMLButtonElement;
      expect(close).toBeTruthy();
      await clickEl(close);
      expect(section().active).toBe(false);
      expect(mounted.container.querySelector('[role="group"]')).toBeNull();
    } finally {
      await unmountPanel(mounted);
    }
  });
});

/** Visible labels of the tab row (X, Y, Z in registration order). */
function taps(tabs: HTMLButtonElement[]): string[] {
  return tabs.map((t) => t.textContent ?? '');
}
