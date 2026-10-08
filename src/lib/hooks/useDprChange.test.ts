import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDprChange } from './useDprChange';

// jsdom ships neither matchMedia nor a mutable devicePixelRatio; install a
// controllable pair and exercise the hook's re-arming ladder against them.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const armedQueries: string[] = [];

class FakeMediaQueryList {
  readonly media: string;
  private readonly listeners = new Set<(e: Event) => void>();
  constructor(query: string) {
    this.media = query;
    armedQueries.push(query);
  }
  addEventListener(_type: 'change', listener: (e: Event) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'change', listener: (e: Event) => void): void {
    this.listeners.delete(listener);
  }
  /** Test-side: dispatch the change event to whatever is listening. */
  fire(): void {
    for (const l of [...this.listeners]) l(new Event('change'));
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

let lastMql: FakeMediaQueryList | null = null;
const fakeMatchMedia = (query: string): MediaQueryList =>
  (lastMql = new FakeMediaQueryList(query)) as unknown as MediaQueryList;

function setDpr(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
}

function Probe({ cb }: { cb: (dpr: number) => void }) {
  useDprChange(cb);
  return null;
}

interface Mounted { root: Root; container: HTMLDivElement }

async function mountProbe(cb: (dpr: number) => void): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe, { cb })); });
  return { root, container };
}

async function unmountProbe({ root, container }: Mounted): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

describe('useDprChange', () => {
  beforeAll(() => {
    window.matchMedia = fakeMatchMedia as unknown as typeof window.matchMedia;
  });
  afterAll(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    setDpr(1);
  });

  it('arms a resolution query at the current DPR and stays quiet until it flips', async () => {
    setDpr(2);
    armedQueries.length = 0;
    const cb = vi.fn();
    const m = await mountProbe(cb);
    try {
      expect(armedQueries).toEqual(['(resolution: 2dppx)']);
      expect(cb).not.toHaveBeenCalled();
      // A spurious no-change event (same DPR) still re-arms identically and
      // fires — but with the same value, which consumers dedup themselves.
      setDpr(2);
      lastMql!.fire();
      expect(cb).toHaveBeenCalledWith(2);
      expect(armedQueries).toEqual(['(resolution: 2dppx)', '(resolution: 2dppx)']);
    } finally {
      await unmountProbe(m);
    }
  });

  it('re-arms at each new DPR as the ratio climbs and falls', async () => {
    setDpr(1);
    armedQueries.length = 0;
    const cb = vi.fn();
    const m = await mountProbe(cb);
    try {
      const first = lastMql!;
      setDpr(1.5);
      first.fire();
      expect(cb).toHaveBeenLastCalledWith(1.5);
      // The old query was disarmed before the callback ran…
      expect(first.listenerCount).toBe(0);
      // …and a new one armed at the fresh ratio.
      expect(armedQueries).toEqual(['(resolution: 1dppx)', '(resolution: 1.5dppx)']);

      const second = lastMql!;
      setDpr(3);
      second.fire();
      expect(cb).toHaveBeenLastCalledWith(3);
      expect(armedQueries.at(-1)).toBe('(resolution: 3dppx)');
    } finally {
      await unmountProbe(m);
    }
  });

  it('removes the listener on unmount (no callbacks after)', async () => {
    setDpr(2);
    const cb = vi.fn();
    const m = await mountProbe(cb);
    const armed = lastMql!;
    await unmountProbe(m);
    setDpr(1);
    armed.fire();
    expect(cb).not.toHaveBeenCalled();
    expect(armed.listenerCount).toBe(0);
  });

  it('no-ops where matchMedia is missing', async () => {
    const real = window.matchMedia;
    delete (window as { matchMedia?: unknown }).matchMedia;
    const cb = vi.fn();
    try {
      const m = await mountProbe(cb); // must not throw
      await unmountProbe(m);
    } finally {
      window.matchMedia = real;
    }
    expect(cb).not.toHaveBeenCalled();
  });
});
