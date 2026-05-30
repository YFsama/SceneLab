import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, getCommand, runCommand, searchCommands, allCommands, clearCommands, initBuiltinCommands } from './registry';

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

  it('registers the built-in command set', () => {
    initBuiltinCommands();
    expect(getCommand('edit.undo')).toBeDefined();
    expect(getCommand('create.box')).toBeDefined();
    expect(getCommand('view.iso')).toBeDefined();
    expect(allCommands().length).toBeGreaterThan(10);
  });
});
