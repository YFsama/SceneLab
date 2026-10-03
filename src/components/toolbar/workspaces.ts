import { Box, Pen, Ruler, Settings } from 'lucide-react';
import type { WorkspaceMode } from '../../store/app';

/** Workspace switcher table shared by Toolbar (rendering) and its test. */
export const WORKSPACES: { mode: WorkspaceMode; icon: typeof Box; shortcut: string }[] = [
  { mode: 'sketch', icon: Pen, shortcut: 'S' },
  // Shift+M mirrors initShortcuts (useKeyboardShortcuts.ts): plain M is the
  // Measure tool since pass #17 — the tooltip must not claim the wrong key.
  { mode: 'model', icon: Box, shortcut: 'Shift+M' },
  { mode: 'drawing', icon: Ruler, shortcut: 'D' },
  { mode: 'cam', icon: Settings, shortcut: 'C' },
];
