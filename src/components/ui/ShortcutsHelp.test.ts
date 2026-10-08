import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { platformizeShortcut } from '../../lib/runtime';
import { ShortcutsHelp } from './ShortcutsHelp';

// Mount the REAL component (open state on) and read its rendered rows — the
// test cannot drift from what the modal shows. Every row's label resolves in
// BOTH locales except the deliberately-pending keys listed below (proposed to
// the coordinator; the modal falls back to the raw key until they are seeded).

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted { container: HTMLDivElement; root: Root }

async function mountHelp(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ShortcutsHelp)); });
  return { container, root };
}

async function unmountHelp({ container, root }: Mounted): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

/** All rendered (label, keys) pairs across every group. */
function rows(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll('div.flex.items-center.justify-between')].map((row) => {
    const label = row.querySelector('span')?.textContent ?? '';
    const keys = row.querySelector('kbd')?.textContent ?? '';
    return [label, keys] as [string, string];
  });
}

describe('ShortcutsHelp (rendered)', () => {
  let m: Mounted;

  beforeEach(async () => {
    useStore.setState({ locale: 'en', showShortcuts: true });
    m = await mountHelp();
  });
  afterEach(async () => {
    await unmountHelp(m);
    useStore.setState({ showShortcuts: false });
  });

  it('renders nothing until opened', async () => {
    useStore.setState({ showShortcuts: false });
    const hidden = await mountHelp();
    try {
      expect(hidden.container.querySelector('div[role="dialog"]')).toBeNull();
    } finally {
      await unmountHelp(hidden);
    }
  });

  it('renders four titled groups', () => {
    const dialog = m.container.querySelector('div[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    for (const titleKey of ['shortcuts.views', 'shortcuts.workspaces', 'shortcuts.sketch', 'shortcuts.edit']) {
      expect(dialog.textContent).toContain(translations.en![titleKey]!);
    }
  });

  it('documents the previously-missing live bindings (F11)', () => {
    const pairs = rows(m.container);
    // 0 = iso view; Shift+L = polyline.
    expect(pairs).toContainEqual([translations.en!['viewport.iso']!, '0']);
    expect(pairs).toContainEqual([translations.en!['sketch.polyline']!, 'Shift+L']);
    // Enter repeats the last command; Delete in measure unpicks the last
    // point (both keys seeded in i18n since the rows were added).
    expect(pairs).toContainEqual([translations.en!['shortcuts.repeatLast']!, 'Enter']);
    // Ctrl+Shift+A deselects all; Ctrl+Shift+Z redoes. Combos render through
    // platformizeShortcut, so the expected string follows the host platform
    // (⌘ on macOS) instead of being hard-coded.
    expect(pairs).toContainEqual([translations.en!['menu.deselectAll']!, platformizeShortcut('Ctrl+Shift+A')]);
    expect(pairs).toContainEqual([translations.en!['toolbar.redo']!, platformizeShortcut('Ctrl+Shift+Z')]);
    // Alt / Shift nudge modifiers reuse the nudge label.
    expect(pairs).toContainEqual([translations.en!['shortcuts.nudge']!, platformizeShortcut('Alt / Shift + arrows')]);
    expect(pairs).toContainEqual([translations.en!['shortcuts.measureUnpick']!, 'Del (measure)']);
  });

  it('renders macOS modifier labels when the host sniffs as macOS', async () => {
    // Stub the navigator BEFORE mounting so the render-time platform probe
    // (runtime.getOS) reads a Mac user agent end to end.
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: 'MacIntel',
    });
    try {
      const mac = await mountHelp();
      try {
        const pairs = rows(mac.container);
        // Ctrl entries become ⌘ (they are command shortcuts bound to
        // ctrlKey||metaKey, so ⌘ is the faithful macOS label).
        expect(pairs).toContainEqual([translations.en!['toolbar.redo']!, '⌘+Shift+Z']);
        expect(pairs).toContainEqual([translations.en!['menu.isolate']!, '⌘+I']);
        expect(pairs).toContainEqual([translations.en!['shortcuts.palette']!, '⌘+K']);
        expect(pairs).toContainEqual([translations.en!['shortcuts.panels']!, '⌘+B / ⌘+P']);
        // The Alt-drag clone shortcut becomes ⌥; modifier-free rows unchanged.
        expect(pairs).toContainEqual([translations.en!['shortcuts.altDragDuplicate']!, '⌥+LMB drag']);
        expect(pairs).toContainEqual([translations.en!['sketch.polyline']!, 'Shift+L']);
        // No leftover raw Ctrl token anywhere in the rendered combos.
        const allKeys = pairs.map(([, k]) => k);
        expect(allKeys.some((k) => k.includes('Ctrl') || k.includes('Alt'))).toBe(false);
      } finally {
        await unmountHelp(mac);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the number-key view rows 1-7 plus 0 for iso', () => {
    const keys = rows(m.container).map(([, k]) => k);
    for (let i = 0; i <= 7; i++) expect(keys).toContain(String(i));
  });

  it('the Model workspace row claims Shift+M — plain M stays Measure', () => {
    const pairs = rows(m.container);
    expect(pairs).toContainEqual([translations.en!['toolbar.model']!, 'Shift+M']);
    expect(pairs).toContainEqual([translations.en!['shortcuts.measure']!, 'M']);
  });
});
