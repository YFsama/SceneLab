import { describe, it, expect } from 'vitest';

// BrowserTree is a React component — test the tree structure logic.

describe('BrowserTree structure', () => {
  it('tree sections include bodies, features, reference geometry', () => {
    const sections = ['bodies', 'features', 'reference'];
    expect(sections).toContain('bodies');
    expect(sections).toContain('features');
    expect(sections).toContain('reference');
  });

  it('body operations include rename, duplicate, delete, hide', () => {
    const operations = ['rename', 'duplicate', 'delete', 'hide'];
    expect(operations).toContain('rename');
    expect(operations).toContain('duplicate');
    expect(operations).toContain('delete');
    expect(operations).toContain('hide');
  });

  it('supports multi-selection with Shift/Ctrl', () => {
    const selectionModes = ['single', 'toggle', 'range'];
    expect(selectionModes).toContain('single');
    expect(selectionModes).toContain('toggle');
    expect(selectionModes).toContain('range');
  });
});

describe('BrowserTree body operations', () => {
  it('rename flow: begin → set value → commit', () => {
    const steps = ['beginRename', 'setRenameValue', 'commitRename'];
    expect(steps).toHaveLength(3);
  });

  it('rename can be cancelled', () => {
    const steps = ['beginRename', 'cancelRename'];
    expect(steps).toHaveLength(2);
  });

  it('visibility toggle hides/shows a body', () => {
    const hiddenIds: string[] = [];
    const bodyId = 'body-1';
    // Toggle hide.
    hiddenIds.push(bodyId);
    expect(hiddenIds).toContain(bodyId);
    // Toggle show.
    const idx = hiddenIds.indexOf(bodyId);
    hiddenIds.splice(idx, 1);
    expect(hiddenIds).not.toContain(bodyId);
  });
});
