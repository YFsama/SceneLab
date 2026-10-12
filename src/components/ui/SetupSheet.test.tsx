import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetupSheet } from './SetupSheet';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { downloadFile } from '../../lib/io/studio3d';

// Pure-display modal (the owner generates the HTML): mounted for real with
// spy onClose; only the file-download leaf is mocked so the Download click is
// observable. jsdom renders iframe srcDoc as an attribute — assertions read
// the attribute (no frame content guarantee in jsdom).

vi.mock('../../lib/io/studio3d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/io/studio3d')>();
  return { ...actual, downloadFile: vi.fn() };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mount(html: string, onClose: () => void): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SetupSheet, { html, onClose }));
  });
  return { container, root };
}

async function unmount({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function click(button: HTMLButtonElement | null | undefined): Promise<void> {
  return act(async () => {
    button!.click();
  });
}

/** The literal en string for a key (tests pin the default en locale). */
const en = (key: string): string => translations.en![key]!;

const DOC = '<!DOCTYPE html><html><body><h1>Setup Sheet — Bracket</h1></body></html>';

describe('SetupSheet (rendered, pure display + hand-off actions)', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'en' });
    clearToasts();
    vi.mocked(downloadFile).mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the document into an iframe via srcDoc', async () => {
    const m = await mount(DOC, vi.fn());
    try {
      const iframe = m.container.querySelector<HTMLIFrameElement>('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe!.getAttribute('title')).toBe(en('cam.setupSheetTitle'));
      expect(iframe!.getAttribute('srcdoc')).toContain('Setup Sheet — Bracket');
      expect(m.container.textContent).toContain(en('cam.setupSheetTitle'));
    } finally {
      await unmount(m);
    }
  });

  it('Copy sends the HTML source through the clipboard helper and toasts', async () => {
    const writeText = vi.fn(async (text: string) => text);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const m = await mount(DOC, vi.fn());
    try {
      const copyButton = [...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => (b.textContent ?? '').trim() === en('cam.copy'))!;
      await click(copyButton);
      await act(async () => { await Promise.resolve(); });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]![0]).toBe(DOC);
      // Optimistic feedback swap + success toast.
      expect(m.container.textContent).toContain(en('cam.copied'));
      expect(getToasts().some((t) => t.message === en('cam.copied'))).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
      await unmount(m);
    }
  });

  it('Download writes the document as setup-sheet.html', async () => {
    const m = await mount(DOC, vi.fn());
    try {
      const downloadButton = [...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => (b.textContent ?? '').trim() === en('cam.download'))!;
      await click(downloadButton);
      await act(async () => { await Promise.resolve(); });
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(downloadFile).mock.calls[0]![0]).toBe(DOC);
      expect(vi.mocked(downloadFile).mock.calls[0]![1]).toBe('setup-sheet.html');
    } finally {
      await unmount(m);
    }
  });

  it('Print clicks through to the iframe document without crashing (jsdom has no print)', async () => {
    const m = await mount(DOC, vi.fn());
    try {
      const printButton = [...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => (b.textContent ?? '').trim() === en('cam.print'))!;
      await click(printButton);
      // No throw, modal still open — that IS the contract under jsdom.
      expect(m.container.querySelector('iframe')).not.toBeNull();
    } finally {
      await unmount(m);
    }
  });

  it('closes on Escape, backdrop click and the header X', async () => {
    const onClose = vi.fn();
    const m = await mount(DOC, onClose);
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      await act(async () => {
        (m.container.querySelector('div[role="dialog"]') as HTMLElement).click();
      });
      expect(onClose).toHaveBeenCalledTimes(2);

      await click([...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.getAttribute('aria-label') === en('dialog.close')));
      expect(onClose).toHaveBeenCalledTimes(3);
    } finally {
      await unmount(m);
    }
  });
});
