import { useEffect } from 'react';
import { useStore } from '../../store/app';
import { confirmDiscardIfDirty, saveProjectToFile } from '../projectActions';

const shortcuts: Record<string, () => void> = {};

export function registerShortcut(key: string, handler: () => void): void {
  shortcuts[key] = handler;
}

/**
 * What the Escape key should cancel, in priority order: an in-progress sketch
 * drag first (cancel the current shape, staying in the sketch), then exit the
 * sketch, then the measure tool, then the selection — mirroring how Esc backs
 * out one step at a time in SolidWorks.
 */
export function escapeAction(
  s: { sketchActive: boolean; measureActive: boolean; drawing?: boolean },
): 'cancelDraw' | 'exitSketch' | 'exitMeasure' | 'deselect' {
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
  registerShortcut('r', () => store.setSketchTool('rect'));
  registerShortcut('o', () => store.setSketchTool('circle'));
  registerShortcut('a', () => store.setSketchTool('arc'));
  registerShortcut('p', () => store.setSketchTool('polygon'));
  registerShortcut('v', () => store.setSketchTool('select'));

  // Panel toggles
  registerShortcut('ctrl+b', () => store.toggleBrowserTree());
  registerShortcut('ctrl+p', () => store.toggleProperties());

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
  registerShortcut('ctrl+shift+i', () => store.invertSelection());
  registerShortcut('f2', () => store.beginRenameSelected());
  // Tab hides the current selection; Shift+Tab brings every hidden body back.
  registerShortcut('tab', () => store.hideSelected());
  registerShortcut('shift+tab', () => store.showAllBodies());
  registerShortcut('ctrl+c', () => store.copySelected());
  registerShortcut('ctrl+v', () => store.paste());
  registerShortcut('ctrl+z', () => store.undo());
  registerShortcut('ctrl+shift+z', () => store.redo());
  registerShortcut('ctrl+y', () => store.redo());
  registerShortcut('ctrl+s', () => saveProjectToFile());
  registerShortcut('ctrl+n', () => { void confirmDiscardIfDirty('project.new').then((ok) => { if (ok) useStore.getState().newProject(); }); });
  registerShortcut('ctrl+k', () => store.setCommandPaletteOpen(true));
  registerShortcut('shift+?', () => store.setShowShortcuts(true));
  registerShortcut('shift+/', () => store.setShowShortcuts(true));
  registerShortcut('escape', () => {
    // Esc backs out one step at a time: cancel an in-progress sketch shape,
    // then exit the sketch, then leave measure, then clear the selection.
    const s = useStore.getState();
    switch (escapeAction({ sketchActive: s.sketchActive, measureActive: s.measureActive, drawing: s.drawStart !== null })) {
      case 'cancelDraw': s.setDrawStart(null); break;
      case 'exitSketch': s.exitSketch(); break;
      case 'exitMeasure': s.setMeasureActive(false); break;
      case 'deselect': s.deselectAll(); break;
    }
  });
}
