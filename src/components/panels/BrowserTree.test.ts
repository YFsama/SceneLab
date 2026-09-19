import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { createBox } from '../../lib/geometry/brep';
import { FeatureTree } from '../../lib/features/tree';
import { matchesNameFilter } from '../../lib/treeFilter';

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

describe('browser tree filter (Fusion-style browser search)', () => {
  const reset = () => useStore.setState({
    directBodies: [],
    bodies: [],
    objectIds: [],
    selectedIds: [],
    hiddenIds: [],
    undoStack: [],
    redoStack: [],
    featureTree: new FeatureTree(),
  });
  beforeEach(reset);

  it('blank filter matches everything (zero behaviour change)', () => {
    expect(matchesNameFilter('Box 1', '')).toBe(true);
    expect(matchesNameFilter('Box 1', '   ')).toBe(true);
    expect(matchesNameFilter('', '')).toBe(true);
  });

  it('matches names by case-insensitive substring', () => {
    expect(matchesNameFilter('Mount plate', 'mount')).toBe(true);
    expect(matchesNameFilter('Mount plate', 'PLATE')).toBe(true);
    expect(matchesNameFilter('Mount plate', ' rod ')).toBe(false);
    expect(matchesNameFilter('Bracket', 'qqq')).toBe(false);
  });

  it('filters the store body list the tree renders from', () => {
    const a = createBox(1, 1, 1);
    const b = createBox(2, 2, 2);
    const c = createBox(3, 3, 3);
    useStore.getState().addDirectBodies([a, b, c]);
    useStore.getState().renameBody(a.id, 'Mount plate');
    useStore.getState().renameBody(b.id, 'Bracket');
    useStore.getState().renameBody(c.id, 'Rod');
    const bodies = useStore.getState().bodies;
    // The component derives visible rows exactly this way; the match count
    // next to the input is `${hits}/${total}`.
    const hits = bodies.filter((x) => matchesNameFilter(x.name, 'bra'));
    expect(hits.map((x) => x.name)).toEqual(['Bracket']);
    expect(`${hits.length}/${bodies.length}`).toBe('1/3');
    // Blank query keeps every row.
    expect(bodies.filter((x) => matchesNameFilter(x.name, ''))).toHaveLength(3);
  });

  it('filters the feature history by feature name', () => {
    const tree = new FeatureTree();
    tree.addFeature({ id: 'f1', type: 'fillet', name: 'Fillet 1', suppressed: false, parentIds: [], params: { edgeIds: [], radius: 1 } });
    tree.addFeature({ id: 'f2', type: 'chamfer', name: 'Chamfer 1', suppressed: false, parentIds: [], params: { edgeIds: [], distance: 1 } });
    useStore.setState({ featureTree: tree });
    const features = useStore.getState().featureTree.features;
    expect(features.filter((f) => matchesNameFilter(f.name, 'fil')).map((f) => f.id)).toEqual(['f1']);
    expect(features.filter((f) => matchesNameFilter(f.name, 'CHAM')).map((f) => f.id)).toEqual(['f2']);
    expect(features.filter((f) => matchesNameFilter(f.name, 'loft'))).toHaveLength(0);
    expect(features.filter((f) => matchesNameFilter(f.name, ''))).toHaveLength(2);
  });
});
