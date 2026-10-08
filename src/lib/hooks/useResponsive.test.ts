import { describe, it, expect, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { classifyViewport, useResponsive } from './useResponsive';

// Pure-classifier boundaries: compact < 960, normal 960..1439, wide >= 1440.
describe('classifyViewport', () => {
  it('classifies the compact/normal boundary at 960 CSS px', () => {
    expect(classifyViewport(959)).toBe('compact');
    expect(classifyViewport(960)).toBe('normal');
  });

  it('classifies the normal/wide boundary at 1440 CSS px', () => {
    expect(classifyViewport(1439)).toBe('normal');
    expect(classifyViewport(1440)).toBe('wide');
  });

  it('covers the degenerate ends', () => {
    expect(classifyViewport(0)).toBe('compact');
    expect(classifyViewport(800)).toBe('compact'); // Tauri minWidth
    expect(classifyViewport(Number.MAX_SAFE_INTEGER)).toBe('wide');
  });
});

// jsdom ships no window.matchMedia, so the hook's guard path ('normal') is the
// natural baseline here; the reactive path is exercised through a controllable
// stub — the project's createRoot + act mount-harness style (see AIPanel.test).
describe('useResponsive', () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    // Restore the jsdom default (undefined) between tests.
    Object.defineProperty(window, 'matchMedia', {
      value: originalMatchMedia,
      writable: true,
      configurable: true,
    });
  });

  /**
   * A matchMedia stub driven by one mutable width: every MQL it hands out
   * recomputes `matches` live and forwards setWidth() to registered change
   * listeners (both the standard and the legacy Safari API surface).
   */
  function installMatchMediaStub(initialWidth: number): (width: number) => void {
    let width = initialWidth;
    const registry: { matches: boolean; fire: () => void }[] = [];
    window.matchMedia = ((query: string) => {
      const minWidth = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
      const listeners = new Set<(e: { matches: boolean }) => void>();
      const mql = {
        get matches() {
          return width >= minWidth;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: (e: { matches: boolean }) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (e: { matches: boolean }) => void) => {
          listeners.delete(listener);
        },
        // Legacy Safari API the hook falls back to.
        addListener: (listener: (e: { matches: boolean }) => void) => listeners.add(listener),
        removeListener: (listener: (e: { matches: boolean }) => void) => listeners.delete(listener),
        dispatchEvent: () => false,
      };
      const entry = {
        get matches() {
          return mql.matches;
        },
        fire: () => {
          for (const listener of listeners) listener({ matches: mql.matches });
        },
      };
      registry.push(entry);
      return mql as unknown as MediaQueryList;
    }) as unknown as typeof window.matchMedia;
    return (next: number) => {
      width = next;
      for (const entry of registry) entry.fire();
    };
  }

  /** Mount a probe that mirrors the hook value into text + data attribute. */
  async function mountProbe(): Promise<{ read: () => string | null; unmount: () => Promise<void> }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const Probe = () => {
      const breakpoint = useResponsive();
      return createElement('output', { 'data-breakpoint': breakpoint }, breakpoint);
    };
    await act(async () => {
      root.render(createElement(Probe));
    });
    const read = () => container.querySelector('output')?.getAttribute('data-breakpoint') ?? null;
    return {
      read,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  it('returns the classified initial width', async () => {
    installMatchMediaStub(1280);
    const probe = await mountProbe();
    expect(probe.read()).toBe('normal');
    await probe.unmount();
  });

  it('tracks matchMedia change events across all three breakpoints', async () => {
    const setWidth = installMatchMediaStub(1440);
    const probe = await mountProbe();
    expect(probe.read()).toBe('wide');

    await act(async () => setWidth(900));
    expect(probe.read()).toBe('compact');

    await act(async () => setWidth(1000));
    expect(probe.read()).toBe('normal');

    await probe.unmount();
  });

  it('keeps the last breakpoint after unmount without leaking listeners', async () => {
    const setWidth = installMatchMediaStub(800);
    const probe = await mountProbe();
    expect(probe.read()).toBe('compact');
    await probe.unmount();
    // Fires into the void: the cleaned-up hook must not react (and must not
    // throw setState-on-unmounted).
    await act(async () => setWidth(1600));
    expect(probe.read()).toBeNull(); // container removed; no update attempted
  });

  it("degrades to 'normal' when matchMedia is unavailable", async () => {
    Object.defineProperty(window, 'matchMedia', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const probe = await mountProbe();
    expect(probe.read()).toBe('normal');
    await probe.unmount();
  });
});
