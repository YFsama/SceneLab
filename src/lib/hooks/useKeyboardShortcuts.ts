import { useEffect } from 'react';
import { useStore } from '../../store/app';

const shortcuts: Record<string, () => void> = {};

export function registerShortcut(key: string, handler: () => void): void {
  shortcuts[key] = handler;
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

  // View shortcuts
  registerShortcut('1', () => store.setViewDirection('top'));
  registerShortcut('2', () => store.setViewDirection('front'));
  registerShortcut('3', () => store.setViewDirection('right'));
  registerShortcut('0', () => store.setViewDirection('iso'));

  // Workspace shortcuts
  registerShortcut('s', () => {
    if (!store.sketchActive) {
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
  registerShortcut('v', () => store.setSketchTool('select'));

  // Panel toggles
  registerShortcut('ctrl+b', () => store.toggleBrowserTree());
  registerShortcut('ctrl+p', () => store.toggleProperties());

  // Actions
  registerShortcut('escape', () => {
    if (store.sketchActive) {
      store.setSketchActive(false);
      store.setCurrentSketch(null);
      store.setWorkspace('model');
    }
    store.deselectAll();
  });
}
