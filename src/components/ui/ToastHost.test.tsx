import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToastHost } from './ToastHost';
import { showToast, clearToasts } from '../../lib/toast';
import { copyText } from '../../lib/errorLog';
import { useStore } from '../../store/app';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearToasts();
  useStore.setState({ locale: 'en' });
  writeText = vi.fn(async (text: string) => text);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  clearToasts();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
});

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountHost(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ToastHost />);
  });
  return { container, root };
}

async function unmountHost({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function copyButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Copy message',
  ) as HTMLButtonElement | undefined;
}

describe('ToastHost error copy button', () => {
  it('renders nothing without toasts', async () => {
    const m = await mountHost();
    expect(m.container.textContent).toBe('');
    await unmountHost(m);
  });

  it('error toasts get a copy button that copies the message', async () => {
    const m = await mountHost();
    await act(async () => {
      showToast('Export failed: mesh was empty', 'error', 60000);
    });
    expect(m.container.textContent).toContain('Export failed: mesh was empty');

    const btn = copyButton(m.container);
    expect(btn).toBeTruthy();
    await clickEl(btn!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe('Export failed: mesh was empty');
    // Copied state: the icon briefly swaps to a check.
    expect(btn!.querySelector('svg')?.getAttribute('class')).toContain('lucide-check');
    await unmountHost(m);
  });

  it('non-error toasts have no copy button', async () => {
    const m = await mountHost();
    await act(async () => {
      showToast('Saved', 'success', 60000);
      showToast('Heads up', 'warning', 60000);
      showToast('FYI', 'info', 60000);
    });
    expect(copyButton(m.container)).toBeUndefined();
    await unmountHost(m);
  });

  it('falls back to the legacy clipboard path when the API is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const m = await mountHost();
    await act(async () => {
      showToast('Legacy copy', 'error', 60000);
    });
    await clickEl(copyButton(m.container)!);
    expect(exec).toHaveBeenCalledWith('copy');
    document.execCommand = () => true;
    await unmountHost(m);
  });

  it('a failed copy does not flip the icon to a check', async () => {
    const failing = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: failing },
      configurable: true,
      writable: true,
    });
    const exec = vi.fn(() => false);
    document.execCommand = exec;
    const m = await mountHost();
    await act(async () => {
      showToast('Cannot copy me', 'error', 60000);
    });
    const btn = copyButton(m.container)!;
    await clickEl(btn);
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('lucide-copy');
    document.execCommand = () => true;
    await unmountHost(m);
  });

  it('copyText integration: the module-level helper respects the mocked clipboard', async () => {
    await expect(copyText('via helper')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('via helper');
  });
});
