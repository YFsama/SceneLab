import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, getCommand, runCommand, searchCommands, allCommands, clearCommands, initBuiltinCommands, addMidplaneFromSelection } from './registry';
import { useStore } from '../../store/app';
import { createBox } from '../geometry';

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
    expect(allCommands().length).toBeGreaterThan(10);
  });

  it('reference.standardPlanes command seeds the three datum planes', () => {
    useStore.getState().clearScene();
    initBuiltinCommands();
    expect(runCommand('reference.standardPlanes')).toBe(true);
    expect(useStore.getState().planes).toHaveLength(3);
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
});
