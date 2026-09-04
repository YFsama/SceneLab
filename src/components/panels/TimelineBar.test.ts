import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createFilletFeature } from '../../lib/features/tree';
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
    for (const key of ['timeline.title', 'timeline.recompute', 'timeline.selectBody']) {
      expect(translations.en![key]).toBeTruthy();
      expect(translations.zh![key]).toBeTruthy();
    }
  });
});
