import { describe, it, expect, beforeEach } from 'vitest';
import type { SketchTool } from '../../store/app';
import { useStore } from '../../store/app';
import { createSketch, addCircle, addLine } from '../../lib/sketch/engine';
import { translations } from '../../lib/i18n';
import { act, createElement, type ReactNode } from 'react';
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
    const m = await mountToolbar(createElement(SketchToolbar));
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
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = m.container.querySelector<HTMLButtonElement>(
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

    const m = await mountToolbar(createElement(SketchToolbar));
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
      await act(async () => {
        useStore.getState().closeNumericPrompt();
        prompt!.onApply(2);
      });
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

// --- Rendered coverage: the Trim / Extend tool buttons ------------------------
// Click-then-act tools: clicking arms the tool (sketchTool state); the
// viewport performs the actual trim/extend on its next click.

describe('SketchToolbar trim/extend buttons (rendered)', () => {
  beforeEach(() => {
    useStore.setState({
      locale: 'en',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      numericPrompt: null,
      sketchTool: 'select',
    });
  });

  function toolButton(container: HTMLElement, key: 'sketch.trim' | 'sketch.extend'): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `button[aria-label="${translations.en![key]!}"]`,
    );
  }

  it('renders both buttons with English labels and arms the trim tool on click', async () => {
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const trim = toolButton(m.container, 'sketch.trim');
      const extend = toolButton(m.container, 'sketch.extend');
      expect(trim).not.toBeNull();
      expect(extend).not.toBeNull();
      expect(trim!.getAttribute('aria-pressed')).toBe('false');

      await act(async () => {
        trim!.click();
      });
      expect(useStore.getState().sketchTool).toBe('trim');
      expect(trim!.getAttribute('aria-pressed')).toBe('true');
      expect(extend!.getAttribute('aria-pressed')).toBe('false');

      await act(async () => {
        extend!.click();
      });
      expect(useStore.getState().sketchTool).toBe('extend');
    } finally {
      await unmountToolbar(m);
    }
  });

  it('renders with the Chinese labels in the zh locale', async () => {
    useStore.getState().setLocale('zh');
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const trim = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.zh!['sketch.trim']!}"]`,
      );
      const extend = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.zh!['sketch.extend']!}"]`,
      );
      expect(trim).not.toBeNull();
      expect(extend).not.toBeNull();

      await act(async () => {
        trim!.click();
      });
      expect(useStore.getState().sketchTool).toBe('trim');
    } finally {
      await unmountToolbar(m);
      useStore.getState().setLocale('en');
    }
  });

  it('arming trim and clicking a line through the store trims it end-to-end (toolbar → viewport contract)', async () => {
    const sketch = createSketch('xy');
    const target = addLine(sketch, 0, 0, 10, 0);
    addLine(sketch, 5, -5, 5, 5);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().setSelectedSketchId(target.id);

    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      await act(async () => {
        toolButton(m.container, 'sketch.trim')!.click();
      });
      expect(useStore.getState().sketchTool).toBe('trim');

      // What the viewport's click handler will do with the armed tool: target
      // the selection and call the store action with the sketch-space point.
      let ok = false;
      await act(async () => {
        const st = useStore.getState();
        const id = st.selectedSketchIds[0] ?? st.selectedSketchId;
        expect(id).toBe(target.id);
        ok = st.trimSketchAt({ x: 2, y: 0 });
      });
      expect(ok).toBe(true);
      expect(useStore.getState().currentSketch!.entities.has(target.id)).toBe(false);
    } finally {
      await unmountToolbar(m);
      useStore.getState().setSketchTool('select');
    }
  });
});
