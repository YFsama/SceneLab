import { useStore, type PrimitiveKind } from '../../store/app';

export interface Command {
  id: string;
  label: string;
  category?: string;
  /** Optional keyboard hint shown in the palette (display only). */
  shortcut?: string;
  run: () => void;
}

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

/** Run a command by id; returns true if it existed and ran. */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  cmd.run();
  return true;
}

/**
 * Fuzzy-ish command search for a command palette: case-insensitive substring
 * match on label / id / category, ranked so earlier matches and label hits
 * come first.
 */
export function searchCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return allCommands();
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of commands.values()) {
    const label = cmd.label.toLowerCase();
    const hay = `${label} ${cmd.id.toLowerCase()} ${(cmd.category ?? '').toLowerCase()}`;
    const idx = hay.indexOf(q);
    if (idx < 0) continue;
    // Prefer matches in the label, and earlier matches.
    const labelIdx = label.indexOf(q);
    const score = (labelIdx >= 0 ? labelIdx : 1000 + idx);
    scored.push({ cmd, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.cmd);
}

/** For tests: clear the registry. */
export function clearCommands(): void {
  commands.clear();
}

const PRIMITIVES: PrimitiveKind[] = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism', 'tube', 'coil'];

/** Register the built-in commands (idempotent). */
export function initBuiltinCommands(): void {
  const s = () => useStore.getState();
  registerCommand({ id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', run: () => s().undo() });
  registerCommand({ id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: 'Ctrl+Y', run: () => s().redo() });
  registerCommand({ id: 'edit.deleteSelected', label: 'Delete selected', category: 'Edit', shortcut: 'Del', run: () => s().deleteSelected() });
  registerCommand({ id: 'edit.deselectAll', label: 'Deselect all', category: 'Edit', run: () => s().deselectAll() });
  registerCommand({ id: 'scene.clear', label: 'Clear scene', category: 'Scene', run: () => s().clearScene() });
  registerCommand({ id: 'project.save', label: 'Autosave now', category: 'Project', run: () => s().autosave() });
  registerCommand({ id: 'project.restore', label: 'Restore autosave', category: 'Project', run: () => s().restoreAutosave() });
  for (const dir of ['top', 'front', 'right', 'iso'] as const) {
    registerCommand({ id: `view.${dir}`, label: `View: ${dir}`, category: 'View', run: () => s().setViewDirection(dir) });
  }
  for (const kind of PRIMITIVES) {
    registerCommand({ id: `create.${kind}`, label: `Add ${kind}`, category: 'Create', run: () => s().addPrimitive(kind) });
  }
}
