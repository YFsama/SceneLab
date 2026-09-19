import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createFilletFeature, canReorderFeatures } from '../../lib/features/tree';
import { createSketch, addRectangle } from '../../lib/sketch/engine';
import { translations } from '../../lib/i18n';
import type { FeatureType } from '../../lib/features/types';

// TimelineBar renders featureTree.features as chips; clicking a chip selects
// the body that feature produced. Here we cover the data it renders from and
// the click target it computes, in the store-driven style of the other panel
// tests.

const ALL_TYPES: FeatureType[] = [
  'sketch', 'extrude', 'revolve', 'sweep', 'loft', 'fillet', 'chamfer', 'shell',
  'scale', 'linearArray', 'circularArray', 'mirror',
];

describe('TimelineBar', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });
  });

  it('renders nothing without features (store keeps an empty feature list)', () => {
    expect(useStore.getState().featureTree.features).toHaveLength(0);
  });

  it('a chip click can resolve the produced body through the tree', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const st = useStore.getState();
    st.addFeature(sf);
    st.addFeature(createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 8, symmetric: false },
      [sf.id],
    ));
    st.addFeature(createFilletFeature([], 2, [sf.id]));

    const tree = useStore.getState().featureTree;
    expect(tree.features).toHaveLength(3);

    // The timeline's click target: the first body of each feature's result.
    const extrude = tree.features.find((f) => f.type === 'extrude')!;
    const target = tree.getResult(extrude.id)?.bodies[0]?.id;
    expect(target).toBeTruthy();
    st.selectObject(target!);
    expect(useStore.getState().selectedIds).toContain(target);
  });

  it('every feature type has a chip label in both locales', () => {
    for (const type of ALL_TYPES) {
      expect(translations.en![`feature.${type}`], `en missing feature.${type}`).toBeTruthy();
      expect(translations.zh![`feature.${type}`], `zh missing feature.${type}`).toBeTruthy();
    }
  });

  it('timeline UI keys exist in both locales', () => {
    for (const key of ['timeline.title', 'timeline.recompute', 'timeline.selectBody', 'timeline.reorderDenied', 'timeline.dragHint']) {
      expect(translations.en![key]).toBeTruthy();
      expect(translations.zh![key]).toBeTruthy();
    }
  });

  it('a drag reorder through the store reorders, recomputes and undoes', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const st = useStore.getState();
    st.addFeature(sf);
    st.addFeature(createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 8, symmetric: false },
      [sf.id],
    ));
    // Independent tail feature that can legally move to the front.
    const tail = createExtrudeFeature(
      { profile: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, { x: 0, y: 0, z: 4 }], direction: { x: 0, y: 1, z: 0 }, distance: 5, symmetric: false },
      [],
    );
    st.addFeature(tail);

    const order = () => useStore.getState().featureTree.features.map((f) => f.id);
    expect(order()).toHaveLength(3);
    expect(useStore.getState().bodies).toHaveLength(2);

    // The drop target the timeline computes for the tail chip (index 2 → 0).
    expect(canReorderFeatures(useStore.getState().featureTree.features, tail.id, 0)).toBe(true);
    expect(useStore.getState().moveFeature(tail.id, 0)).toBe(true);
    expect(order()).toEqual([tail.id, sf.id, order()[2]]);
    expect(useStore.getState().bodies).toHaveLength(2); // still two solid bodies after recompute

    // One Ctrl+Z puts the chips back in build order.
    useStore.getState().undo();
    expect(order()).toEqual([sf.id, order()[1], tail.id]);
  });

  it('a dependency-violating drop is denied and pushes no undo entry', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const st = useStore.getState();
    st.addFeature(sf);
    const ext = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 8, symmetric: false },
      [sf.id],
    );
    st.addFeature(ext);
    useStore.setState({ undoStack: [], redoStack: [] });

    const order = () => useStore.getState().featureTree.features.map((f) => f.id);
    const before = order();
    // Dropping the extrude before its parent sketch is not a legal target.
    expect(canReorderFeatures(useStore.getState().featureTree.features, ext.id, 0)).toBe(false);
    expect(useStore.getState().moveFeature(ext.id, 0)).toBe(false);
    expect(order()).toEqual(before);
    expect(useStore.getState().undoStack).toHaveLength(0); // no no-op snapshot left behind
  });
});
