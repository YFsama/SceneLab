import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { FeatureTree, createHoleFeature } from '../../lib/features/tree';
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
