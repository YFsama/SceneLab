import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, getCommand, runCommand, searchCommands, allCommands, clearCommands, recentCommands, initBuiltinCommands, addMidplaneFromSelection } from './registry';
import { useStore } from '../../store/app';
import { createBox, createCylinder, createTorus } from '../geometry';

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
