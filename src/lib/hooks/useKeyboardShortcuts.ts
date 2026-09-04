import { useEffect } from 'react';
import { useStore } from '../../store/app';
import { confirmDiscardIfDirty, saveProjectToFile, openProjectFromFile } from '../projectActions';

const shortcuts: Record<string, () => void> = {};

export function registerShortcut(key: string, handler: () => void): void {
  shortcuts[key] = handler;
}

/**
 * What the Escape key should cancel, in priority order: an active body drag
 * first (undoing the whole drag as one history step), then an in-progress
 * sketch drag (cancel the current shape, staying in the sketch), then exit
 * the sketch, then the measure tool, then the selection — mirroring how Esc
 * backs out one step at a time in SolidWorks.
 */
export function escapeAction(
  s: { bodyDragging?: boolean; sketchActive: boolean; measureActive: boolean; drawing?: boolean },
): 'cancelDrag' | 'cancelDraw' | 'exitSketch' | 'exitMeasure' | 'deselect' {
  if (s.bodyDragging) return 'cancelDrag';
  if (s.sketchActive && s.drawing) return 'cancelDraw';
  if (s.sketchActive) return 'exitSketch';
  if (s.measureActive) return 'exitMeasure';
  return 'deselect';
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      // Type-ahead sketch dimensions own the plain number keys while a draw is
      // in progress — they build the exact-size buffer, not view switching.
      // The 'x' in a rect's "WxH" entry belongs to the buffer too (it would
      // otherwise toggle section analysis mid-typing).
      const st = useStore.getState();
      if (
        st.sketchActive && st.drawStart &&
        (/^[0-9.]$/.test(e.key) || (e.key.toLowerCase() === 'x' && st.sketchTool === 'rect')) &&
        !e.ctrlKey && !e.metaKey && !e.altKey
      ) {
        return;
      }

      const key = [
        e.ctrlKey || e.metaKey ? 'ctrl' : '',
        e.shiftKey ? 'shift' : '',
        e.altKey ? 'alt' : '',
        e.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');

      const handler = shortcuts[key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

// Register default shortcuts
export function initShortcuts(): void {
  const store = useStore.getState();

  // Standard-view shortcuts (CAD convention): 1 front, 2 top, 3 right, 4 iso.
  registerShortcut('1', () => store.setViewDirection('front'));
  registerShortcut('2', () => store.setViewDirection('top'));
  registerShortcut('3', () => store.setViewDirection('right'));
  registerShortcut('4', () => store.setViewDirection('iso'));
  registerShortcut('5', () => store.setViewDirection('back'));
  registerShortcut('6', () => store.setViewDirection('bottom'));
  registerShortcut('7', () => store.setViewDirection('left'));
  registerShortcut('0', () => store.setViewDirection('iso'));

  // Workspace shortcuts (read fresh state — initShortcuts runs once at startup).
  registerShortcut('s', () => {
    if (!useStore.getState().sketchActive) {
      store.setWorkspace('sketch');
      store.setSketchActive(true);
    }
  });
  registerShortcut('m', () => store.setWorkspace('model'));
  registerShortcut('d', () => store.setWorkspace('drawing'));
  registerShortcut('c', () => store.setWorkspace('cam'));

  // Sketch tool shortcuts
  registerShortcut('l', () => store.setSketchTool('line'));
  registerShortcut('shift+l', () => store.setSketchTool('polyline'));
  registerShortcut('r', () => store.setSketchTool('rect'));
  registerShortcut('o', () => store.setSketchTool('circle'));
  registerShortcut('a', () => store.setSketchTool('arc'));
  registerShortcut('p', () => store.setSketchTool('polygon'));
  registerShortcut('v', () => store.setSketchTool('select'));

  // Panel toggles
  registerShortcut('ctrl+b', () => store.toggleBrowserTree());
  registerShortcut('ctrl+p', () => store.toggleProperties());
  // B opens the beginner parts library (TinkerCAD-style quick-insert gallery).
  registerShortcut('b', () => useStore.getState().togglePartsLibrary());
  // X toggles live section analysis (Fusion-style inspection clip) — a model-view
  // tool; the panel only exists there, so don't arm it from other workspaces.
  registerShortcut('x', () => {
    const s = useStore.getState();
    if (s.workspace === 'model') s.setSectionAnalysis({ active: !s.sectionAnalysis.active });
  });

  // Actions. While measuring, Delete/Backspace drops the last picked point
  // (re-pick a mis-click) instead of deleting the selected bodies.
  const deleteOrUnpick = () => {
    const s = useStore.getState();
    if (s.measureActive) s.removeLastMeasurePoint();
    else s.deleteSelected();
  };
  registerShortcut('delete', deleteOrUnpick);
  registerShortcut('backspace', deleteOrUnpick);
  registerShortcut('ctrl+d', () => store.duplicateSelected());
  registerShortcut('ctrl+a', () => store.selectAll());
  registerShortcut('ctrl+shift+a', () => store.deselectAll());
  registerShortcut('ctrl+shift+i', () => store.invertSelection());
  registerShortcut('f2', () => store.beginRenameSelected());
  // Fusion-style: E extrudes the active sketch; Ctrl+I isolates the selection
  // (hides everything else).
  registerShortcut('e', () => {
    const s = useStore.getState();
    if (s.currentSketch) s.setShowExtrudeDialog(true);
  });
  registerShortcut('ctrl+i', () => useStore.getState().isolateSelected());
  // Tab hides the current selection; Shift+Tab brings every hidden body back.
  registerShortcut('tab', () => store.hideSelected());
  registerShortcut('shift+tab', () => store.showAllBodies());
  registerShortcut('ctrl+x', () => store.cutSelected());
  registerShortcut('ctrl+c', () => store.copySelected());
  registerShortcut('ctrl+v', () => store.paste());
  // SolidWorks-style paste-in-place: copies land at the originals' positions.
  registerShortcut('ctrl+shift+v', () => useStore.getState().pasteInPlace());
  // While sketching, Ctrl+Z/Y act on the sketch's own history; otherwise on bodies.
  registerShortcut('ctrl+z', () => { const s = useStore.getState(); if (s.sketchActive) s.sketchUndo(); else s.undo(); });
  registerShortcut('ctrl+shift+z', () => { const s = useStore.getState(); if (s.sketchActive) s.sketchRedo(); else s.redo(); });
  registerShortcut('ctrl+y', () => { const s = useStore.getState(); if (s.sketchActive) s.sketchRedo(); else s.redo(); });
  registerShortcut('ctrl+s', () => saveProjectToFile());
  registerShortcut('ctrl+o', () => { void openProjectFromFile(); });
  registerShortcut('ctrl+n', () => { void confirmDiscardIfDirty('project.new').then((ok) => { if (ok) useStore.getState().newProject(); }); });
  registerShortcut('ctrl+k', () => store.setCommandPaletteOpen(true));
  registerShortcut('enter', () => {
    const s = useStore.getState();
    if (!s.sketchActive && !s.measureActive) s.repeatLastCommand();
  });
  registerShortcut('shift+?', () => store.setShowShortcuts(true));
  registerShortcut('shift+/', () => store.setShowShortcuts(true));
  registerShortcut('escape', () => {
    // Esc backs out one step at a time: undo a body drag, cancel an
    // in-progress sketch shape, then exit the sketch, then leave measure,
    // then clear the selection.
    const s = useStore.getState();
    switch (escapeAction({ bodyDragging: s.bodyDragging, sketchActive: s.sketchActive, measureActive: s.measureActive, drawing: s.drawStart !== null })) {
      case 'cancelDrag': s.cancelSelectionDrag(); break;
      case 'cancelDraw': s.setDrawStart(null); break;
      case 'exitSketch': s.exitSketch(); break;
      case 'exitMeasure': s.setMeasureActive(false); break;
      case 'deselect': s.deselectAll(); break;
    }
  });
}
