import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { FeatureTree, createHoleFeature } from '../../lib/features/tree';
import { defaultDrawingViewPlacements } from '../../lib/io/studio3d';
import { CUT_PLANE_ARROW_LEN_PX, CUT_PLANE_DASH, CUT_PLANE_EXTEND_PX, CUT_PLANE_LABEL_GAP_PX, projectBodies, viewTransform } from '../../lib/io/drawing';
import { DrawingCanvas } from './DrawingCanvas';

// DrawingCanvas is a plain 2D-canvas component — mountable headless like the
// other component tests (same minimal createRoot + act harness, no
// testing-library in this project). The paint effect no-ops without a 2D
// context; the export handlers need blob URLs and canvas rasterization, which
// jsdom lacks — stub just those primitives.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has neither createObjectURL nor canvas serialization.
if (typeof URL.createObjectURL !== 'function') {
  (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:stub';
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
}
const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
// jsdom's toBlob exists but never invokes the callback (no rasterizer), and
// toDataURL returns the empty "data:," fallback — the exporters need both to
// produce real payloads.
canvasProto.toBlob = function (this: HTMLCanvasElement, cb: (b: Blob | null) => void) {
  cb(new Blob(['png'], { type: 'image/png' }));
};
canvasProto.toDataURL = () => 'data:image/jpeg;base64,AAAA';

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

function exportButton(container: HTMLElement, key: 'export.svg' | 'export.png' | 'export.dxf' | 'export.pdf') {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${translations.en![key]!}"]`);
}

function toastMessages(): string[] {
  return getToasts().map((x) => x.message);
}

describe('DrawingCanvas export toasts (rendered)', () => {
  beforeEach(() => {
    clearToasts();
    useStore.setState({
      locale: 'en',
      bodies: [createBox(10, 10, 10)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'off',
      numericPrompt: null,
    });
  });

  it('uses the toast.*Exported i18n keys for all four formats', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      for (const key of ['export.svg', 'export.png', 'export.dxf', 'export.pdf'] as const) {
        await act(async () => {
          exportButton(m.container, key)!.click();
        });
      }
      expect(toastMessages()).toEqual([
        translations.en!['toast.svgExported']!,
        translations.en!['toast.pngExported']!,
        translations.en!['toast.dxfExported']!,
        translations.en!['toast.pdfExported']!,
      ]);
    } finally {
      await unmount(m);
    }
  });

  it('switches the export toasts to the zh strings', async () => {
    useStore.setState({ locale: 'zh' });
    const m = await mount(createElement(DrawingCanvas));
    try {
      await act(async () => {
        const svg = m.container.querySelector<HTMLButtonElement>(
          `button[aria-label="${translations.zh!['export.svg']!}"]`,
        );
        svg!.click();
      });
      await act(async () => {
        const dxf = m.container.querySelector<HTMLButtonElement>(
          `button[aria-label="${translations.zh!['export.dxf']!}"]`,
        );
        dxf!.click();
      });
      expect(toastMessages()).toEqual([
        translations.zh!['toast.svgExported']!,
        translations.zh!['toast.dxfExported']!,
      ]);
    } finally {
      await unmount(m);
      useStore.setState({ locale: 'en' });
    }
  });

  it('labels the sheet canvas with drawing.viewLabel in both locales', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      const canvas = m.container.querySelector('canvas[role="img"]');
      expect(canvas).not.toBeNull();
      expect(canvas!.getAttribute('aria-label')).toBe(translations.en!['drawing.viewLabel']!);

      await act(async () => {
        useStore.setState({ locale: 'zh' });
      });
      expect(canvas!.getAttribute('aria-label')).toBe(translations.zh!['drawing.viewLabel']!);
    } finally {
      await unmount(m);
      useStore.setState({ locale: 'en' });
    }
  });

  it('renders the empty-scene placeholder instead of the toolbar', async () => {
    useStore.setState({ bodies: [] });
    const m = await mount(createElement(DrawingCanvas));
    try {
      // Empty-scene branch renders the placeholder, not the toolbar.
      expect(m.container.querySelector('button')).toBeNull();
      expect(m.container.textContent).toContain(translations.en!['panel.noObjects']!);
    } finally {
      await unmount(m);
    }
  });
});

/** Read a captured Blob as text (jsdom's Blob lacks .text()). */
async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('DrawingCanvas with a holed feature tree (callout derivation)', () => {
  const realCreateObjectURL = URL.createObjectURL;

  beforeEach(() => {
    clearToasts();
    const tree = new FeatureTree();
    tree.addFeature(
      createHoleFeature(
        { center: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth: null },
        [],
      ),
    );
    useStore.setState({
      locale: 'en',
      bodies: [createBox(10, 10, 10)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'off',
      numericPrompt: null,
      featureTree: tree,
      featureVersion: 1,
    });
  });

  afterEach(() => {
    URL.createObjectURL = realCreateObjectURL;
    useStore.setState({ featureTree: new FeatureTree(), featureVersion: 2 });
  });

  it('mounts without crashing and exports an SVG carrying the ⌀ THRU callout', async () => {
    // Capture the SVG payload the export button downloads via its blob URL.
    let captured: Blob | null = null;
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      captured = b;
      return 'blob:stub';
    };
    const m = await mount(createElement(DrawingCanvas));
    try {
      // The sheet canvas mounted: the views memo (projection + circle
      // detection) and the callouts memo (feature tree → anchors) both ran
      // during render without throwing.
      expect(m.container.querySelector('canvas[role="img"]')).not.toBeNull();

      await act(async () => {
        exportButton(m.container, 'export.svg')!.click();
      });
      expect(toastMessages()).toContain(translations.en!['toast.svgExported']!);
      // The exported sheet annotates the −Y hole on its axis-on view (Top)
      // with the localized through-all word.
      const svg = await blobText(captured!);
      expect(svg).toContain('⌀6×THRU');
      expect(svg).toMatch(/<path d="M[\d.-]+ [\d.-]+ L[\d.-]+ [\d.-]+ L[\d.-]+ [\d.-]+" fill="none" \/>/);
    } finally {
      await unmount(m);
    }
  });

  it('exports no callout when the hole feature is suppressed', async () => {
    const tree = useStore.getState().featureTree;
    tree.features[0]!.suppressed = true;
    useStore.setState({ featureVersion: 3 }); // the tree mutates in place
    let captured: Blob | null = null;
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      captured = b;
      return 'blob:stub';
    };
    const m = await mount(createElement(DrawingCanvas));
    try {
      await act(async () => {
        exportButton(m.container, 'export.svg')!.click();
      });
      const svg = await blobText(captured!);
      expect(svg).not.toContain('THRU');
    } finally {
      await unmount(m);
    }
  });
});

// ---------------------------------------------------------------------------
// Section cutting-plane annotation (B10): jsdom has no 2D rasterizer, so the
// paint effect's getContext('2d') normally returns null — stub it with a
// recorder and assert the trace commands land at the expected sheet coords.
// ---------------------------------------------------------------------------

interface CtxCall {
  op: string;
  args: unknown[];
}

/** A 2D-context stand-in that records every drawing call. */
function recordingContext(calls: CtxCall[]): CanvasRenderingContext2D {
  const mk = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  return {
    fillRect: mk('fillRect'),
    strokeRect: mk('strokeRect'),
    fillText: mk('fillText'),
    measureText: (t: string) => ({ width: t.length * 6 }),
    beginPath: mk('beginPath'),
    moveTo: mk('moveTo'),
    lineTo: mk('lineTo'),
    closePath: mk('closePath'),
    stroke: mk('stroke'),
    fill: mk('fill'),
    save: mk('save'),
    restore: mk('restore'),
    clip: mk('clip'),
    arc: mk('arc'),
    setLineDash: mk('setLineDash'),
    setTransform: mk('setTransform'),
  } as unknown as CanvasRenderingContext2D;
}

describe('DrawingCanvas section cutting-plane annotation (B10)', () => {
  const realGetContext = canvasProto.getContext;
  const realCreateObjectURL = URL.createObjectURL;
  let calls: CtxCall[];

  beforeEach(() => {
    clearToasts();
    calls = [];
    canvasProto.getContext = function () {
      return recordingContext(calls);
    };
    useStore.setState({
      locale: 'en',
      bodies: [createBox(10, 10, 10)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'x',
      numericPrompt: null,
      featureTree: new FeatureTree(),
      featureVersion: 1,
    });
  });

  afterEach(() => {
    canvasProto.getContext = realGetContext;
    (URL as unknown as Record<string, unknown>).createObjectURL = realCreateObjectURL;
  });

  it('renders the view arrows and letters at the expected sheet positions', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      // Expected positions computed with the exact same primitives the
      // component uses (projectBodies + viewTransform over the canvas's
      // 400×300 cells with PAD 40): box x ∈ [−5,5] → the X-cut plane at
      // model x=0 projects to view coord 0; parents of an X-cut are Front
      // and Top (Right looks along X; iso frames are never annotated).
      const box = createBox(10, 10, 10);
      const section = { normal: { x: 1, y: 0, z: 0 }, offset: 0 };
      const front = projectBodies([box], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, 'Front', section);
      const tr = viewTransform(front, { x: 0, y: 0, w: 400, h: 300 }, 40);
      const traceX = tr.toSheet({ x: 0, y: 0 }).x;
      const expectedX = traceX - CUT_PLANE_ARROW_LEN_PX - CUT_PLANE_LABEL_GAP_PX;
      const expectedYs = [
        tr.toSheet({ x: 0, y: front.bounds.max.y }).y - CUT_PLANE_EXTEND_PX + 3,
        tr.toSheet({ x: 0, y: front.bounds.min.y }).y + CUT_PLANE_EXTEND_PX + 3,
      ].sort((a, b) => a - b);

      const letters = calls.filter((c) => c.op === 'fillText' && c.args[0] === 'A');
      expect(letters).toHaveLength(4); // 2 views × both ends
      const frontLetters = letters.filter((c) => Math.abs((c.args[1] as number) - expectedX) < 1e-6);
      expect(frontLetters).toHaveLength(2);
      const ys = frontLetters.map((c) => c.args[2] as number).sort((a, b) => a - b);
      expect(ys[0]).toBeCloseTo(expectedYs[0]!, 6);
      expect(ys[1]).toBeCloseTo(expectedYs[1]!, 6);

      // The phantom chain dash pattern is applied for the traces.
      expect(
        calls.some(
          (c) => c.op === 'setLineDash' && JSON.stringify(c.args[0]) === JSON.stringify([...CUT_PLANE_DASH]),
        ),
      ).toBe(true);
      // Arrowheads are filled triangles near the trace ends.
      const fills = calls.filter((c) => c.op === 'fill');
      expect(fills.length).toBeGreaterThanOrEqual(4);
      // Sectioned view titles use the pre-seeded sectionTitle key.
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('SECTION A-A'))).toBe(true);
      // The title block still paints (shared layout, B7).
      expect(calls.some((c) => c.op === 'strokeRect')).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('paints no trace when the section is off', async () => {
    useStore.setState({ drawingSectionAxis: 'off' });
    const m = await mount(createElement(DrawingCanvas));
    try {
      expect(calls.filter((c) => c.op === 'fillText' && c.args[0] === 'A')).toHaveLength(0);
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('SECTION'))).toBe(false);
    } finally {
      await unmount(m);
    }
  });

  it('exports SVG containing SECTION A-A, the trace letters and the title block', async () => {
    let captured: Blob | null = null;
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      captured = b;
      return 'blob:stub';
    };
    const m = await mount(createElement(DrawingCanvas));
    try {
      await act(async () => {
        exportButton(m.container, 'export.svg')!.click();
      });
      const svg = await blobText(captured!);
      expect(svg).toContain('SECTION A-A');
      expect((svg.match(/<text[^>]*>A<\/text>/g) ?? []).length).toBeGreaterThanOrEqual(4);
      expect(svg).toContain('stroke-dasharray="16,4,5,4"');
      // Title block parity: the canvas reads projectName from the store.
      expect(svg).toContain('>Untitled<');
    } finally {
      await unmount(m);
      (URL as unknown as Record<string, unknown>).createObjectURL = realCreateObjectURL;
    }
  });

  it('exports the sheet DXF (2D entities + layers), not the raw wireframe', async () => {
    let captured: Blob | null = null;
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      captured = b;
      return 'blob:stub';
    };
    const m = await mount(createElement(DrawingCanvas));
    try {
      await act(async () => {
        exportButton(m.container, 'export.dxf')!.click();
      });
      expect(toastMessages()).toContain(translations.en!['toast.dxfExported']!);
      const dxf = await blobText(captured!);
      // A sheet DXF: layer table with the annotation layers, view titles as
      // TEXT, dimension SOLID arrowheads, the cut letters, the title block.
      for (const layer of ['OUTLINE', 'CENTER', 'CALLOUT', 'NOTES', 'DIMENSIONS']) {
        expect(dxf).toContain(`2\r\n${layer}\r\n`);
      }
      expect(dxf).toContain('SECTION A-A');
      expect(dxf).toMatch(/0\r\nSOLID\r\n/);
      expect(dxf).toMatch(/0\r\nTEXT\r\n/);
    } finally {
      await unmount(m);
      (URL as unknown as Record<string, unknown>).createObjectURL = realCreateObjectURL;
    }
  });
});

// ---------------------------------------------------------------------------
// Stored per-view placements (B6+B8): drag a view (one undo entry on
// release), set a per-view scale via the hover mini toolbar, hide/restore a
// view, and the honest title-block scale field. jsdom gives the canvas a
// zero-size rect, so each test stubs getBoundingClientRect to an identity
// 800×600 mapping (the logical sheet size) before dispatching mouse events.
// ---------------------------------------------------------------------------

/** Identity rect: logical sheet px === client px. */
function sheetRect(): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => {} } as DOMRect;
}

function fireMouse(el: Element, type: string, x: number, y: number, buttons: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons }));
}

/** Front-view centre on the sheet, from the same primitives the canvas uses. */
function frontViewCenter(): { x: number; y: number } {
  const front = projectBodies([createBox(10, 10, 10)], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, 'Front');
  return viewTransform(front, { x: 0, y: 0, w: 400, h: 300 }, 40).toSheet({ x: 0, y: 0 });
}

describe('DrawingCanvas view placements (B6+B8)', () => {
  beforeEach(() => {
    clearToasts();
    useStore.setState({
      locale: 'en',
      bodies: [createBox(10, 10, 10)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'off',
      drawingViewPlacements: defaultDrawingViewPlacements(),
      undoStack: [],
      redoStack: [],
      numericPrompt: null,
      featureTree: new FeatureTree(),
      featureVersion: 1,
    });
  });

  afterEach(() => {
    useStore.setState({ drawingViewPlacements: defaultDrawingViewPlacements() });
  });

  const frontPlacement = () => useStore.getState().drawingViewPlacements.find((p) => p.viewKey === 'front')!;

  it('dragging a view commits the offsets once, as one undo entry', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      const cv = m.container.querySelector('canvas[role="img"]')!;
      cv.getBoundingClientRect = sheetRect;
      const c = frontViewCenter();
      await act(async () => {
        fireMouse(cv, 'mousedown', c.x, c.y, 1);
      });
      await act(async () => {
        fireMouse(cv, 'mousemove', c.x + 30, c.y + 15, 1);
      });
      // Still mid-drag: no store write yet (no undo churn while dragging).
      expect(useStore.getState().undoStack).toHaveLength(0);
      expect(frontPlacement().offsetX).toBe(0);
      await act(async () => {
        fireMouse(cv, 'mouseup', c.x + 30, c.y + 15, 0);
      });
      const fp = frontPlacement();
      expect(fp.offsetX).toBeCloseTo(30, 6);
      expect(fp.offsetY).toBeCloseTo(15, 6);
      expect(useStore.getState().undoStack).toHaveLength(1);
      // Undo takes the view back to its centred position.
      await act(async () => {
        useStore.getState().undo();
      });
      expect(frontPlacement()).toMatchObject({ offsetX: 0, offsetY: 0 });
    } finally {
      await unmount(m);
    }
  });

  it('a press without movement is a click, not a drag — nothing is committed', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      const cv = m.container.querySelector('canvas[role="img"]')!;
      cv.getBoundingClientRect = sheetRect;
      const c = frontViewCenter();
      await act(async () => {
        fireMouse(cv, 'mousedown', c.x, c.y, 1);
      });
      await act(async () => {
        fireMouse(cv, 'mouseup', c.x, c.y, 0);
      });
      expect(useStore.getState().undoStack).toHaveLength(0);
      expect(frontPlacement().offsetX).toBe(0);
    } finally {
      await unmount(m);
    }
  });

  it('hovering a view shows the scale control; Enter commits scaleOverride', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      const cv = m.container.querySelector('canvas[role="img"]')!;
      cv.getBoundingClientRect = sheetRect;
      const c = frontViewCenter();
      await act(async () => {
        fireMouse(cv, 'mousemove', c.x, c.y, 0);
      });
      const input = m.container.querySelector<HTMLInputElement>(`input[aria-label="${translations.en!['drawing.viewScale']!}"]`);
      expect(input).not.toBeNull();
      // The current ratio is disclosed next to the field (auto-fit included).
      expect(m.container.textContent).toMatch(/\d+:\d+/);
      await act(async () => {
        input!.value = '2';
        input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      });
      expect(frontPlacement().scaleOverride).toBe(2);
      expect(useStore.getState().undoStack).toHaveLength(1);
      // Clearing the field returns the view to auto-fit. The override shrank
      // the front view to 2 px/mm, so re-hover at its NEW centre.
      const shrunk = viewTransform(
        projectBodies([createBox(10, 10, 10)], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, 'Front'),
        { x: 0, y: 0, w: 400, h: 300 },
        40,
        { scale: 2 / 50 },
      );
      const c2 = shrunk.toSheet({ x: 0, y: 0 });
      await act(async () => {
        fireMouse(cv, 'mousemove', c2.x, c2.y, 0);
      });
      const input3 = m.container.querySelector<HTMLInputElement>(`input[aria-label="${translations.en!['drawing.viewScale']!}"]`);
      expect(input3).not.toBeNull();
      await act(async () => {
        input3!.value = '';
        input3!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      });
      expect(frontPlacement().scaleOverride).toBeNull();
    } finally {
      await unmount(m);
    }
  });

  it('the remove button hides a view; the toolbar row restores it', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      const cv = m.container.querySelector('canvas[role="img"]')!;
      cv.getBoundingClientRect = sheetRect;
      const c = frontViewCenter();
      await act(async () => {
        fireMouse(cv, 'mousemove', c.x, c.y, 0);
      });
      const remove = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.en!['drawing.removeView']!}"]`,
      );
      expect(remove).not.toBeNull();
      await act(async () => {
        remove!.click();
      });
      expect(frontPlacement().visible).toBe(false);

      // Restore chip: one per hidden view, named after it.
      const restore = m.container.querySelector<HTMLButtonElement>('button[aria-label="Front"]');
      expect(restore).not.toBeNull();
      await act(async () => {
        restore!.click();
      });
      expect(frontPlacement().visible).toBe(true);
      expect(m.container.querySelector('button[aria-label="Front"]')).toBeNull(); // chip is gone
    } finally {
      await unmount(m);
    }
  });

  it('exports an SVG that omits hidden views (and their titles)', async () => {
    useStore.getState().updateDrawingViewPlacement('front', { visible: false });
    const prevCreateObjectURL = URL.createObjectURL;
    let captured: Blob | null = null;
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      captured = b;
      return 'blob:stub';
    };
    const m = await mount(createElement(DrawingCanvas));
    try {
      await act(async () => {
        exportButton(m.container, 'export.svg')!.click();
      });
      const svg = await blobText(captured!);
      expect(svg).not.toContain('>Front<');
      expect(svg).toContain('>Top<');
      expect(svg).toContain('>Right<');
    } finally {
      await unmount(m);
      URL.createObjectURL = prevCreateObjectURL;
    }
  });
});

describe('DrawingCanvas title-block scale honesty (B6+B8)', () => {
  const realGetContext = canvasProto.getContext;
  let calls: CtxCall[];

  beforeEach(() => {
    clearToasts();
    calls = [];
    canvasProto.getContext = function () {
      return recordingContext(calls);
    };
    useStore.setState({
      locale: 'en',
      // 20×10×5: the axis views fit at different scales → VARIES.
      bodies: [createBox(20, 10, 5)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'off',
      drawingViewPlacements: defaultDrawingViewPlacements(),
      undoStack: [],
      redoStack: [],
      numericPrompt: null,
      featureTree: new FeatureTree(),
      featureVersion: 1,
    });
  });

  afterEach(() => {
    canvasProto.getContext = realGetContext;
    useStore.setState({ drawingViewPlacements: defaultDrawingViewPlacements() });
  });

  it('prints VARIES when visible views disagree, the shared ratio when they agree', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      // Auto-fit views of a non-cubic box disagree → VARIES.
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('VARIES'))).toBe(true);

      // Every visible view at override 1 px/mm → the honest shared 1:1.
      await act(async () => {
        useStore.setState({
          drawingViewPlacements: defaultDrawingViewPlacements().map((p) => ({ ...p, scaleOverride: 1 })),
        });
      });
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('Scale: 1:1'))).toBe(true);

      // One visible view left, at 2 px/mm → 2:1.
      await act(async () => {
        for (const key of ['top', 'right', 'iso']) {
          useStore.getState().updateDrawingViewPlacement(key, { visible: false });
        }
        useStore.getState().updateDrawingViewPlacement('front', { scaleOverride: 2 });
      });
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('Scale: 2:1'))).toBe(true);

      // Nothing visible at all → the em dash.
      await act(async () => {
        useStore.getState().updateDrawingViewPlacement('front', { visible: false });
      });
      expect(calls.some((c) => c.op === 'fillText' && String(c.args[0]).includes('Scale: —'))).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('paints each visible view its own scale caption under its title', async () => {
    useStore.getState().updateDrawingViewPlacement('front', { scaleOverride: 2 });
    const m = await mount(createElement(DrawingCanvas));
    try {
      // Front at 2 px/mm gets a 2:1 caption at the title strip (+34 y).
      const captions = calls.filter((c) => c.op === 'fillText' && c.args[0] === '2:1');
      expect(captions.length).toBeGreaterThanOrEqual(1);
      expect((captions[0]!.args[2] as number)).toBeCloseTo(34, 6);
      expect((captions[0]!.args[1] as number)).toBeCloseTo(200, 6); // front cell centre
    } finally {
      await unmount(m);
    }
  });
});

// ---------------------------------------------------------------------------
// Backing-store resize: the sheet rasterizes at container CSS size × DPR
// (fixed 800×600 attribute before). jsdom has no ResizeObserver and reports 0
// client sizes — stub both and drive the observer callback by hand.
// ---------------------------------------------------------------------------

describe('DrawingCanvas backing-store resize', () => {
  const realGetContext = canvasProto.getContext;
  const g = globalThis as Record<string, unknown>;
  const hadRO = 'ResizeObserver' in g;
  const observers: { cb: () => void }[] = [];
  let calls: CtxCall[];

  beforeAll(() => {
    if (!hadRO) {
      g.ResizeObserver = class {
        constructor(cb: () => void) { observers.push({ cb }); }
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });
  afterAll(() => {
    if (!hadRO) delete g.ResizeObserver;
  });

  beforeEach(() => {
    clearToasts();
    calls = [];
    observers.length = 0;
    canvasProto.getContext = function () {
      return recordingContext(calls);
    };
    useStore.setState({
      locale: 'en',
      bodies: [createBox(10, 10, 10)],
      selectedIds: [],
      drawingDetails: [],
      drawingNotes: [],
      drawingSectionAxis: 'off',
      numericPrompt: null,
      featureTree: new FeatureTree(),
      featureVersion: 1,
    });
  });
  afterEach(() => {
    canvasProto.getContext = realGetContext;
  });

  /** Give the sheet wrapper a real client box (jsdom reports 0×0). */
  function layOutSheet(container: HTMLElement, w: number, h: number): HTMLElement {
    const wrapper = container.querySelector('canvas')!.parentElement!;
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, get: () => w });
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, get: () => h });
    return wrapper;
  }

  it('sizes the backing store to the container and repaints with a sheet-space transform', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      layOutSheet(m.container, 1000, 700);
      // Fire the observer callback the component registered on mount.
      expect(observers.length).toBe(1);
      await act(async () => { observers[0]!.cb(); });

      const canvas = m.container.querySelector('canvas')!;
      expect(canvas.width).toBe(1000); // CSS × dpr 1
      expect(canvas.height).toBe(700);
      // The paint scaled sheet coordinates onto the backing store…
      const transforms = calls.filter((c) => c.op === 'setTransform') as unknown as { args: number[] }[];
      expect(transforms.length).toBeGreaterThanOrEqual(1);
      expect(transforms.at(-1)!.args[0]).toBeCloseTo(1000 / 800, 6);
      expect(transforms.at(-1)!.args[3]).toBeCloseTo(700 / 600, 6);
      // …and still drew the sheet content (title-block frame at sheet scale).
      expect(calls.some((c) => c.op === 'strokeRect')).toBe(true);
    } finally {
      await unmount(m);
    }
  });

  it('re-sizes when only the DPR changes (cross-monitor drag)', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const m = await mount(createElement(DrawingCanvas));
    try {
      layOutSheet(m.container, 800, 600);
      expect(observers.length).toBe(1);
      await act(async () => { observers[0]!.cb(); });
      const canvas = m.container.querySelector('canvas')!;
      expect(canvas.width).toBe(1600); // 800 CSS × dpr 2
      expect(canvas.height).toBe(1200);
    } finally {
      await unmount(m);
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    }
  });

  it('keeps the attribute fallback while the container reports no size', async () => {
    const m = await mount(createElement(DrawingCanvas));
    try {
      // jsdom 0×0 wrapper: observer fires but nothing to size yet.
      expect(observers.length).toBe(1);
      await act(async () => { observers[0]!.cb(); });
      const canvas = m.container.querySelector('canvas')!;
      expect(canvas.width).toBe(800); // SHEET_W attribute fallback
      expect(canvas.height).toBe(600);
      // …and the paint ran with an identity transform.
      const transforms = calls.filter((c) => c.op === 'setTransform') as unknown as { args: number[] }[];
      expect(transforms.at(-1)!.args[0]).toBe(1);
    } finally {
      await unmount(m);
    }
  });
});
