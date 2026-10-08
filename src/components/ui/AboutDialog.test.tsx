import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AboutDialog } from './AboutDialog';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { getOS, getPlatform } from '../../lib/runtime';
import { FEEDBACK_PAGE_URL } from '../../lib/feedback';

// Mount the REAL component and drive it through the same literal CustomEvent
// the welcome card / toolbar dispatch (component files export only the
// component — react-refresh — so the event name lives in every caller).

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };

interface Mounted { container: HTMLDivElement; root: Root }

async function mountDialog(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(AboutDialog)); });
  return { container, root };
}

async function unmountDialog({ container, root }: Mounted): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

async function openViaEvent(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('scenelab:open-about'));
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  expect(btn, `button "${text}" rendered`).toBeDefined();
  return btn as HTMLButtonElement;
}

describe('AboutDialog (rendered)', () => {
  let m: Mounted;

  beforeEach(async () => {
    useStore.setState({ locale: 'en', showShortcuts: false });
    m = await mountDialog();
  });
  afterEach(async () => {
    await unmountDialog(m);
    useStore.setState({ showShortcuts: false });
  });

  it('renders nothing until the open event fires', () => {
    expect(m.container.querySelector('div[role="dialog"]')).toBeNull();
  });

  it('opens on the scenelab:open-about CustomEvent', async () => {
    await openViaEvent();
    expect(m.container.querySelector('div[role="dialog"]')).not.toBeNull();
  });

  it('shows the package version, platform and locale', async () => {
    await openViaEvent();
    const text = m.container.querySelector('dl')!.textContent!;
    expect(text).toContain(pkg.version);
    // Same runtime values the dialog renders (jsdom → 'web' + sniffed OS).
    expect(text).toContain(`${getPlatform()} · ${getOS()}`);
    expect(text).toContain('en');
  });

  it('closes on Escape', async () => {
    await openViaEvent();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(m.container.querySelector('div[role="dialog"]')).toBeNull();
  });

  it('shortcuts button opens ShortcutsHelp state and closes itself', async () => {
    await openViaEvent();
    await act(async () => {
      findButton(m.container, translations.en!['about.shortcuts']!).click();
    });
    expect(useStore.getState().showShortcuts).toBe(true);
    expect(m.container.querySelector('div[role="dialog"]')).toBeNull();
  });

  it('diagnostics button dispatches scenelab:open-diagnostics and closes', async () => {
    const received: string[] = [];
    const listener = (e: Event) => received.push(e.type);
    window.addEventListener('scenelab:open-diagnostics', listener);
    try {
      await openViaEvent();
      await act(async () => {
        findButton(m.container, translations.en!['about.diagnostics']!).click();
      });
      expect(received).toEqual(['scenelab:open-diagnostics']);
      expect(m.container.querySelector('div[role="dialog"]')).toBeNull();
    } finally {
      window.removeEventListener('scenelab:open-diagnostics', listener);
    }
  });

  it('feedback button opens the feedback page in a new browser tab (web runtime fallback)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      await openViaEvent();
      await act(async () => {
        findButton(m.container, translations.en!['report.github']!).click();
      });
      expect(open).toHaveBeenCalledWith(FEEDBACK_PAGE_URL, '_blank', 'noopener,noreferrer');
    } finally {
      open.mockRestore();
    }
  });
});
