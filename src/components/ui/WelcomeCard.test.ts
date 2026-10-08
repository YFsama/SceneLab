import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldShowWelcome } from '../../lib/onboarding';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WelcomeCard } from './WelcomeCard';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';

describe('shouldShowWelcome (welcome card visibility rule)', () => {
  const base = {
    workspace: 'model',
    bodyCount: 0,
    featureCount: 0,
    sketchActive: false,
    welcomeDismissed: false,
    welcomeSessionHidden: false,
  };

  it('shows on an empty model workspace', () => {
    expect(shouldShowWelcome(base)).toBe(true);
  });

  it('hides once the scene has any body or feature', () => {
    expect(shouldShowWelcome({ ...base, bodyCount: 1 })).toBe(false);
    expect(shouldShowWelcome({ ...base, featureCount: 2 })).toBe(false);
  });

  it('hides outside the model workspace and while sketching', () => {
    expect(shouldShowWelcome({ ...base, workspace: 'drawing' })).toBe(false);
    expect(shouldShowWelcome({ ...base, sketchActive: true })).toBe(false);
  });

  it('hides when dismissed permanently or for the session', () => {
    expect(shouldShowWelcome({ ...base, welcomeDismissed: true })).toBe(false);
    expect(shouldShowWelcome({ ...base, welcomeSessionHidden: true })).toBe(false);
  });
});

// Mounted card: the help footer must expose the same three entry points as
// the About dialog (shortcuts / diagnostics / about).

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted { container: HTMLDivElement; root: Root }

async function mountCard(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(WelcomeCard)); });
  return { container, root };
}

async function unmountCard({ container, root }: Mounted): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

function footerButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(btn, `footer button "${text}" rendered`).toBeDefined();
  return btn as HTMLButtonElement;
}

describe('WelcomeCard (rendered help footer)', () => {
  let m: Mounted;

  beforeEach(async () => {
    useStore.setState({
      locale: 'en',
      workspace: 'model',
      bodies: [],
      sketchActive: false,
      welcomeDismissed: false,
      welcomeSessionHidden: false,
      showShortcuts: false,
    });
    m = await mountCard();
  });
  afterEach(async () => {
    await unmountCard(m);
    useStore.setState({ showShortcuts: false });
  });

  it('renders the shortcuts / diagnostics / about help links', () => {
    const text = m.container.textContent!;
    expect(text).toContain(translations.en!['about.shortcuts']!);
    expect(text).toContain(translations.en!['errlog.command']!);
    expect(text).toContain(translations.en!['about.command']!);
  });

  it('shortcuts link opens the shortcuts modal (store flag)', async () => {
    await act(async () => {
      footerButton(m.container, translations.en!['about.shortcuts']!).click();
    });
    expect(useStore.getState().showShortcuts).toBe(true);
  });

  it('diagnostics link dispatches scenelab:open-diagnostics', async () => {
    const received: string[] = [];
    const listener = (e: Event) => received.push(e.type);
    window.addEventListener('scenelab:open-diagnostics', listener);
    try {
      await act(async () => {
        footerButton(m.container, translations.en!['errlog.command']!).click();
      });
      expect(received).toEqual(['scenelab:open-diagnostics']);
    } finally {
      window.removeEventListener('scenelab:open-diagnostics', listener);
    }
  });

  it('about link dispatches scenelab:open-about', async () => {
    const received: string[] = [];
    const listener = (e: Event) => received.push(e.type);
    window.addEventListener('scenelab:open-about', listener);
    try {
      await act(async () => {
        footerButton(m.container, translations.en!['about.command']!).click();
      });
      expect(received).toEqual(['scenelab:open-about']);
    } finally {
      window.removeEventListener('scenelab:open-about', listener);
    }
  });
});
