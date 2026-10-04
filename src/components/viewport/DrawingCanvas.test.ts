import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry';
import { translations } from '../../lib/i18n';
import { clearToasts, getToasts } from '../../lib/toast';
import { FeatureTree, createHoleFeature } from '../../lib/features/tree';
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
