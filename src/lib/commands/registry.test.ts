import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, getCommand, runCommand, searchCommands, allCommands, clearCommands, recentCommands, initBuiltinCommands, addMidplaneFromSelection, commandLabel } from './registry';
import { useStore } from '../../store/app';
import { useViewBookmarks } from '../../store/viewBookmarks';
import { createBox, createCylinder, createTorus } from '../geometry';
import { createSketch } from '../sketch/engine';
import { translations } from '../i18n';
import { clearToasts, getToasts } from '../toast';

describe('command registry', () => {
  beforeEach(() => clearCommands());

  it('registers, finds and runs a command', () => {
    let ran = 0;
    registerCommand({ id: 'test.cmd', label: 'Do the thing', run: () => { ran += 1; } });
    expect(getCommand('test.cmd')?.label).toBe('Do the thing');
    expect(runCommand('test.cmd')).toBe(true);
    expect(ran).toBe(1);
    expect(runCommand('nope')).toBe(false); // unknown id
  });

  it('searches by label/id substring, ranking label hits first', () => {
    registerCommand({ id: 'view.top', label: 'View: top', category: 'View', run: () => {} });
    registerCommand({ id: 'create.box', label: 'Add box', category: 'Create', run: () => {} });
    const hits = searchCommands('box');
    expect(hits[0]?.id).toBe('create.box');
    expect(searchCommands('view').some((c) => c.id === 'view.top')).toBe(true);
    expect(searchCommands('')).toHaveLength(allCommands().length); // empty → all
    expect(searchCommands('zzz')).toHaveLength(0);
  });

  it('registers the built-in command set, including reference geometry', () => {
    initBuiltinCommands();
    expect(getCommand('edit.undo')).toBeDefined();
    expect(getCommand('create.box')).toBeDefined();
    expect(getCommand('view.iso')).toBeDefined();
    expect(getCommand('reference.standardPlanes')).toBeDefined();
    expect(getCommand('reference.midplaneFromSelection')).toBeDefined();
    // Edit/view actions are searchable in the palette too.
    expect(getCommand('edit.duplicate')).toBeDefined();
    expect(getCommand('edit.selectAll')).toBeDefined();
    expect(getCommand('edit.rotatez')).toBeDefined();
    expect(getCommand('view.toggleWireframe')).toBeDefined();
    expect(allCommands().length).toBeGreaterThan(10);
  });

  it('reference.standardPlanes command seeds the three datum planes', () => {
    useStore.getState().clearScene();
    initBuiltinCommands();
    expect(runCommand('reference.standardPlanes')).toBe(true);
    expect(useStore.getState().planes).toHaveLength(3);
  });

  it('registers the viewport fit commands for palette discovery', () => {
    initBuiltinCommands();
    expect(getCommand('view.fitAll')?.label).toBe('Zoom to fit (F)');
    expect(getCommand('view.fitAll')?.shortcut).toBe('F');
    expect(getCommand('view.fitSelection')?.label).toBe('Zoom to selection (Shift+F)');
    expect(getCommand('view.fitSelection')?.shortcut).toBe('Shift+F');
    expect(allCommands().map((c) => c.id)).toContain('view.fitAll');
    expect(allCommands().map((c) => c.id)).toContain('view.fitSelection');
  });

  it('fit commands dispatch scenelab:fit-view events with a selection flag', () => {
    initBuiltinCommands();
    const events: CustomEvent[] = [];
    const listener = (e: Event) => { events.push(e as CustomEvent); };
    window.addEventListener('scenelab:fit-view', listener);
    try {
      expect(runCommand('view.fitAll')).toBe(true);
      expect(runCommand('view.fitSelection')).toBe(true);
    } finally {
      window.removeEventListener('scenelab:fit-view', listener);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(CustomEvent);
    expect(events[0]!.detail).toEqual({ selection: false });
    expect(events[1]!.detail).toEqual({ selection: true });
  });
});

describe('fuzzy command search', () => {
  beforeEach(() => clearCommands());

  it('ranks exact label substring hits by position, word-start first', () => {
    registerCommand({ id: 'test.selectAll', label: 'Select all', run: () => {} });
    registerCommand({ id: 'test.invertSelection', label: 'Invert selection', run: () => {} });
    registerCommand({ id: 'test.deleteSelected', label: 'Delete selected', run: () => {} });
    const hits = searchCommands('sel');
    // "Select all" starts with the query at a word boundary; the other two hit
    // mid-phrase ("selected"/"selection" also start words, but later in the label).
    expect(hits[0]?.id).toBe('test.selectAll');
    expect(hits.map((c) => c.id).sort()).toEqual(['test.deleteSelected', 'test.invertSelection', 'test.selectAll']);
  });

  it('matches id and category as lower-weighted fallbacks', () => {
    registerCommand({ id: 'y.bar', label: 'Reference marker', category: 'View', run: () => {} });
    registerCommand({ id: 'x.foo', label: 'Widget', category: 'Reference', run: () => {} });
    const hits = searchCommands('reference');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe('y.bar'); // label hit outranks the category-only hit
    expect(hits[1]?.id).toBe('x.foo');
  });

  it('falls back to fuzzy id matching (initialism over the id)', () => {
    initBuiltinCommands();
    // "vtwf" is an initialism of the id view.toggleWireframe; its label
    // ("Toggle wireframe") has no 'v', so only the id can match.
    expect(searchCommands('vtwf').map((c) => c.id)).toContain('view.toggleWireframe');
  });

  it('matches a subsequence across the label ("zmsl" → zoom to selection)', () => {
    initBuiltinCommands();
    const hits = searchCommands('zmsl');
    expect(hits[0]?.id).toBe('view.fitSelection');
    expect(searchCommands('zmf')[0]?.id).toBe('view.fitAll'); // zoom→fit
  });

  it('multi-token AND: every token must match somewhere', () => {
    registerCommand({ id: 'view.fitSelection', label: 'Zoom to selection (Shift+F)', run: () => {} });
    registerCommand({ id: 'view.toggleGrid', label: 'Toggle grid', run: () => {} });
    const hits = searchCommands('zoom sel');
    expect(hits.map((c) => c.id)).toEqual(['view.fitSelection']); // "grid" fails "sel"
    expect(searchCommands('zoom')).toHaveLength(1);
    expect(searchCommands('grid zz')).toHaveLength(0); // one dead token kills the match
  });

  it('built-in multi-token search finds the fit commands', () => {
    initBuiltinCommands();
    expect(searchCommands('zoom sel').map((c) => c.id)).toEqual(['view.fitSelection']);
    expect(searchCommands('zoom fit').map((c) => c.id)[0]).toBe('view.fitAll');
  });

  it('returns empty for no match and everything for a blank query', () => {
    registerCommand({ id: 'a', label: 'Alpha', run: () => {} });
    expect(searchCommands('qqqq')).toHaveLength(0);
    expect(searchCommands('   ')).toHaveLength(1); // whitespace-only → all
    expect(searchCommands('')).toHaveLength(1);
  });
});

describe('addMidplaneFromSelection', () => {
  beforeEach(() => useStore.getState().clearScene());

  it('returns null when the scene is empty', () => {
    expect(addMidplaneFromSelection()).toBeNull();
  });

  it('builds a midplane from a body\'s largest opposite faces', () => {
    const box = createBox(10, 20, 10);
    useStore.getState().addDirectBody(box);
    const id = addMidplaneFromSelection();
    expect(id).toBeTruthy();
    const mid = useStore.getState().planes.find((p) => p.id === id)!;
    // The largest opposite faces are the 10×20 side walls; their midplane sits
    // at the body centre (y = 10 for a 20-tall box, but a side-wall pair gives a
    // plane through the centroid regardless of which axis wins).
    expect(mid).toBeDefined();
  });

  it('prefers the selected body when one is selected', () => {
    const a = createBox(10, 10, 10);
    const b = createBox(30, 30, 30);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().selectObject(a.id);
    const id = addMidplaneFromSelection();
    expect(id).toBeTruthy();
  });

  it('adds the plane to the store', () => {
    const box = createBox(10, 20, 10);
    useStore.getState().addDirectBody(box);
    const before = useStore.getState().planes.length;
    addMidplaneFromSelection();
    expect(useStore.getState().planes.length).toBe(before + 1);
  });

  it('midplane has a valid origin and normal', () => {
    const box = createBox(10, 20, 30);
    useStore.getState().addDirectBody(box);
    const id = addMidplaneFromSelection();
    expect(id).toBeTruthy();
    const mid = useStore.getState().planes.find((p) => p.id === id)!;
    // Midplane should have a unit normal.
    const nLen = Math.hypot(mid.normal.x, mid.normal.y, mid.normal.z);
    expect(nLen).toBeCloseTo(1, 6);
    // Origin should be finite.
    expect(Number.isFinite(mid.origin.x)).toBe(true);
    expect(Number.isFinite(mid.origin.y)).toBe(true);
    expect(Number.isFinite(mid.origin.z)).toBe(true);
  });

  it('works with a cylinder body', () => {
    const cyl = createCylinder(5, 20, 16);
    useStore.getState().addDirectBody(cyl);
    const id = addMidplaneFromSelection();
    expect(id).toBeTruthy();
    const mid = useStore.getState().planes.find((p) => p.id === id)!;
    expect(mid).toBeDefined();
    const nLen = Math.hypot(mid.normal.x, mid.normal.y, mid.normal.z);
    expect(nLen).toBeCloseTo(1, 6);
  });

  it('works with a torus body', () => {
    const torus = createTorus(10, 3, 16, 8);
    useStore.getState().addDirectBody(torus);
    const id = addMidplaneFromSelection();
    expect(id).toBeTruthy();
    const mid = useStore.getState().planes.find((p) => p.id === id)!;
    expect(mid).toBeDefined();
    const nLen = Math.hypot(mid.normal.x, mid.normal.y, mid.normal.z);
    expect(nLen).toBeCloseTo(1, 6);
  });
});

describe('recent command history (Fusion-style right-click recents)', () => {
  beforeEach(() => clearCommands());

  it('runCommand records usage, newest first, deduped', () => {
    registerCommand({ id: 'a', label: 'A', run: () => {} });
    registerCommand({ id: 'b', label: 'B', run: () => {} });
    runCommand('a');
    runCommand('b');
    runCommand('a'); // re-running moves it back to the front
    expect(recentCommands().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('caps the history length', () => {
    for (let i = 0; i < 15; i++) registerCommand({ id: `c${i}`, label: `C${i}`, run: () => {} });
    for (let i = 0; i < 15; i++) runCommand(`c${i}`);
    expect(recentCommands(50).length).toBeLessThanOrEqual(12);
    // The most recent command is still first.
    expect(recentCommands(1)[0]?.id).toBe('c14');
  });

  it('unknown ids are not recorded and clearCommands resets history', () => {
    registerCommand({ id: 'x', label: 'X', run: () => {} });
    runCommand('x');
    runCommand('missing');
    expect(recentCommands()).toHaveLength(1);
    clearCommands();
    expect(recentCommands()).toHaveLength(0);
  });
});

describe('modeling verbs in the palette (F3)', () => {
  beforeEach(() => {
    clearCommands();
    clearToasts();
    useStore.setState({
      bodies: [], directBodies: [], selectedIds: [], numericPrompt: null,
      moveDialogOpen: false, rotateDialogOpen: false, scaleDialogOpen: false,
      pendingPattern: null, showExtrudeDialog: false,
    });
  });

  const VERB_IDS = [
    'feature.extrude', 'feature.fillet', 'feature.chamfer', 'feature.shell', 'feature.hole',
    'feature.mirrorXY', 'feature.mirrorXZ', 'feature.mirrorYZ',
    'feature.linearArrayX', 'feature.linearArrayY', 'feature.linearArrayZ', 'feature.circularArray',
    'transform.move', 'transform.rotate', 'transform.scale',
    'pattern.linear', 'pattern.circular', 'pattern.grid',
    'combine.union', 'combine.subtract', 'combine.intersect',
    'export.stl', 'export.obj', 'export.threemf', 'export.png', 'project.importMesh',
  ];

  it('registers every modeling / transform / pattern / combine / export verb', () => {
    initBuiltinCommands();
    for (const id of VERB_IDS) expect(getCommand(id), id).toBeDefined();
    expect(allCommands().length).toBeGreaterThan(VERB_IDS.length);
  });

  it("the audit's dead searches now hit: extrude, fillet, shell, pattern, move, export stl", () => {
    initBuiltinCommands();
    expect(searchCommands('extrude')[0]?.id).toBe('feature.extrude');
    expect(searchCommands('fillet')[0]?.id).toBe('feature.fillet');
    expect(searchCommands('shell').map((c) => c.id)).toContain('feature.shell');
    expect(searchCommands('pattern').map((c) => c.id)).toContain('pattern.linear');
    expect(searchCommands('move').map((c) => c.id)).toContain('transform.move');
    expect(searchCommands('export stl')[0]?.id).toBe('export.stl');
  });

  it('labels come from the shared i18n tables and follow the locale', () => {
    initBuiltinCommands();
    expect(getCommand('feature.fillet')?.label).toBe(translations.en!['feature.fillet']!);
    expect(getCommand('transform.move')?.label).toBe(translations.en!['menu.move']!);
    expect(getCommand('export.stl')?.label).toBe(translations.en!['export.stl']!);
    useStore.setState({ locale: 'zh' });
    try {
      clearCommands();
      initBuiltinCommands();
      expect(getCommand('feature.fillet')?.label).toBe(translations.zh!['feature.fillet']!);
    } finally {
      useStore.setState({ locale: 'en' });
    }
  });

  it('labels follow a RUNTIME locale switch without re-registering (labelKey)', () => {
    // Registered under en — then the store locale flips, as the language
    // toggle does at runtime. commandLabel and searchCommands resolve from
    // the ACTIVE locale, so display AND fuzzy search re-localize in place.
    initBuiltinCommands();
    expect(commandLabel(getCommand('feature.fillet')!)).toBe(translations.en!['feature.fillet']!);
    const zhLabel = translations.zh!['feature.fillet']!;
    // The zh label matches nothing while the active locale is en…
    expect(searchCommands(zhLabel).map((c) => c.id)).not.toContain('feature.fillet');
    useStore.setState({ locale: 'zh' });
    try {
      expect(commandLabel(getCommand('feature.fillet')!)).toBe(zhLabel);
      // …and the verb stays findable by the NEW locale's label, no reboot.
      expect(searchCommands(zhLabel).map((c) => c.id)).toContain('feature.fillet');
      // Composite labels keep their locale-neutral suffix.
      expect(commandLabel(getCommand('feature.linearArrayX')!)).toBe(`${translations.zh!['feature.linearArray']!} (X)`);
      // Key-less commands (dynamic English labels) are untouched.
      expect(commandLabel(getCommand('create.box')!)).toBe('Add box');
    } finally {
      useStore.setState({ locale: 'en' });
    }
  });

  it('body-scoped verbs refuse with toast.featureNeedsBody and open no prompt when nothing is selected', () => {
    initBuiltinCommands();
    for (const id of ['feature.fillet', 'feature.shell', 'transform.move', 'pattern.linear']) {
      expect(runCommand(id), id).toBe(true);
    }
    expect(useStore.getState().numericPrompt).toBeNull();
    expect(useStore.getState().moveDialogOpen ?? false).toBe(false);
    expect(getToasts().map((x) => x.message)).toEqual(
      Array.from({ length: 4 }, () => translations.en!['toast.featureNeedsBody']!),
    );
  });

  it('feature.hole arms click-to-place via the scenelab:arm-hole event (same as the menu)', async () => {
    initBuiltinCommands();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    const armed = new Promise<CustomEvent>((resolve) => {
      window.addEventListener('scenelab:arm-hole', (e) => resolve(e as CustomEvent), { once: true });
    });
    runCommand('feature.hole');
    // ⌀ prompt → depth prompt → the depth apply must ARM, not drill at the
    // centroid. Drive the store-driven prompts directly (the dialog UI is
    // covered by its own suite).
    const diameterPrompt = useStore.getState().numericPrompt!;
    useStore.getState().closeNumericPrompt();
    diameterPrompt.onApply(3);
    const depthPrompt = useStore.getState().numericPrompt!;
    useStore.getState().closeNumericPrompt();
    depthPrompt.onApply(0); // through-all

    const detail = (await armed).detail as { bodyId: string; diameter: number; depth: number | null };
    expect(detail.bodyId).toBe(box.id);
    expect(detail.diameter).toBe(3);
    expect(detail.depth).toBeNull(); // 0 through-all default applied
    // And nothing was drilled yet — the click does that.
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('combine verbs refuse with toast.needsTwoBodies when fewer than TWO bodies are selected', () => {
    initBuiltinCommands();
    // Nothing selected → also the dedicated two-bodies refusal.
    runCommand('combine.union');
    expect(getToasts().map((x) => x.message)).toEqual([translations.en!['toast.needsTwoBodies']!]);
    // One selected body is still not enough.
    clearToasts();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    runCommand('combine.subtract');
    expect(getToasts().map((x) => x.message)).toEqual([translations.en!['toast.needsTwoBodies']!]);
    expect(getToasts().map((x) => x.message)).not.toContain(translations.en!['toast.featureNeedsBody']!);
  });

  it('feature.fillet with a selected body opens the context-menu prompt and applies for real', () => {
    initBuiltinCommands();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    runCommand('feature.fillet');
    const prompt = useStore.getState().numericPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt!.titleKey).toBe('feature.fillet');
    expect(prompt!.labelKey).toBe('feature.filletPrompt');
    expect(prompt!.initial).toBe(2);
    expect(prompt!.min).toBe(0.01);

    prompt!.onApply(1);
    expect(getToasts().map((x) => x.message)).toContain(translations.en!['toast.featureApplied']!);
    expect(getToasts().map((x) => x.message)).not.toContain(translations.en!['toast.featureNeedsBody']!);
  });

  it('feature.extrude opens the same dialog the E shortcut opens (with a sketch)', () => {
    initBuiltinCommands();
    // Without a sketch the command refuses (same guard as the E key)…
    runCommand('feature.extrude');
    expect(useStore.getState().showExtrudeDialog).toBe(false);
    // …with one, it opens the dialog.
    useStore.setState({ currentSketch: createSketch('xz') });
    runCommand('feature.extrude');
    expect(useStore.getState().showExtrudeDialog).toBe(true);
  });

  it('transform.move / transform.rotate / transform.scale open their dialogs with a selected body', () => {
    initBuiltinCommands();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    runCommand('transform.move');
    expect(useStore.getState().moveDialogOpen).toBe(true);
    runCommand('transform.rotate');
    expect(useStore.getState().rotateDialogOpen).toBe(true);
    runCommand('transform.scale');
    expect(useStore.getState().scaleDialogOpen).toBe(true);
  });

  it('pattern.linear seeds pendingPattern for the selected body', () => {
    initBuiltinCommands();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    runCommand('pattern.linear');
    expect(useStore.getState().pendingPattern).toEqual({ bodyId: box.id, mode: 'linear' });
  });
});

describe('workspace shortcut hints (F10)', () => {
  beforeEach(() => clearCommands());

  it('Model workspace is Shift+M; plain M stays Measure', () => {
    initBuiltinCommands();
    // Mirrors initShortcuts: plain M toggles measure, Shift+M jumps to model.
    expect(getCommand('workspace.model')?.shortcut).toBe('Shift+M');
    expect(getCommand('view.measure')?.shortcut).toBe('M');
  });
});

describe('view bookmark commands (palette capture + clear)', () => {
  beforeEach(() => {
    clearCommands();
    localStorage.removeItem('scenelab.viewBookmarks');
    useViewBookmarks.setState({ bookmarks: [] });
  });

  const seedBookmark = () => useViewBookmarks.getState().add({
    position: { x: 1, y: 2, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  });

  it('registers view.bookmarkCurrent / view.clearBookmarks as View commands', () => {
    initBuiltinCommands();
    expect(getCommand('view.bookmarkCurrent')?.category).toBe('View');
    expect(getCommand('view.clearBookmarks')?.category).toBe('View');
    // Deliberately NO per-bookmark restore command: the registry is a static
    // table while the restore list is dynamic (one entry per stored
    // bookmark) — restores live in the viewport's context menu.
    expect(allCommands().filter((c) => /^view\.(goToBookmark|restoreBookmark)/.test(c.id))).toHaveLength(0);
  });

  it('labels come from the shared menu keys and follow a runtime locale switch', () => {
    initBuiltinCommands();
    expect(commandLabel(getCommand('view.bookmarkCurrent')!)).toBe(translations.en!['menu.bookmarkCurrent']!);
    expect(commandLabel(getCommand('view.clearBookmarks')!)).toBe(translations.en!['menu.clearBookmarks']!);
    useStore.setState({ locale: 'zh' });
    try {
      expect(commandLabel(getCommand('view.bookmarkCurrent')!)).toBe(translations.zh!['menu.bookmarkCurrent']!);
      // …and the zh label finds them in fuzzy search without re-registering.
      expect(searchCommands(translations.zh!['menu.bookmarkCurrent']!).map((c) => c.id)).toContain('view.bookmarkCurrent');
    } finally {
      useStore.setState({ locale: 'en' });
    }
  });

  it('view.bookmarkCurrent dispatches scenelab:bookmark-view for the viewport listener', () => {
    initBuiltinCommands();
    const events: CustomEvent[] = [];
    const listener = (e: Event) => { events.push(e as CustomEvent); };
    window.addEventListener('scenelab:bookmark-view', listener);
    try {
      expect(runCommand('view.bookmarkCurrent')).toBe(true);
    } finally {
      window.removeEventListener('scenelab:bookmark-view', listener);
    }
    expect(events).toHaveLength(1);
  });

  it('view.clearBookmarks empties the bookmark store (and its persistence)', () => {
    seedBookmark();
    seedBookmark();
    expect(useViewBookmarks.getState().bookmarks).toHaveLength(2);
    initBuiltinCommands();
    expect(runCommand('view.clearBookmarks')).toBe(true);
    expect(useViewBookmarks.getState().bookmarks).toEqual([]);
    expect(localStorage.getItem('scenelab.viewBookmarks')).toBe('[]');
  });
});
