import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiagnosticsDialog } from './DiagnosticsDialog';
import {
  recordError, getRecentErrors, formatErrorEntry, resetErrorLogForTest,
  openDiagnostics, OPEN_DIAGNOSTICS_EVENT,
} from '../../lib/errorLog';
import { getToasts, clearToasts } from '../../lib/toast';
import { useStore } from '../../store/app';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let consoleError: ReturnType<typeof vi.spyOn>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetErrorLogForTest();
  clearToasts();
  useStore.setState({ locale: 'en' });
  writeText = vi.fn(async (text: string) => text);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
});

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountDialog(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DiagnosticsDialog />);
  });
  return { container, root };
}

async function unmountDialog({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function open(): Promise<void> {
  await act(async () => {
    openDiagnostics();
  });
}

async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function byAriaLabel(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
  if (!el) throw new Error(`button "${label}" not found`);
  return el as HTMLElement;
}

describe('DiagnosticsDialog', () => {
  it('renders nothing until the open event fires, then shows the dialog', async () => {
    const m = await mountDialog();
    expect(m.container.textContent).not.toContain('Diagnostics');
    await open();
    expect(m.container.getAttribute('role') ?? m.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(m.container.textContent).toContain('Diagnostics');
    // Environment rows are present with the version and platform.
    expect(m.container.textContent).toContain('Version');
    expect(m.container.textContent).toContain('Platform');
    await unmountDialog(m);
  });

  it('opens via the exported event name as well (palette wiring)', async () => {
    const m = await mountDialog();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_DIAGNOSTICS_EVENT));
    });
    expect(m.container.textContent).toContain('Diagnostics');
    await unmountDialog(m);
  });

  it('lists recorded errors with a working per-entry copy button', async () => {
    const entry = recordError('error', 'boom in export', '    at f (export.ts:9)');
    const m = await mountDialog();
    await open();
    expect(m.container.textContent).toContain('boom in export');
    expect(m.container.textContent).toContain('Recent errors (1)');

    await clickEl(byAriaLabel(m.container, 'Copy message'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe(formatErrorEntry(entry));
    await unmountDialog(m);
  });

  it('shows the no-errors placeholder when the log is empty', async () => {
    const m = await mountDialog();
    await open();
    expect(m.container.textContent).toContain('No errors recorded this session');
    await unmountDialog(m);
  });

  it('closes on Escape', async () => {
    const m = await mountDialog();
    await open();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(m.container.textContent ?? '').not.toContain('Diagnostics');
    await unmountDialog(m);
  });

  it('copy report button copies the full diagnostics report', async () => {
    recordError('error', 'in the report');
    const m = await mountDialog();
    await open();
    await clickEl(byAriaLabel(m.container, 'Copy report'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('SceneLab diagnostics');
    expect(writeText.mock.calls[0]![0]).toContain('in the report');
    await unmountDialog(m);
  });

  it('clear log empties the list and the error log', async () => {
    recordError('error', 'to be cleared');
    const m = await mountDialog();
    await open();
    await clickEl(byAriaLabel(m.container, 'Clear log'));
    expect(getRecentErrors()).toHaveLength(0);
    expect(m.container.textContent).toContain('No errors recorded this session');
    await unmountDialog(m);
  });

  it('saves the report via a browser download on the web platform', async () => {
    const createObjectURL = vi.fn(() => 'blob:diagnostics');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window.URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(window.URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
    const m = await mountDialog();
    await open();
    await clickEl(byAriaLabel(m.container, 'Save report…'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const toasts = getToasts();
    expect(toasts.some((t) => t.type === 'success' && /Report saved to scenelab-diagnostics-/.test(t.message))).toBe(true);
    await unmountDialog(m);
  });

  it('opens the pre-filled feedback page after copying the report', async () => {
    let openedUrl = '';
    const open_ = vi.fn((url: string | URL): null => {
      openedUrl = String(url);
      return null;
    });
    Object.defineProperty(window, 'open', { value: open_, configurable: true, writable: true });
    recordError('error', 'feedback error');
    const m = await mountDialog();
    await open();
    await clickEl(byAriaLabel(m.container, 'Open feedback page'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(open_).toHaveBeenCalledTimes(1);
    const url = openedUrl;
    expect(url).toContain('github.com');
    expect(url).toContain('title=SceneLab+diagnostics');
    // URLSearchParams encodes spaces as '+' (not %20).
    expect(url).toContain('feedback+error');
    expect(getToasts().some((t) => t.message.includes('paste it into the issue'))).toBe(true);
    await unmountDialog(m);
  });
});
