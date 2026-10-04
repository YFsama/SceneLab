import { useStore, type PrimitiveKind } from '../../store/app';
import { useViewBookmarks } from '../../store/viewBookmarks';
import { listFaces } from '../geometry/query';
import { confirmDiscardIfDirty, saveProjectToFile, openProjectFromFile } from '../projectActions';
import { LIBRARY_PARTS } from '../library/parts';
import { SAMPLE_PROJECTS } from '../library/samples';
import { loadSampleProject } from '../library/loadSample';
import { translations } from '../i18n';
import { showToast } from '../toast';
import { framingBodies } from '../render/fitView';
import { downloadFile, exportOBJ, exportSTLBinary, export3MFPackage } from '../io';
import { importMeshFile } from '../io/importFiles';

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
  /** Registration-time label; used as-is unless a labelKey is present. */
  label: string;
  /** i18n key whose ACTIVE-locale text is the effective label. Commands
   *  registered with one re-localize at read time (commandLabel +
   *  searchCommands) so a runtime locale switch takes effect without
   *  re-registering; `label` stays the fallback for missing keys. */
  labelKey?: string;
  /** Locale-neutral suffix appended to the labelKey text (e.g. " (X)"). */
  labelSuffix?: string;
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
    const label = toSearchField(commandLabel(cmd));
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

/**
 * Locale-aware label for palette commands, resolved from the shared i18n
 * tables (the registry runs outside React, so no hook — same approach as the
 * params.open command below reads the locale). Reuses EXISTING keys only:
 * feature.*, menu.*, pattern.*, export.*, project.import.
 */
const tr = (key: string): string => {
  const locale = useStore.getState().locale;
  return (translations[locale] ?? translations.en!)?.[key] ?? translations.en![key] ?? key;
};

/** The command's effective label, resolved from the ACTIVE locale when a
 *  labelKey is registered (falling back to the registration-time label).
 *  Every label consumer — the palette, the recents flyout, searchCommands —
 *  goes through this, so a runtime locale switch re-localizes display AND
 *  fuzzy search without re-registering anything. */
export function commandLabel(cmd: Command): string {
  return cmd.labelKey ? tr(cmd.labelKey) + (cmd.labelSuffix ?? '') : cmd.label;
}

/** The id of a selected body, or null. Palette commands have no cursor
 * context (unlike the context menu, which pre-selects the right-clicked
 * body), so body-scoped verbs require an existing selection. */
function selectedBodyId(): string | null {
  const st = useStore.getState();
  return st.selectedIds.find((id) => st.bodies.some((b) => b.id === id)) ?? null;
}

/** Body-scoped palette verb wrapper: refuses with the same needs-body toast
 * the context-menu path shows when its store action finds no body. */
const needBody = (fn: () => void): (() => void) => () => {
  if (!selectedBodyId()) {
    showToast(tr('toast.featureNeedsBody'), 'warning');
    return;
  }
  fn();
};

/** Combine verbs additionally need a SECOND selected body (the context menu
 * hides the flyout until one exists); the palette refuses with the dedicated
 * two-bodies toast. */
const needTwoBodies = (fn: () => void): (() => void) => () => {
  const st = useStore.getState();
  const n = st.selectedIds.filter((id) => st.bodies.some((b) => b.id === id)).length;
  if (n < 2) {
    showToast(tr('toast.needsTwoBodies'), 'warning');
    return;
  }
  fn();
};

/** Success/needs-body toast shared by every feature command (identical to
 * the context-menu handlers' onApply feedback). */
const featureToast = (ok: boolean): void => {
  showToast(tr(ok ? 'toast.featureApplied' : 'toast.featureNeedsBody'), ok ? 'success' : 'warning');
};

/** Numeric-prompt feature entry: identical prompt parameters + apply/toast
 * behaviour as the corresponding context-menu item. */
const promptFeature = (
  titleKey: string, labelKey: string, initial: number, min: number,
  apply: (v: number) => boolean,
): (() => void) => () => {
  useStore.getState().openNumericPrompt({
    titleKey, labelKey, initial, min,
    onApply: (v) => featureToast(apply(v)),
  });
};

/** Export the selection (or the whole scene) — the exact handler body of
 * ProjectMenu's export buttons, from the same lib calls. */
function exportTargetsBodies() {
  const st = useStore.getState();
  return framingBodies(st.bodies, st.selectedIds, true);
}

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
  registerCommand({ id: 'view.measure', label: 'Measure (toggle)', category: 'View', shortcut: 'M', run: () => s().setMeasureActive(!s().measureActive) });
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
  registerCommand({ id: 'workspace.model', label: 'Workspace: Model', category: 'View', shortcut: 'Shift+M', run: () => s().setWorkspace('model') });
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
  // Camera view bookmarks (Fusion): the palette offers CAPTURE and CLEAR
  // only. Per-bookmark RESTORE commands are deliberately NOT registered —
  // the registry is a static table, while the restore list is dynamic (one
  // entry per stored bookmark, changing on every capture/remove); restores
  // live in the viewport's empty-space context menu, which renders the
  // current list on every open. Capture is decoupled like the fit commands:
  // the event reaches ViewportCanvas's listener, which owns the camera refs.
  registerCommand({
    id: 'view.bookmarkCurrent',
    label: tr('menu.bookmarkCurrent'),
    labelKey: 'menu.bookmarkCurrent',
    category: 'View',
    run: () => { window.dispatchEvent(new CustomEvent('scenelab:bookmark-view')); },
  });
  registerCommand({
    id: 'view.clearBookmarks',
    label: tr('menu.clearBookmarks'),
    labelKey: 'menu.clearBookmarks',
    category: 'View',
    run: () => { useViewBookmarks.getState().clear(); },
  });
  // Fusion-style Parameters dialog: every driving dimension in the document in
  // one editable table. Opened via the same window-event decoupling as the fit
  // commands so the registry stays independent of the component tree; the
  // label re-localizes with the locale (kept in sync by ParametersPanel).
  registerCommand({
    id: 'params.open',
    label: s().locale === 'zh' ? '参数…' : 'Parameters…',
    // The existing params.command key keeps this label following runtime
    // locale switches via commandLabel (ParametersPanel's manual cmd.label
    // sync becomes a harmless no-op).
    labelKey: 'params.command',
    category: 'Edit',
    run: () => { window.dispatchEvent(new CustomEvent('scenelab:open-parameters')); },
  });
  // --- Modeling verbs: the context menu's Feature / Transform / Pattern /
  // Combine flyouts, ProjectMenu's exports and the mesh import — all
  // reachable from the palette. Every run action performs the SAME store
  // call / prompt chain the context-menu item or ProjectMenu button makes
  // (labels reuse existing i18n keys); body-scoped verbs refuse with the
  // needs-body toast when the selection is empty.
  registerCommand({
    id: 'feature.extrude',
    label: tr('feature.extrude'),
    labelKey: 'feature.extrude',
    category: 'Modify',
    shortcut: 'E',
    // The dialog is meaningless without a sketch (same guard as the E key):
    // opening it would only end in the "no closed profile" failure toast.
    run: () => {
      if (!s().currentSketch) {
        showToast(tr('toast.needsSketch'), 'warning');
        return;
      }
      s().setShowExtrudeDialog(true);
    },
  });
  registerCommand({ id: 'feature.fillet', label: tr('feature.fillet'), labelKey: 'feature.fillet', category: 'Modify', run: needBody(promptFeature('feature.fillet', 'feature.filletPrompt', 2, 0.01, (v) => s().applyFilletFeature(v))) });
  registerCommand({ id: 'feature.chamfer', label: tr('feature.chamfer'), labelKey: 'feature.chamfer', category: 'Modify', run: needBody(promptFeature('feature.chamfer', 'feature.chamferPrompt', 2, 0.01, (v) => s().applyChamferFeature(v))) });
  registerCommand({ id: 'feature.shell', label: tr('feature.shell'), labelKey: 'feature.shell', category: 'Modify', run: needBody(promptFeature('feature.shell', 'feature.shellPrompt', 1.5, 0.01, (v) => s().applyShellFeature(v))) });
  registerCommand({
    id: 'feature.hole',
    label: tr('feature.hole'),
    labelKey: 'feature.hole',
    category: 'Modify',
    // Two-step entry like the context menu: diameter, then depth (0 = through).
    run: needBody(() => {
      useStore.getState().openNumericPrompt({
        titleKey: 'feature.hole', labelKey: 'feature.holeDiameter',
        initial: 5, min: 0.1,
        onApply: (d) => {
          useStore.getState().openNumericPrompt({
            titleKey: 'feature.hole', labelKey: 'feature.holeDepth',
            initial: 0, min: 0,
            onApply: (h) => {
              // Same click-to-place arming as the context-menu flow: the
              // viewport listener picks up the event, shows the hint pill,
              // and drills at the next click on the body.
              window.dispatchEvent(new CustomEvent('scenelab:arm-hole', {
                detail: { bodyId: selectedBodyId()!, diameter: d, depth: h > 0 ? h : null },
              }));
            },
          });
        },
      });
    }),
  });
  for (const plane of ['xy', 'xz', 'yz'] as const) {
    registerCommand({
      id: `feature.mirror${plane.toUpperCase()}`,
      label: tr(`feature.mirror${plane.toUpperCase()}`),
      labelKey: `feature.mirror${plane.toUpperCase()}`,
      category: 'Modify',
      run: needBody(() => featureToast(s().applyMirrorFeature(plane, true))),
    });
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    registerCommand({
      id: `feature.linearArray${axis.toUpperCase()}`,
      label: `${tr('feature.linearArray')} (${axis.toUpperCase()})`,
      labelKey: 'feature.linearArray',
      labelSuffix: ` (${axis.toUpperCase()})`,
      category: 'Modify',
      run: needBody(() => {
        useStore.getState().openNumericPrompt({
          titleKey: 'feature.linearArray', labelKey: 'pattern.count',
          initial: 3, min: 1,
          onApply: (count) => {
            useStore.getState().openNumericPrompt({
              titleKey: 'feature.linearArray', labelKey: 'pattern.spacing',
              initial: 10, min: 0.01,
              onApply: (spacing) => featureToast(useStore.getState().applyLinearArrayFeature(count, spacing, axis)),
            });
          },
        });
      }),
    });
  }
  registerCommand({ id: 'feature.circularArray', label: tr('feature.circularArray'), labelKey: 'feature.circularArray', category: 'Modify', run: needBody(promptFeature('feature.circularArray', 'pattern.count', 6, 1, (v) => s().applyCircularArrayFeature(Math.round(v)))) });
  registerCommand({ id: 'transform.move', label: tr('menu.move'), labelKey: 'menu.move', category: 'Modify', run: needBody(() => s().setMoveDialogOpen(true)) });
  registerCommand({ id: 'transform.rotate', label: tr('menu.rotateDlg'), labelKey: 'menu.rotateDlg', category: 'Modify', run: needBody(() => s().setRotateDialogOpen(true)) });
  registerCommand({ id: 'transform.scale', label: tr('menu.scaleDlg'), labelKey: 'menu.scaleDlg', category: 'Modify', run: needBody(() => s().setScaleDialogOpen(true)) });
  const patternCommands: [string, 'linear' | 'circular' | 'grid', string][] = [
    ['pattern.linear', 'linear', 'menu.linearPattern'],
    ['pattern.circular', 'circular', 'menu.circularPattern'],
    ['pattern.grid', 'grid', 'menu.gridPattern'],
  ];
  for (const [id, mode, key] of patternCommands) {
    registerCommand({
      id,
      label: tr(key),
      labelKey: key,
      category: 'Modify',
      run: needBody(() => s().setPendingPattern({ bodyId: selectedBodyId()!, mode })),
    });
  }
  // Combine resolves to the new body id, or null when the boolean produced
  // nothing — failures surface as the same combineFailed toast as the menu.
  const combineToasted = (op: 'union' | 'difference' | 'intersect') => needTwoBodies(async () => {
    try {
      const id = await useStore.getState().combineSelected(op);
      if (id == null) showToast(tr('toast.combineFailed'), 'warning');
    } catch {
      showToast(tr('toast.combineFailed'), 'warning');
    }
  });
  registerCommand({ id: 'combine.union', label: tr('menu.union'), labelKey: 'menu.union', category: 'Modify', run: combineToasted('union') });
  registerCommand({ id: 'combine.subtract', label: tr('menu.subtract'), labelKey: 'menu.subtract', category: 'Modify', run: combineToasted('difference') });
  registerCommand({ id: 'combine.intersect', label: tr('menu.intersect'), labelKey: 'menu.intersect', category: 'Modify', run: combineToasted('intersect') });
  // Exports — ProjectMenu's handlers verbatim (selection, else whole scene).
  registerCommand({
    id: 'export.stl',
    label: tr('export.stl'),
    labelKey: 'export.stl',
    category: 'Export',
    run: () => {
      const targets = exportTargetsBodies();
      if (targets.length === 0) { showToast(tr('toast.noBodies'), 'warning'); return; }
      try {
        for (const body of targets) {
          const buffer = exportSTLBinary(body);
          const blob = new Blob([buffer], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${body.name}.stl`;
          a.click();
          URL.revokeObjectURL(url);
        }
        showToast(tr('toast.stlExported'), 'success');
      } catch (e) {
        showToast(`${tr('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
  });
  registerCommand({
    id: 'export.obj',
    label: tr('export.obj'),
    labelKey: 'export.obj',
    category: 'Export',
    run: () => {
      const targets = exportTargetsBodies();
      if (targets.length === 0) { showToast(tr('toast.noBodies'), 'warning'); return; }
      try {
        for (const body of targets) downloadFile(exportOBJ(body), `${body.name}.obj`);
        showToast(tr('toast.objExported'), 'success');
      } catch (e) {
        showToast(`${tr('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
  });
  registerCommand({
    id: 'export.threemf',
    label: tr('export.threemf'),
    labelKey: 'export.threemf',
    category: 'Export',
    run: () => {
      const targets = exportTargetsBodies();
      if (targets.length === 0) { showToast(tr('toast.noBodies'), 'warning'); return; }
      try {
        const pkg = export3MFPackage(targets);
        const blob = new Blob([pkg as BlobPart], { type: 'model/3mf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${useStore.getState().projectName}.3mf`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(tr('toast.threemfExported'), 'success');
      } catch (e) {
        showToast(`${tr('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
  });
  registerCommand({
    id: 'export.png',
    label: tr('export.png'),
    labelKey: 'export.png',
    category: 'Export',
    run: () => {
      // Lazy import keeps the capture service (renderer dependency) out of
      // the registry's module graph for every command run.
      void import('../render/capture').then(({ captureFreshCanvas }) => {
        const canvas = captureFreshCanvas();
        if (!canvas) { showToast(tr('toast.noViewport'), 'warning'); return; }
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${useStore.getState().projectName}.png`;
          a.click();
          URL.revokeObjectURL(url);
          showToast(tr('toast.pngExported'), 'success');
        }, 'image/png');
      });
    },
  });
  registerCommand({
    id: 'project.importMesh',
    label: tr('project.import'),
    labelKey: 'project.import',
    category: 'Project',
    // ProjectMenu's hidden input, recreated on demand: opens the OS file
    // picker for STL/OBJ/3MF/STEP and imports through the same loader.
    run: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.stl,.obj,.3mf,.step,.stp';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const r = await importMeshFile(file);
          showToast(`${tr('toast.loaded')} "${file.name}"${r.bodyCount > 1 ? ` (${r.bodyCount})` : ''}`, 'success');
        } catch (err) {
          showToast(`${tr('toast.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      };
      input.click();
    },
  });
}
