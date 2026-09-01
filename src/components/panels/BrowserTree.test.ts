import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry/brep';

// Real coverage for the operations the BrowserTree drives (rename, visibility,
// duplicate, reorder) through the store — the component itself is rendering
// only. Previously this file asserted locally-declared string arrays.

describe('browser tree body operations (store-backed)', () => {
  beforeEach(() => {
    useStore.setState({
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      hiddenIds: [],
      undoStack: [],
      redoStack: [],
      featureTree: useStore.getState().featureTree,
    });
  });

  it('renameBody renames and rejects empty/missing/same names', () => {
    const a = createBox(2, 2, 2);
    useStore.getState().addDirectBody(a);
    expect(useStore.getState().renameBody(a.id, 'PartA')).toBe(true);
    expect(useStore.getState().bodies.find((x) => x.id === a.id)!.name).toBe('PartA');
    // No-op rename (same name) and missing body are refused; blank names too.
    expect(useStore.getState().renameBody(a.id, 'PartA')).toBe(false);
    expect(useStore.getState().renameBody(a.id, '   ')).toBe(false);
    expect(useStore.getState().renameBody('nope', 'X')).toBe(false);
  });

  it('toggleBodyVisibility hides and shows a body', () => {
    const a = createBox(2, 2, 2);
    useStore.getState().addDirectBody(a);
    useStore.getState().toggleBodyVisibility(a.id);
    expect(useStore.getState().hiddenIds).toContain(a.id);
    useStore.getState().toggleBodyVisibility(a.id);
    expect(useStore.getState().hiddenIds).not.toContain(a.id);
  });

  it('duplicateSelected clones the selection with distinct ids', () => {
    const a = createBox(4, 4, 4);
    useStore.getState().addDirectBody(a);
    useStore.getState().selectObject(a.id);
    const newIds = useStore.getState().duplicateSelected();
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).not.toBe(a.id);
    expect(useStore.getState().bodies).toHaveLength(2);
  });

  it('reorderBody moves a body within the direct-body order', () => {
    const a = createBox(1, 1, 1);
    const b = createBox(2, 2, 2);
    useStore.getState().addDirectBodies([a, b]);
    expect(useStore.getState().reorderBody(b.id, 'up')).toBe(true);
    expect(useStore.getState().bodies[0]!.id).toBe(b.id);
    // Already at the top — a no-op move reports false.
    expect(useStore.getState().reorderBody(b.id, 'up')).toBe(false);
  });
});
