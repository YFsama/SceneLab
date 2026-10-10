import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GCodePreview } from './GCodePreview';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';

// Pure-display modal: mounted for real (jsdom + createRoot + act, the
// project's mount-harness style) with spy callbacks; no store mutations
// beyond the locale read useT performs.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mount(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
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

describe('GCodePreview (rendered, pure display)', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'en' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const baseProps = {
    gcode: 'G90\nG21\nG1 X10 F1000',
    lineCount: 3,
    sizeBytes: 2048,
    toolsUsed: 'T1 ⌀6 · T2 ⌀3',
    feedRange: '300–1000 mm/min',
    timeMin: 4.25,
    profile: 'grbl',
  };

  it('renders the stat cards from props and the program body', async () => {
    const m = await mount(createElement(GCodePreview, {
      ...baseProps,
      onClose: vi.fn(),
      onCopy: vi.fn(),
      onDownload: vi.fn(),
    }));
    try {
      const text = m.container.textContent ?? '';
      expect(text).toContain(en('cam.previewTitle'));
      // Stats: lines, size (KB, one decimal), tools, feed range, est. time.
      expect(text).toContain('3');
      expect(text).toContain('2.0 KB');
      expect(text).toContain('T1 ⌀6 · T2 ⌀3');
      expect(text).toContain('300–1000 mm/min');
      expect(text).toContain(`4.3 ${en('cam.minutes')}`);
      expect(text).toContain('grbl');
      // The code area shows the program verbatim.
      expect(m.container.querySelector('pre')!.textContent).toContain('G1 X10 F1000');
    } finally {
      await unmount(m);
    }
  });

  it('caps the rendered code at 4000 lines and reports the hidden remainder', async () => {
    // 5000 numbered comment lines: 4000 render, 1000 are summarized.
    const gcode = Array.from({ length: 5000 }, (_, i) => `; line ${i + 1}`).join('\n');
    const m = await mount(createElement(GCodePreview, {
      ...baseProps,
      gcode,
      lineCount: 5000,
      sizeBytes: gcode.length,
      onClose: vi.fn(),
      onCopy: vi.fn(),
      onDownload: vi.fn(),
    }));
    try {
      const pre = m.container.querySelector('pre')!;
      expect(pre.textContent).toContain('; line 4000');
      expect(pre.textContent).not.toContain('; line 4001');
      expect(pre.textContent).not.toContain('; line 5000');
      expect(m.container.textContent).toContain(en('cam.moreLines').replace('{n}', '1000'));
    } finally {
      await unmount(m);
    }
  });

  it('fires onClose / onCopy / onDownload from the header and footer buttons', async () => {
    const onClose = vi.fn();
    const onCopy = vi.fn();
    const onDownload = vi.fn();
    const m = await mount(createElement(GCodePreview, { ...baseProps, onClose, onCopy, onDownload }));
    try {
      await click([...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => (b.textContent ?? '').trim() === en('cam.copy'))!);
      expect(onCopy).toHaveBeenCalledTimes(1);
      // The copy feedback swaps the label for the transient "Copied" state.
      expect(m.container.textContent).toContain(en('cam.copied'));

      await click([...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => (b.textContent ?? '').trim() === en('cam.download'))!);
      expect(onDownload).toHaveBeenCalledTimes(1);

      await click([...m.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.getAttribute('aria-label') === en('dialog.close'))!);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(m);
    }
  });
});
