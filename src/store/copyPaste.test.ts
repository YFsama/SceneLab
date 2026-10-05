import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature } from '../lib/features/tree';
import { createBox, computeBoundingBox } from '../lib/geometry/brep';

// F9 — copy/paste of feature-tree bodies. copySelected used to filter
// directBodies only, so a tree-body selection copied NOTHING and
// paste/paste-in-place silently no-op'd. Tree bodies now bake into the
// clipboard as deep snapshots (fresh id, original name), so the pasted copy
// is a plain direct body — decoupled from the tree and editable directly.

const yExtent = (bodyId: string): number => {
  const body = useStore.getState().bodies.find((b) => b.id === bodyId)!;
  const bb = computeBoundingBox(body);
  return bb.max.y - bb.min.y;
};

/** Seed the store with one parametric tree body (10×10×10 extrude). */
const seedTreeBody = (): { extId: string; bodyId: string } => {
  const tree = new FeatureTree();
  const ext = createExtrudeFeature(
    {
      profile: [
        { x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 },
        { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 },
      ],
      direction: { x: 0, y: 1, z: 0 },
      distance: 10,
      symmetric: false,
    },
    [],
  );
  tree.addFeature(ext);
  tree.recompute();
  useStore.setState({ featureTree: tree });
  useStore.getState().recomputeTree();
  return { extId: ext.id, bodyId: useStore.getState().bodies[0]!.id };
};

describe('copy/paste of tree bodies (F9)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(), directBodies: [], bodies: [], objectIds: [],
      selectedIds: [], clipboard: [], pasteCount: 0,
      undoStack: [], redoStack: [],
    });
  });

  it('copying a tree body then pasting bakes it as a direct body', () => {
    const { bodyId } = seedTreeBody();
    useStore.getState().selectObject(bodyId);
    expect(useStore.getState().copySelected()).toBe(1); // was 0 — the silent no-op

    const pasted = useStore.getState().paste();
    expect(pasted).toHaveLength(1);
    const copy = useStore.getState().bodies.find((b) => b.id === pasted[0])!;
    expect(copy).toBeDefined();
    // The copy is a direct body: fresh id, ' copy' name, never an alias of
    // the tree's result object.
    expect(copy.id).not.toBe(bodyId);
    expect(copy.name).toContain('copy');
    expect(useStore.getState().directBodies.map((b) => b.id)).toContain(pasted[0]);
    // The tree body itself is untouched — still one parametric body + one copy.
    expect(useStore.getState().bodies).toHaveLength(2);
  });

  it('paste-in-place lands the copy at the original position', () => {
    const { bodyId } = seedTreeBody();
    useStore.getState().selectObject(bodyId);
    useStore.getState().copySelected();
    const pasted = useStore.getState().pasteInPlace();
    expect(pasted).toHaveLength(1);
    const a = computeBoundingBox(useStore.getState().bodies.find((b) => b.id === bodyId)!);
    const b = computeBoundingBox(useStore.getState().bodies.find((x) => x.id === pasted[0])!);
    expect(b.min.x).toBeCloseTo(a.min.x, 6);
    expect(b.min.y).toBeCloseTo(a.min.y, 6);
    expect(b.min.z).toBeCloseTo(a.min.z, 6);
    expect(b.max.x).toBeCloseTo(a.max.x, 6);
    expect(b.max.y).toBeCloseTo(a.max.y, 6);
    expect(b.max.z).toBeCloseTo(a.max.z, 6);
  });

  it('the baked copy reflects copy-time geometry, not later tree edits', () => {
    const { extId, bodyId } = seedTreeBody();
    useStore.getState().selectObject(bodyId);
    useStore.getState().copySelected(); // snapshot at distance 10

    useStore.getState().updateFeature(
      extId,
      (f) => (f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 6 } } : f),
    );
    const [pasted] = useStore.getState().paste()!;
    expect(yExtent(pasted!)).toBeCloseTo(10, 3); // baked BEFORE the edit
    expect(yExtent(useStore.getState().bodies.find((b) => b.id !== pasted)!.id)).toBeCloseTo(6, 3);
  });

  it('mixed selection copies direct and tree bodies together', () => {
    const { bodyId } = seedTreeBody();
    const box = createBox(4, 4, 4);
    useStore.getState().addDirectBody(box);
    useStore.setState({ selectedIds: [bodyId, box.id] });
    expect(useStore.getState().copySelected()).toBe(2);
    const pasted = useStore.getState().paste();
    expect(pasted).toHaveLength(2);
    // Tree body + direct body + two baked copies.
    expect(useStore.getState().bodies).toHaveLength(4);
  });

  it('direct-body copy/paste keeps its reference semantics (regression)', () => {
    const box = createBox(4, 4, 4);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().copySelected()).toBe(1);
    const pasted = useStore.getState().paste();
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).not.toBe(box.id);
    expect(useStore.getState().bodies).toHaveLength(2);
  });
});
