import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { FeatureTree } from '../../lib/features/tree';
import { createBox } from '../../lib/geometry/brep';

// Real coverage for the store-driven numeric prompt that replaced every
// window.prompt in the context menus.
describe('numeric prompt state', () => {
  beforeEach(() => {
    useStore.setState({ numericPrompt: null });
  });

  it('opens with a payload and closes', () => {
    useStore.getState().openNumericPrompt({
      titleKey: 'feature.fillet',
      labelKey: 'feature.filletPrompt',
      initial: 2,
      min: 0.01,
      onApply: () => {},
    });
    const p = useStore.getState().numericPrompt;
    expect(p).not.toBeNull();
    expect(p!.titleKey).toBe('feature.fillet');
    expect(p!.min).toBe(0.01);
    useStore.getState().closeNumericPrompt();
    expect(useStore.getState().numericPrompt).toBeNull();
  });

  it('a real flow: prompt value drives a fillet on a direct body', () => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      undoStack: [],
      selectedIds: [],
    });
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);

    let applied = 0;
    useStore.getState().openNumericPrompt({
      titleKey: 'feature.fillet',
      labelKey: 'feature.filletPrompt',
      initial: 1.5,
      min: 0.01,
      onApply: (v) => {
        applied = v;
        useStore.getState().applyFilletFeature(v);
      },
    });
    const p = useStore.getState().numericPrompt!;
    // Simulate the dialog's Apply button: close, then run the callback.
    useStore.getState().closeNumericPrompt();
    p.onApply(1.5);

    expect(applied).toBe(1.5);
    const body = useStore.getState().bodies.find((b) => b.id === box.id)!;
    expect(body.faces.length).toBeGreaterThan(box.faces.length);
  });
});
