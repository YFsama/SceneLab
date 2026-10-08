import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { getRecentErrors, resetErrorLogForTest } from '../../lib/errorLog';
import { useStore } from '../../store/app';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// React logs every boundary catch through console.error — silence it so the
// test output stays readable (the log entry itself is asserted separately).
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetErrorLogForTest();
  useStore.setState({ locale: 'en' });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

async function unmount({ container, root }: Mounted): Promise<void> {
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

function byAriaLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
  if (!el) throw new Error(`button "${label}" not found`);
  return el as HTMLButtonElement;
}

function Bomb(): never {
  throw new Error('kaboom: render failed');
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', async () => {
    const m = await mount(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(m.container.textContent).toContain('all good');
    await unmount(m);
  });

  it('shows the crash fallback and records the error when a child throws', async () => {
    const m = await mount(
      <ErrorBoundary><Bomb /></ErrorBoundary>,
    );
    expect(m.container.textContent).toContain('Something went wrong');
    expect(m.container.textContent).toContain('kaboom: render failed');
    const logged = getRecentErrors();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.kind).toBe('react');
    expect(logged[0]!.message).toBe('kaboom: render failed');
    await unmount(m);
  });

  it('recovers after "Try to continue" resets the boundary', async () => {
    let armed = true;
    function Flaky(): ReactNode {
      if (armed) throw new Error('flaky failure');
      return <p>recovered content</p>;
    }
    const m = await mount(
      <ErrorBoundary><Flaky /></ErrorBoundary>,
    );
    expect(m.container.textContent).toContain('flaky failure');

    armed = false;
    await clickEl(byAriaLabel(m.container, 'Try to continue'));
    expect(m.container.textContent).toContain('recovered content');
    // The boundary can catch again: re-arming throws a fresh, logged error.
    armed = true;
    await act(async () => {
      // Any re-render of the recovered subtree re-runs the throw.
      m.root.render(<ErrorBoundary><Flaky /></ErrorBoundary>);
    });
    expect(m.container.textContent).toContain('flaky failure');
    expect(getRecentErrors().filter((e) => e.kind === 'react')).toHaveLength(2);
    await unmount(m);
  });

  it('copies the diagnostics report to the clipboard and confirms', async () => {
    const writeText = vi.fn(async (text: string) => text);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const m = await mount(
      <ErrorBoundary><Bomb /></ErrorBoundary>,
    );
    const btn = byAriaLabel(m.container, 'Copy error report');
    expect(btn.textContent).toBe('Copy error report');
    await clickEl(btn);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('SceneLab diagnostics');
    expect(writeText.mock.calls[0]![0]).toContain('kaboom: render failed');
    expect(btn.textContent).toBe('Error report copied — please paste it into a bug report');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    await unmount(m);
  });

  it('offers a reload action on the fallback', async () => {
    // jsdom's window.location is non-configurable, so the real reload() can't
    // be spied — assert the button is present and wired with its label.
    const m = await mount(
      <ErrorBoundary><Bomb /></ErrorBoundary>,
    );
    expect(() => byAriaLabel(m.container, 'Reload app')).not.toThrow();
    await unmount(m);
  });
});
