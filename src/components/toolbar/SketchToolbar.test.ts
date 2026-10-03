import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SketchTool } from '../../store/app';
import { useStore } from '../../store/app';
import { createSketch, addCircle, addLine } from '../../lib/sketch/engine';
import { resolveMirrorAxis } from '../../lib/sketch/mirror';
import { translations } from '../../lib/i18n';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SketchToolbar } from './SketchToolbar';
import { SKETCH_TOOLS } from './sketchTools';
// The toolbar is data-driven — test the real exported table so the component
// cannot drift from it (previously this block re-declared the tool array and
// even asserted a 'polyline' button that the component never had).

describe('SketchToolbar tool table', () => {
  it('offers exactly select, line, rect, circle, arc and polygon, in bar order', () => {
    expect(SKETCH_TOOLS.map((t) => t.tool)).toEqual<SketchTool[]>([
      'select', 'line', 'rect', 'circle', 'arc', 'polygon',
    ]);
  });

  it('tools and shortcuts are unique', () => {
    const tools = SKETCH_TOOLS.map((t) => t.tool);
    const shortcuts = SKETCH_TOOLS.map((t) => t.shortcut);
    expect(new Set(tools).size).toBe(tools.length);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('keeps the V/L/R/O/A/P badge keys matching the initShortcuts hotkeys', () => {
    // initShortcuts (useKeyboardShortcuts.ts) registers the same letters; the
    // badge shown on the button must not disagree with the actual hotkey.
    expect(SKETCH_TOOLS.map((t) => t.shortcut)).toEqual(['V', 'L', 'R', 'O', 'A', 'P']);
  });

  it('every tool has an icon and a label in both locales', () => {
    for (const tool of SKETCH_TOOLS) {
      expect(tool.icon).toBeTruthy();
      const key = `sketch.${tool.tool}`;
      expect(translations.en?.[key], key).toBeTruthy();
      expect(translations.zh?.[key], key).toBeTruthy();
    }
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

// --- Rendered coverage: the Exit Sketch button (F6) ----------------------------
// The button must take the store.exitSketch path (like Esc and the floating
// pill), which leaves sketch mode but PRESERVES currentSketch — the old
// setCurrentSketch(null) call silently discarded every drawn entity.

describe('SketchToolbar exit button (rendered)', () => {
  beforeEach(() => {
    useStore.setState({
      locale: 'en',
      workspace: 'sketch',
      sketchActive: true,
      sketchTool: 'line',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      numericPrompt: null,
      drawStart: null,
      polylineLast: null,
    });
  });

  it('exits via store.exitSketch and PRESERVES the sketch entities', async () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    useStore.getState().setCurrentSketch(sketch);

    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.en!['sketch.exit']!}"]`,
      );
      expect(btn).not.toBeNull();

      await act(async () => {
        btn!.click();
      });
      const st = useStore.getState();
      expect(st.sketchActive).toBe(false);
      expect(st.workspace).toBe('model');
      // The drawn entities survive the toolbar exit — non-destructive, the
      // same behaviour as Esc and the floating pill.
      expect(st.currentSketch).not.toBeNull();
      const lines = [...st.currentSketch!.entities.values()].filter((e) => e.type === 'line');
      expect(lines).toHaveLength(1);
    } finally {
      await unmountToolbar(m);
      useStore.getState().exitSketch();
      useStore.setState({ currentSketch: null });
    }
  });
});

// --- Rendered coverage: the Mirror button --------------------------------------
// The axis rule (resolveMirrorAxis): the selection's single line is the axis;
// with no line selected, the sketch's ONLY line is used automatically;
// otherwise the button disables with the "mirror about line" hint. Clicking
// runs store.mirrorSelectedSketch(resolvedLineId) — the real store action
// lands with the store sibling, so it is spied via a state-object seam here
// (the click handler reads the action through useStore.getState(), so no
// re-render or setState is needed).

interface MirrorSeam {
  mirrorSelectedSketch?: (lineId: string) => boolean;
}

describe('SketchToolbar mirror button (rendered)', () => {
  beforeEach(() => {
    useStore.setState({
      locale: 'en',
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      numericPrompt: null,
    });
  });

  function mirrorButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `button[aria-label="${translations.en!['sketch.mirror']!}"]`,
    );
  }

  it('renders and is disabled without a selection, hinting the axis in the title', async () => {
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = mirrorButton(m.container);
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);
      expect(btn!.getAttribute('aria-disabled')).toBe('true');
      expect(btn!.title).toContain(translations.en!['sketch.mirrorPrompt']!);
    } finally {
      await unmountToolbar(m);
    }
  });

  it('case 1: a multi-selection including exactly one line uses that line as the axis', async () => {
    const sketch = createSketch('xy');
    const axis = addLine(sketch, 0, 0, 0, 10);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id, axis.id] });

    const seam = useStore.getState() as unknown as MirrorSeam;
    const original = seam.mirrorSelectedSketch;
    const spy = vi.fn(() => true);
    seam.mirrorSelectedSketch = spy;
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = mirrorButton(m.container);
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);
      expect(btn!.title).toBe(translations.en!['sketch.mirror']!);

      await act(async () => {
        btn!.click();
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(axis.id);
    } finally {
      await unmountToolbar(m);
      seam.mirrorSelectedSketch = original;
    }
  });

  it('case 2: no line in the selection but exactly one line in the sketch → auto axis', async () => {
    const sketch = createSketch('xy');
    const theOnlyLine = addLine(sketch, 1, 1, 1, 8);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id] });

    const seam = useStore.getState() as unknown as MirrorSeam;
    const original = seam.mirrorSelectedSketch;
    const spy = vi.fn(() => true);
    seam.mirrorSelectedSketch = spy;
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = mirrorButton(m.container);
      expect(btn!.disabled).toBe(false);
      await act(async () => {
        btn!.click();
      });
      expect(spy).toHaveBeenCalledWith(theOnlyLine.id);
    } finally {
      await unmountToolbar(m);
      seam.mirrorSelectedSketch = original;
    }
  });

  it('case 3: no line selected and two lines in the sketch → disabled with the hint', async () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 0, 10);
    addLine(sketch, 5, 0, 5, 10);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id] });

    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = mirrorButton(m.container);
      expect(btn!.disabled).toBe(true);
      expect(btn!.getAttribute('aria-disabled')).toBe('true');
      expect(btn!.title).toContain(translations.en!['sketch.mirrorPrompt']!);
    } finally {
      await unmountToolbar(m);
    }
  });

  it('two lines in the selection are ambiguous → disabled', async () => {
    const sketch = createSketch('xy');
    const l1 = addLine(sketch, 0, 0, 0, 10);
    const l2 = addLine(sketch, 5, 0, 5, 10);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id, l1.id, l2.id] });

    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      expect(mirrorButton(m.container)!.disabled).toBe(true);
    } finally {
      await unmountToolbar(m);
    }
  });

  it('a selection of just the axis line still resolves it (engine refuses empty targets later)', async () => {
    const sketch = createSketch('xy');
    const axis = addLine(sketch, 0, 0, 0, 10);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [axis.id] });

    const seam = useStore.getState() as unknown as MirrorSeam;
    const original = seam.mirrorSelectedSketch;
    const spy = vi.fn(() => false);
    seam.mirrorSelectedSketch = spy;
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = mirrorButton(m.container);
      expect(btn!.disabled).toBe(false);
      await act(async () => {
        btn!.click();
      });
      expect(spy).toHaveBeenCalledWith(axis.id);
    } finally {
      await unmountToolbar(m);
      seam.mirrorSelectedSketch = original;
    }
  });

  it('renders with the Chinese label in the zh locale', async () => {
    const sketch = createSketch('xy');
    const axis = addLine(sketch, 0, 0, 0, 10);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id, axis.id] });
    useStore.getState().setLocale('zh');
    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      const btn = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.zh!['sketch.mirror']!}"]`,
      );
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);
    } finally {
      await unmountToolbar(m);
      useStore.getState().setLocale('en');
    }
  });

  it('end-to-end: clicking mirrors through the real store action and selects the copies', async () => {
    const sketch = createSketch('xy');
    const axis = addLine(sketch, 0, 0, 0, 10);
    const circle = addCircle(sketch, -5, 0, 2);
    useStore.setState({ currentSketch: sketch, selectedSketchIds: [circle.id, axis.id] });
    const before = sketch.entities.size;

    const m = await mountToolbar(createElement(SketchToolbar));
    try {
      await act(async () => {
        mirrorButton(m.container)!.click();
      });
      const st = useStore.getState();
      const circles = [...st.currentSketch!.entities.values()].filter((e) => e.type === 'circle');
      expect(circles).toHaveLength(2); // original + mirrored copy
      expect(st.currentSketch!.entities.size).toBe(before + 2); // copy centre + copy circle
      // The axis was not duplicated, and the copy is the new selection.
      expect([...st.currentSketch!.entities.values()].filter((e) => e.type === 'line')).toHaveLength(1);
      expect(st.selectedSketchIds).toHaveLength(1);
      expect(st.selectedSketchIds[0]).not.toBe(circle.id);
      expect(st.projectDirty).toBe(true);
    } finally {
      await unmountToolbar(m);
    }
  });
});

describe('resolveMirrorAxis (pure rule)', () => {
  it('ignores stale ids and requires a resolvable axis', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 0, 10);
    const circle = addCircle(sketch, 2, 2, 1);
    // stale id filtered, single line in sketch resolves even with no line selected
    expect(resolveMirrorAxis(sketch, ['pt_stale', circle.id])).toBe(line.id);
    expect(resolveMirrorAxis(sketch, [])).toBeNull();
    expect(resolveMirrorAxis(null, [line.id])).toBeNull();
    expect(resolveMirrorAxis(sketch, ['pt_stale'])).toBeNull();
  });
});
