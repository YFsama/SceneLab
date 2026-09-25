import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { CommandPalette } from './CommandPalette';
import { clearCommands, initBuiltinCommands } from '../../lib/commands/registry';

// Real coverage for the Ctrl+K command palette: the tests render the actual
// component (jsdom + createRoot + act, the project's mount-harness style —
// there is no testing-library), seed the real builtin registry, type into the
// real <input> and press the real keys. Command execution is observed through
// the `scenelab:fit-view` window event the palette-only zoom commands dispatch.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement scrollIntoView; the palette keeps the highlighted
// row visible with it while arrowing through a long list.
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
});

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountPalette(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(CommandPalette));
  });
  return { container, root };
}

async function unmountPalette({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function openPalette(mounted: Mounted): Promise<HTMLInputElement> {
  await act(async () => {
    useStore.getState().setCommandPaletteOpen(true);
  });
  const input = mounted.container.querySelector('[role="dialog"] input') as HTMLInputElement;
  expect(input).toBeTruthy();
  return input;
}

/** Type into the controlled React input the way a real keystroke does. */
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

/** The command rows are the <button>s inside the results list. */
function resultButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('[role="dialog"] ul button')] as HTMLButtonElement[];
}

/** The highlighted row carries the accent background class. */
function isActive(btn: HTMLButtonElement): boolean {
  return btn.className.includes('bg-accent/20');
}

describe('CommandPalette', () => {
  beforeEach(() => {
    clearCommands();
    initBuiltinCommands();
    useStore.setState({ commandPaletteOpen: false, locale: 'en' });
  });

  it('renders nothing while closed and opens focused on the full command list', async () => {
    const mounted = await mountPalette();
    try {
      expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
      const input = await openPalette(mounted);
      expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
      // Autofocused, ready to type — no click needed.
      expect(document.activeElement).toBe(input);
      // Every builtin command is listed while the query is empty.
      expect(resultButtons(mounted.container).length).toBeGreaterThan(30);
    } finally {
      await unmountPalette(mounted);
    }
  });

  it('typing "zoom" filters to the zoom commands; gibberish empties the list', async () => {
    const mounted = await mountPalette();
    try {
      const input = await openPalette(mounted);
      await typeInto(input, 'zoom');
      const buttons = resultButtons(mounted.container);
      expect(buttons.length).toBe(2);
      expect(mounted.container.textContent).toContain('Zoom to fit (F)');
      expect(mounted.container.textContent).toContain('Zoom to selection (Shift+F)');

      await typeInto(input, 'zzqqx');
      expect(resultButtons(mounted.container).length).toBe(0);
      expect(mounted.container.textContent).toContain('No matching commands');
    } finally {
      await unmountPalette(mounted);
    }
  });

  it('ArrowDown moves the selection and clamps at the last result', async () => {
    const mounted = await mountPalette();
    try {
      const input = await openPalette(mounted);
      await typeInto(input, 'zoom');
      const [first, second] = resultButtons(mounted.container);
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      // The first result starts highlighted (query resets the selection).
      expect(isActive(first!)).toBe(true);
      expect(isActive(second!)).toBe(false);

      await pressKey(input, 'ArrowDown');
      expect(isActive(first!)).toBe(false);
      expect(isActive(second!)).toBe(true);

      // Clamped: a further ArrowDown stays on the last row.
      await pressKey(input, 'ArrowDown');
      expect(isActive(first!)).toBe(false);
      expect(isActive(second!)).toBe(true);
    } finally {
      await unmountPalette(mounted);
    }
  });

  it('Enter executes the highlighted command via the scenelab:fit-view event and closes', async () => {
    const events: CustomEvent[] = [];
    const onFit = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('scenelab:fit-view', onFit);
    const mounted = await mountPalette();
    try {
      let input = await openPalette(mounted);
      // Highlighted row 0 is "Zoom to fit" → fit ALL (selection: false).
      await typeInto(input, 'zoom');
      await pressKey(input, 'Enter');
      expect(events.length).toBe(1);
      expect(events[0]!.detail).toEqual({ selection: false });
      expect(useStore.getState().commandPaletteOpen).toBe(false);
      expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();

      // ArrowDown first → "Zoom to selection" runs instead (selection: true).
      // The inner panel remounts fresh on reopen — grab the new input node.
      input = await openPalette(mounted);
      await typeInto(input, 'zoom');
      await pressKey(input, 'ArrowDown');
      await pressKey(input, 'Enter');
      expect(events.length).toBe(2);
      expect(events[1]!.detail).toEqual({ selection: true });
      expect(useStore.getState().commandPaletteOpen).toBe(false);
    } finally {
      window.removeEventListener('scenelab:fit-view', onFit);
      await unmountPalette(mounted);
    }
  });

  it('Escape closes the palette without running anything', async () => {
    const onFit = vi.fn();
    window.addEventListener('scenelab:fit-view', onFit);
    const mounted = await mountPalette();
    try {
      const input = await openPalette(mounted);
      await typeInto(input, 'zoom');
      await pressKey(input, 'Escape');
      expect(useStore.getState().commandPaletteOpen).toBe(false);
      expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
      expect(onFit).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('scenelab:fit-view', onFit);
      await unmountPalette(mounted);
    }
  });
});
