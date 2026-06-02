import { useStore, type PrimitiveKind } from '../../store/app';
import { listFaces } from '../geometry/query';

/**
 * Build a midplane on the selected body (or the first body) from its two
 * largest parallel, opposite-facing faces — the common SolidWorks workflow of
 * picking a part's bounding walls. Returns the new plane id, or null if no
 * suitable face pair exists. Exported for testing.
 */
export function addMidplaneFromSelection(): string | null {
  const st = useStore.getState();
  const selected = st.selectedIds.find((id) => st.bodies.some((b) => b.id === id));
  const body = selected ? st.bodies.find((b) => b.id === selected) : st.bodies[0];
  if (!body) return null;
  const faces = listFaces(body);
  // Find the opposite-facing face pair with the greatest combined area.
  let best: { a: string; b: string; score: number } | null = null;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const na = faces[i]!.normal;
      const nb = faces[j]!.normal;
      const d = na.x * nb.x + na.y * nb.y + na.z * nb.z;
      if (d > -0.9) continue; // not opposite-facing
      const score = faces[i]!.area + faces[j]!.area;
      if (!best || score > best.score) best = { a: faces[i]!.id, b: faces[j]!.id, score };
    }
  }
  if (!best) return null;
  return st.addMidplane(body.id, best.a, best.b);
}

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
  registerCommand({ id: 'edit.selectAll', label: 'Select all', category: 'Edit', shortcut: 'Ctrl+A', run: () => s().selectAll() });
  registerCommand({ id: 'edit.deselectAll', label: 'Deselect all', category: 'Edit', run: () => s().deselectAll() });
  registerCommand({ id: 'edit.invertSelection', label: 'Invert selection', category: 'Edit', shortcut: 'Ctrl+Shift+I', run: () => s().invertSelection() });
  registerCommand({ id: 'edit.duplicate', label: 'Duplicate selected', category: 'Edit', shortcut: 'Ctrl+D', run: () => s().duplicateSelected() });
  registerCommand({ id: 'edit.copy', label: 'Copy', category: 'Edit', shortcut: 'Ctrl+C', run: () => s().copySelected() });
  registerCommand({ id: 'edit.paste', label: 'Paste', category: 'Edit', shortcut: 'Ctrl+V', run: () => s().paste() });
  registerCommand({ id: 'edit.dropFloor', label: 'Drop selected to floor', category: 'Edit', run: () => s().dropSelectedToFloor() });
  registerCommand({ id: 'edit.scaleUp', label: 'Scale selected 2×', category: 'Edit', run: () => s().scaleSelected(2) });
  registerCommand({ id: 'edit.scaleDown', label: 'Scale selected ½×', category: 'Edit', run: () => s().scaleSelected(0.5) });
  for (const ax of ['x', 'y', 'z'] as const) {
    registerCommand({ id: `edit.rotate${ax}`, label: `Rotate selected 90° about ${ax.toUpperCase()}`, category: 'Edit', run: () => s().rotateSelected(ax, 90) });
  }
  registerCommand({ id: 'view.isolate', label: 'Isolate selected', category: 'View', run: () => s().isolateSelected() });
  registerCommand({ id: 'view.hideSelected', label: 'Hide selected', category: 'View', shortcut: 'Tab', run: () => s().hideSelected() });
  registerCommand({ id: 'view.showAll', label: 'Show all bodies', category: 'View', shortcut: 'Shift+Tab', run: () => s().showAllBodies() });
  registerCommand({ id: 'view.toggleWireframe', label: 'Toggle wireframe', category: 'View', run: () => s().setWireframe(!s().wireframe) });
  registerCommand({ id: 'view.toggleGrid', label: 'Toggle grid', category: 'View', shortcut: 'G', run: () => s().setShowGrid(!s().showGrid) });
  registerCommand({ id: 'view.measure', label: 'Measure (toggle)', category: 'View', run: () => s().setMeasureActive(!s().measureActive) });
  registerCommand({ id: 'project.new', label: 'New document', category: 'Project', run: () => s().newProject() });
  registerCommand({ id: 'scene.clear', label: 'Clear scene', category: 'Scene', run: () => s().clearScene() });
  registerCommand({ id: 'reference.standardPlanes', label: 'Add standard planes (Front/Top/Right)', category: 'Reference', run: () => s().ensureStandardPlanes() });
  registerCommand({ id: 'reference.midplaneFromSelection', label: 'Midplane from selected body (largest opposite faces)', category: 'Reference', run: () => addMidplaneFromSelection() });
  registerCommand({ id: 'project.save', label: 'Autosave now', category: 'Project', run: () => s().autosave() });
  registerCommand({ id: 'project.restore', label: 'Restore autosave', category: 'Project', run: () => s().restoreAutosave() });
  for (const dir of ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const) {
    registerCommand({ id: `view.${dir}`, label: `View: ${dir}`, category: 'View', run: () => s().setViewDirection(dir) });
  }
  for (const kind of PRIMITIVES) {
    registerCommand({ id: `create.${kind}`, label: `Add ${kind}`, category: 'Create', run: () => s().addPrimitive(kind) });
  }
}
