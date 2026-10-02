import type { ViewDirection } from '../../store/app';

// The six standard orthographic views plus isometric. Shortcut badges match the
// central hotkeys (initShortcuts): 1 front, 2 top, 3 right, 4 iso; the remaining
// views are reachable here, via the right-click View Orientation menu, or the
// command palette. Shared by ViewCube (rendering) and its test.
export const VIEWS: { dir: ViewDirection; shortcut?: string }[] = [
  { dir: 'front', shortcut: '1' },
  { dir: 'back', shortcut: '5' },
  { dir: 'left', shortcut: '7' },
  { dir: 'right', shortcut: '3' },
  { dir: 'top', shortcut: '2' },
  { dir: 'bottom', shortcut: '6' },
  { dir: 'iso', shortcut: '4' },
];
