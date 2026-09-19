import { useStore, type PrimitiveKind } from '../../store/app';
import { listFaces } from '../geometry/query';
import { confirmDiscardIfDirty, saveProjectToFile, openProjectFromFile } from '../projectActions';
import { LIBRARY_PARTS } from '../library/parts';
import { SAMPLE_PROJECTS } from '../library/samples';
import { loadSampleProject } from '../library/loadSample';

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

// Most-recently-run command ids (newest first) — powers the "Recent" section
// of the viewport context menu, like Fusion's right-click recent tools.
const history: string[] = [];
const HISTORY_CAP = 12;

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

/** Run a command by id; returns true if it existed and ran. Records it as recent. */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  cmd.run();
  recordRecent(id);
  return true;
}

/** The most recently used commands, newest first (Fusion right-click recents). */
export function recentCommands(max = 4): Command[] {
  return history.slice(0, max)
    .map((id) => commands.get(id))
    .filter((c): c is Command => c !== undefined);
}

function recordRecent(id: string): void {
  const i = history.indexOf(id);
  if (i !== -1) history.splice(i, 1);
  history.unshift(id);
  if (history.length > HISTORY_CAP) history.pop();
}

// Fuzzy-search tuning. Lower scores rank better; substring hits always beat
// subsequence hits, label hits beat id hits beat category hits.
const SUBSEQ_BASE = 100; // added to every subsequence-only match
const WORD_START_BONUS = 8; // substring starting on a word boundary
const SUBSEQ_WORD_BONUS = 6; // subsequence character landing on a word boundary
const ID_OFFSET = 1000; // id-only matches rank below every label match
const CATEGORY_OFFSET = 2000; // category-only matches rank below id matches

interface SearchField {
  lower: string;
  /** lower[i]'s source character starts a word (space/separator/camelCase hump). */
  wordStart: boolean[];
}

/** Precompute a case-insensitive view of a field plus its word-boundary map. */
function toSearchField(text: string): SearchField {
  const lower = text.toLowerCase();
  const wordStart: boolean[] = [];
  // toLowerCase() is length-preserving for the ASCII-heavy labels/ids used
  // here; if an exotic codepoint ever changes the length, drop the boundary
  // info rather than read out of sync.
  const sameLength = lower.length === text.length;
  for (let i = 0; i < lower.length; i++) {
    if (!sameLength || i === 0) {
      wordStart.push(i === 0 && sameLength);
      continue;
    }
    const prev = text[i - 1]!;
    const cur = text[i]!;
    wordStart.push(' -_/.:()'.includes(prev) || (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z'));
  }
  return { lower, wordStart };
}

/**
 * Best score for one token against one field (lower = better), or null when
 * the token doesn't match at all: an exact substring wins (earlier and
 * word-boundary-anchored better), otherwise a subsequence across the field
 * scored by compactness plus word-boundary hits ("zmsl" → "zoom to selection").
 */
function scoreToken(field: SearchField, token: string): number | null {
  const idx = field.lower.indexOf(token);
  if (idx >= 0) {
    return idx - (field.wordStart[idx] ? WORD_START_BONUS : 0);
  }
  let ti = 0;
  let first = -1;
  let last = -1;
  let boundaryHits = 0;
  for (let i = 0; i < field.lower.length && ti < token.length; i++) {
    if (field.lower[i] === token[ti]) {
      if (first === -1) first = i;
      last = i;
      if (field.wordStart[i]) boundaryHits++;
      ti++;
    }
  }
  if (ti < token.length) return null;
  return SUBSEQ_BASE + (last - first + 1) - boundaryHits * SUBSEQ_WORD_BONUS;
}

/**
 * Market-standard fuzzy palette search: every whitespace-separated token of
 * the query must match the command somewhere (AND), each token scored
 * independently as a substring or subsequence of the label, id or category —
 * label matches weighing highest. Ranked ascending by score; ties keep
 * registration order.
 */
export function searchCommands(query: string): Command[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return allCommands();
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of commands.values()) {
    const label = toSearchField(cmd.label);
    const id = toSearchField(cmd.id);
    const category = toSearchField(cmd.category ?? '');
    let total = 0;
    let matched = true;
    for (const token of tokens) {
      const candidates: number[] = [];
      const byLabel = scoreToken(label, token);
      const byId = scoreToken(id, token);
      const byCategory = scoreToken(category, token);
      if (byLabel !== null) candidates.push(byLabel);
      if (byId !== null) candidates.push(byId + ID_OFFSET);
      if (byCategory !== null) candidates.push(byCategory + CATEGORY_OFFSET);
      if (candidates.length === 0) {
        matched = false;
        break;
      }
      total += Math.min(...candidates);
    }
    if (matched) scored.push({ cmd, score: total });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.cmd);
}

/** For tests: clear the registry. */
export function clearCommands(): void {
  commands.clear();
  history.length = 0;
}

const PRIMITIVES: PrimitiveKind[] = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism', 'tube', 'coil'];

/** Register the built-in commands (idempotent). */
export function initBuiltinCommands(): void {
  const s = () => useStore.getState();
  registerCommand({ id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', run: () => s().undo() });
  registerCommand({ id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: 'Ctrl+Y', run: () => s().redo() });
  registerCommand({ id: 'edit.deleteSelected', label: 'Delete selected', category: 'Edit', shortcut: 'Del', run: () => s().deleteSelected() });
  registerCommand({ id: 'edit.selectAll', label: 'Select all', category: 'Edit', shortcut: 'Ctrl+A', run: () => s().selectAll() });
  registerCommand({ id: 'edit.deselectAll', label: 'Deselect all', category: 'Edit', shortcut: 'Ctrl+Shift+A', run: () => s().deselectAll() });
  registerCommand({ id: 'edit.invertSelection', label: 'Invert selection', category: 'Edit', shortcut: 'Ctrl+Shift+I', run: () => s().invertSelection() });
  registerCommand({ id: 'edit.repeatLast', label: 'Repeat last command', category: 'Edit', shortcut: 'Enter', run: () => s().repeatLastCommand() });
  registerCommand({ id: 'edit.duplicate', label: 'Duplicate selected', category: 'Edit', shortcut: 'Ctrl+D', run: () => s().duplicateSelected() });
  registerCommand({ id: 'edit.cut', label: 'Cut', category: 'Edit', shortcut: 'Ctrl+X', run: () => s().cutSelected() });
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
  registerCommand({ id: 'project.new', label: 'New document', category: 'Project', shortcut: 'Ctrl+N', run: async () => { if (await confirmDiscardIfDirty('project.new')) s().newProject(); } });
  registerCommand({ id: 'project.saveFile', label: 'Save project (.studio3d)', category: 'Project', shortcut: 'Ctrl+S', run: () => saveProjectToFile() });
  registerCommand({ id: 'project.openFile', label: 'Open project (.studio3d)', category: 'Project', shortcut: 'Ctrl+O', run: () => { void openProjectFromFile(); } });
  registerCommand({ id: 'scene.clear', label: 'Clear scene', category: 'Scene', run: async () => { if (await confirmDiscardIfDirty('scene.clear')) s().clearScene(); } });
  registerCommand({ id: 'reference.standardPlanes', label: 'Add standard planes (Front/Top/Right)', category: 'Reference', run: () => s().ensureStandardPlanes() });
  registerCommand({ id: 'reference.midplaneFromSelection', label: 'Midplane from selected body (largest opposite faces)', category: 'Reference', run: () => addMidplaneFromSelection() });
  registerCommand({ id: 'project.save', label: 'Autosave now', category: 'Project', run: () => s().autosave() });
  registerCommand({ id: 'project.restore', label: 'Restore autosave', category: 'Project', run: () => s().restoreAutosave() });
  // Keyboard hints mirror initShortcuts: 1 front, 2 top, 3 right, 4 iso,
  // 5 back, 6 bottom, 7 left.
  const viewKeys: Record<string, string> = { front: '1', top: '2', right: '3', iso: '4', back: '5', bottom: '6', left: '7' };
  for (const dir of ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const) {
    registerCommand({ id: `view.${dir}`, label: `View: ${dir}`, category: 'View', shortcut: viewKeys[dir], run: () => s().setViewDirection(dir) });
  }
  registerCommand({ id: 'view.toggleProjection', label: 'Toggle Perspective / Orthographic', category: 'View', shortcut: 'Shift+P', run: () => s().toggleProjection() });
  // Workspace switching — mirrors the S/M/D/C shortcuts. Entering Sketch also
  // activates the sketch (matching the 'S' hotkey).
  registerCommand({ id: 'workspace.sketch', label: 'Workspace: Sketch', category: 'View', shortcut: 'S', run: () => { if (!s().sketchActive) { s().setWorkspace('sketch'); s().setSketchActive(true); } } });
  registerCommand({ id: 'workspace.model', label: 'Workspace: Model', category: 'View', shortcut: 'M', run: () => s().setWorkspace('model') });
  registerCommand({ id: 'workspace.drawing', label: 'Workspace: Drawing', category: 'View', shortcut: 'D', run: () => s().setWorkspace('drawing') });
  registerCommand({ id: 'workspace.cam', label: 'Workspace: CAM', category: 'View', shortcut: 'C', run: () => s().setWorkspace('cam') });
  for (const kind of PRIMITIVES) {
    registerCommand({ id: `create.${kind}`, label: `Add ${kind}`, category: 'Create', run: () => s().addPrimitive(kind) });
  }
  // Sketch draw tools — mirror the L/R/O/A/P/V hotkeys (active in a sketch).
  const sketchTools: { tool: 'select' | 'line' | 'polyline' | 'rect' | 'circle' | 'arc' | 'polygon'; key: string }[] = [
    { tool: 'select', key: 'V' }, { tool: 'line', key: 'L' }, { tool: 'polyline', key: 'Shift+L' },
    { tool: 'rect', key: 'R' }, { tool: 'circle', key: 'O' }, { tool: 'arc', key: 'A' }, { tool: 'polygon', key: 'P' },
  ];
  for (const { tool, key } of sketchTools) {
    registerCommand({ id: `sketch.${tool}`, label: `Sketch tool: ${tool}`, category: 'Sketch', shortcut: key, run: () => s().setSketchTool(tool) });
  }
  // Beginner parts library + starter projects (TinkerCAD-style quick insert).
  registerCommand({ id: 'library.toggle', label: 'Toggle parts library', category: 'Create', shortcut: 'B', run: () => s().togglePartsLibrary() });
  for (const part of LIBRARY_PARTS) {
    registerCommand({ id: `library.insert.${part.id}`, label: `Insert part: ${part.id} (${part.spec})`, category: 'Create', run: () => { s().insertLibraryPart(part.id); } });
  }
  for (const sample of SAMPLE_PROJECTS) {
    registerCommand({ id: `sample.load.${sample.id}`, label: `Load sample: ${sample.id}`, category: 'Create', run: () => { void loadSampleProject(sample.id); } });
  }
  registerCommand({ id: 'help.welcome', label: 'Show welcome guide (empty scene)', category: 'Help', run: () => s().showWelcome() });
  // Fusion-style live section analysis + SolidWorks paste-in-place.
  registerCommand({ id: 'view.sectionToggle', label: 'Toggle section analysis', category: 'View', shortcut: 'X', run: () => { if (s().workspace === 'model') s().setSectionAnalysis({ active: !s().sectionAnalysis.active }); } });
  for (const ax of ['x', 'y', 'z'] as const) {
    registerCommand({ id: `view.sectionAxis${ax.toUpperCase()}`, label: `Section analysis: ${ax.toUpperCase()} axis`, category: 'View', run: () => s().setSectionAnalysis({ active: true, axis: ax, offset: 0 }) });
  }
  registerCommand({ id: 'edit.pasteInPlace', label: 'Paste in place', category: 'Edit', shortcut: 'Ctrl+Shift+V', run: () => s().pasteInPlace() });
  registerCommand({ id: 'view.toggleShadows', label: 'Toggle ground shadows', category: 'View', run: () => s().setGroundShadows(!s().groundShadows) });
  // Viewport fit commands. The actual F / Shift+F keys are handled locally in
  // ViewportCanvas; these palette entries replay them by dispatching a window
  // event the canvas listens for, so the shortcuts and the palette stay in
  // sync without coupling the registry to the viewport.
  registerCommand({
    id: 'view.fitAll',
    label: 'Zoom to fit (F)',
    category: 'View',
    shortcut: 'F',
    run: () => { window.dispatchEvent(new CustomEvent('scenelab:fit-view', { detail: { selection: false } })); },
  });
  registerCommand({
    id: 'view.fitSelection',
    label: 'Zoom to selection (Shift+F)',
    category: 'View',
    shortcut: 'Shift+F',
    run: () => { window.dispatchEvent(new CustomEvent('scenelab:fit-view', { detail: { selection: true } })); },
  });
}
