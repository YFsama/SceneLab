import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { RestoreBanner } from './RestoreBanner';

// Real coverage for the crash-recovery banner: the tests render the actual
// component (jsdom + createRoot + act, the project's mount-harness style —
// there is no testing-library), seed a genuine autosave through the store's
// own autosave() (so the JSON is exactly what a crashed session leaves
// behind), and click the real buttons / press the real keys.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountBanner(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(RestoreBanner));
  });
  return { container, root };
}

async function unmountBanner({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
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

/** Find a button by its exact visible label. */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!el) throw new Error(`button "${label}" not found`);
  return el as HTMLButtonElement;
}

function banner(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="restore-banner"]');
}

/** Seed a real autosave through the store, exactly like a crashed session. */
function seedAutosave(name = 'Crash Part'): void {
  useStore.getState().newProject();
  useStore.getState().setProjectName(name);
  useStore.getState().addPrimitive('box');
  expect(useStore.getState().autosave()).toBe(true);
}

describe('RestoreBanner (crash-recovery offer)', () => {
  beforeEach(() => {
    localStorage.removeItem('scenelab.autosave');
    useStore.setState({ autosaveProbe: null, locale: 'en' });
  });

  it('renders nothing when no autosave exists', async () => {
    const mounted = await mountBanner();
    try {
      expect(banner(mounted.container)).toBeNull();
      expect(useStore.getState().autosaveProbe).toBeNull();
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('offers the seeded autosave with name and age, without consuming it', async () => {
    seedAutosave('Crash Part');
    const mounted = await mountBanner();
    try {
      expect(banner(mounted.container)).not.toBeNull();
      expect(mounted.container.textContent).toContain('Crash Part');
      expect(mounted.container.textContent).toContain('min ago'); // fresh autosave → "1 min ago"
      expect(button(mounted.container, 'Restore')).toBeTruthy();
      expect(button(mounted.container, 'Discard')).toBeTruthy();
      // Probing is read-only — the stored autosave survives until the user acts.
      expect(localStorage.getItem('scenelab.autosave')).not.toBeNull();
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('is announced politely (aria-live) and exposes the title as a label', async () => {
    seedAutosave();
    const mounted = await mountBanner();
    try {
      const live = mounted.container.querySelector('[aria-live]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
      expect(banner(mounted.container)?.getAttribute('aria-label')).toBe('Unsaved autosave found');
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('omits the age phrase when the stored JSON has no parseable timestamp', async () => {
    localStorage.setItem(
      'scenelab.autosave',
      JSON.stringify({ version: 1, name: 'No Time', features: [], bodies: [], metadata: {} }),
    );
    const mounted = await mountBanner();
    try {
      expect(mounted.container.textContent).toContain('No Time');
      expect(mounted.container.textContent).not.toContain('ago');
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('Restore reloads the project through the existing autosave path and marks it dirty', async () => {
    seedAutosave('Crash Part');
    // Simulate the reboot wiping the in-memory scene before the banner mounts.
    useStore.getState().newProject();
    expect(useStore.getState().bodies.length).toBe(0);
    const mounted = await mountBanner();
    try {
      await clickEl(button(mounted.container, 'Restore'));
      expect(useStore.getState().bodies.length).toBe(1); // the box is back
      expect(useStore.getState().projectName).toBe('Crash Part');
      expect(useStore.getState().projectDirty).toBe(true); // it was never saved
      expect(banner(mounted.container)).toBeNull(); // banner closed
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('Discard removes the stored autosave and closes the banner', async () => {
    seedAutosave();
    const mounted = await mountBanner();
    try {
      await clickEl(button(mounted.container, 'Discard'));
      expect(localStorage.getItem('scenelab.autosave')).toBeNull();
      expect(useStore.getState().hasAutosave()).toBe(false);
      expect(banner(mounted.container)).toBeNull();
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('X hides the banner for the session but keeps the autosave', async () => {
    seedAutosave();
    const mounted = await mountBanner();
    try {
      const close = mounted.container.querySelector('button[aria-label*="Dismiss"]') as HTMLButtonElement;
      expect(close).toBeTruthy();
      await clickEl(close);
      expect(banner(mounted.container)).toBeNull();
      expect(localStorage.getItem('scenelab.autosave')).not.toBeNull();
      expect(useStore.getState().hasAutosave()).toBe(true);
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('Escape dismisses the banner for the session (autosave kept)', async () => {
    seedAutosave();
    const mounted = await mountBanner();
    try {
      // Escape fired on a control inside the banner bubbles to its handler.
      await pressKey(button(mounted.container, 'Restore'), 'Escape');
      expect(banner(mounted.container)).toBeNull();
      expect(localStorage.getItem('scenelab.autosave')).not.toBeNull();
    } finally {
      await unmountBanner(mounted);
    }
  });

  it('renders Chinese in the zh locale', async () => {
    seedAutosave('中文零件');
    useStore.getState().setLocale('zh');
    const mounted = await mountBanner();
    try {
      expect(mounted.container.textContent).toContain('发现“中文零件”的未保存自动备份');
      expect(mounted.container.textContent).toContain('分钟前');
      expect(button(mounted.container, '恢复')).toBeTruthy();
      expect(button(mounted.container, '丢弃')).toBeTruthy();
    } finally {
      await unmountBanner(mounted);
      useStore.getState().setLocale('en');
    }
  });
});
