export type StdView = 'front' | 'top' | 'right' | 'iso';

/**
 * Map a number key to a standard view, like a CAD viewer's view hotkeys
 * (1 Front, 2 Top, 3 Right, 4 Isometric). Returns null for any other key.
 */
export function keyToView(key: string): StdView | null {
  switch (key) {
    case '1': return 'front';
    case '2': return 'top';
    case '3': return 'right';
    case '4': return 'iso';
    default: return null;
  }
}
