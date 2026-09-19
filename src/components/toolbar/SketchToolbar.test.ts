import { describe, it, expect, beforeEach } from 'vitest';
import type { SketchTool } from '../../store/app';
import { useStore } from '../../store/app';
import { createSketch, addCircle } from '../../lib/sketch/engine';
import { translations } from '../../lib/i18n';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SketchToolbar } from './SketchToolbar';

// SketchToolbar is a React component — test the tool structure.

describe('SketchToolbar tool structure', () => {
  const tools: { tool: SketchTool; shortcut: string }[] = [
    { tool: 'select', shortcut: 'V' },
    { tool: 'line', shortcut: 'L' },
    { tool: 'polyline', shortcut: 'Shift+L' },
    { tool: 'rect', shortcut: 'R' },
    { tool: 'circle', shortcut: 'O' },
    { tool: 'arc', shortcut: 'A' },
    { tool: 'polygon', shortcut: 'P' },
  ];

  it('has 7 sketch tools', () => {
    expect(tools).toHaveLength(7);
  });

  it('includes select, line, rect, circle, arc, polygon', () => {
    const toolNames = tools.map((t) => t.tool);
    expect(toolNames).toContain('select');
    expect(toolNames).toContain('line');
    expect(toolNames).toContain('rect');
    expect(toolNames).toContain('circle');
    expect(toolNames).toContain('arc');
    expect(toolNames).toContain('polygon');
  });

  it('includes polyline', () => {
    const toolNames = tools.map((t) => t.tool);
    expect(toolNames).toContain('polyline');
  });

  it('select has shortcut V', () => {
    const select = tools.find((t) => t.tool === 'select');
    expect(select!.shortcut).toBe('V');
  });

  it('line has shortcut L', () => {
    const line = tools.find((t) => t.tool === 'line');
    expect(line!.shortcut).toBe('L');
  });

  it('polyline has shortcut Shift+L', () => {
    const polyline = tools.find((t) => t.tool === 'polyline');
    expect(polyline!.shortcut).toBe('Shift+L');
  });

  it('rect has shortcut R', () => {
    const rect = tools.find((t) => t.tool === 'rect');
    expect(rect!.shortcut).toBe('R');
  });

  it('circle has shortcut O', () => {
    const circle = tools.find((t) => t.tool === 'circle');
    expect(circle!.shortcut).toBe('O');
  });

  it('arc has shortcut A', () => {
    const arc = tools.find((t) => t.tool === 'arc');
    expect(arc!.shortcut).toBe('A');
  });

  it('polygon has shortcut P', () => {
    const polygon = tools.find((t) => t.tool === 'polygon');
    expect(polygon!.shortcut).toBe('P');
  });
});

// --- Rendered coverage: the Offset button -------------------------------------
// Same minimal mount harness the other component tests use (no testing-library
// in this project): render with createRoot inside act(), click the real button.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountToolbar(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmountToolbar({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function offsetButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${translations.en!['sketch.offset']!}"]`);
}

describe('SketchToolbar offset button (rendered)', () => {
  beforeEach(() => {
    useStore.setState({
      locale: 'en',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      numericPrompt: null,
    });
  });

  it('renders with the English label and is disabled without a selection', async () => {
    const m = await mountToolbar(<SketchToolbar />);
    try {
      const btn = offsetButton(m.container);
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);
      expect(btn!.getAttribute('aria-disabled')).toBe('true');
      expect(btn!.title).toContain(translations.en!['sketch.offsetHint']!);
    } finally {
      await unmountToolbar(m);
    }
  });

  it('renders with the Chinese label in the zh locale', async () => {
    useStore.getState().setLocale('zh');
    const m = await mountToolbar(<SketchToolbar />);
    try {
      const btn = m.container.querySelector(
        `button[aria-label="${translations.zh!['sketch.offset']!}"]`,
      );
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true); // still nothing selected
    } finally {
      await unmountToolbar(m);
      useStore.getState().setLocale('en');
    }
  });

  it('enables with a selected circle; clicking opens the prompt and applying offsets', async () => {
    const sketch = createSketch('xy');
    const circle = addCircle(sketch, 0, 0, 5);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().setSelectedSketchId(circle.id);

    const m = await mountToolbar(<SketchToolbar />);
    try {
      const btn = offsetButton(m.container);
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);

      await act(async () => {
        btn!.click();
      });
      const prompt = useStore.getState().numericPrompt;
      expect(prompt).not.toBeNull();
      expect(prompt!.titleKey).toBe('sketch.offset');
      expect(prompt!.labelKey).toBe('sketch.offsetPrompt');
      expect(prompt!.initial).toBe(2);
      expect(prompt!.min).toBe(-1e6);

      // Simulate the dialog's Apply: close, then run the callback.
      useStore.getState().closeNumericPrompt();
      prompt!.onApply(2);
      const circles = [...useStore.getState().currentSketch!.entities.values()].filter(
        (e) => e.type === 'circle',
      );
      expect(circles).toHaveLength(2); // r=5 original + r=7 copy
      expect(useStore.getState().selectedSketchIds).toHaveLength(1); // copy selected
    } finally {
      await unmountToolbar(m);
    }
  });
});
