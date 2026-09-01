import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature, createSketchFeature } from '../lib/features/tree';
import { createBox, computeVolume } from '../lib/geometry/brep';
import { createSketch, addRectangle, addCircle, addLine } from '../lib/sketch/engine';

describe('modify feature actions', () => {
  beforeEach(() => {
    // Fresh scene state for each test.
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

  describe('direct-body path (undoable edit)', () => {
    it('applyFilletFeature replaces the selected direct body', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      useStore.getState().selectObject(box.id);
      const undoDepth = useStore.getState().undoStack.length;
      expect(useStore.getState().applyFilletFeature(2)).toBe(true);
      const bodies = useStore.getState().bodies;
      expect(bodies).toHaveLength(1);
      // Fillet keeps the original faces and adds arc quads, so the mesh grows.
      expect(bodies[0]!.faces.length).toBeGreaterThan(box.faces.length);
      // Direct edit pushes exactly one new undo entry on top of the insert.
      expect(useStore.getState().undoStack.length).toBe(undoDepth + 1);
    });

    it('applyCircularArrayFeature appends copies of a direct body', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      useStore.getState().selectObject(box.id);
      expect(useStore.getState().applyCircularArrayFeature(4)).toBe(true);
      expect(useStore.getState().bodies.length).toBeGreaterThanOrEqual(4);
    });

    it('applyMirrorFeature with keepOriginal keeps both copies', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      useStore.getState().selectObject(box.id);
      expect(useStore.getState().applyMirrorFeature('xy', true)).toBe(true);
      const bodies = useStore.getState().bodies;
      expect(bodies).toHaveLength(2);
      const total = bodies.reduce((s, b) => s + computeVolume(b), 0);
      expect(total).toBeCloseTo(2 * 1000, 0);
    });

    it('returns false with no selection', () => {
      useStore.getState().addDirectBody(createBox(10, 10, 10));
      expect(useStore.getState().applyFilletFeature(2)).toBe(false);
    });
  });

  it('fillet scopes to the selected edges (Alt+click sub-selection)', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().setSelectedEdgeIds([box.edges[0]!.id]);
    useStore.getState().applyFilletFeature(1);
    const scoped = useStore.getState().bodies.find((b) => b.id === box.id)!;

    const whole = createBox(10, 10, 10);
    useStore.getState().addDirectBody(whole);
    useStore.getState().selectObject(whole.id);
    useStore.getState().setSelectedEdgeIds([]);
    useStore.getState().applyFilletFeature(1);
    const full = useStore.getState().bodies.find((b) => b.id === whole.id)!;

    // Filleting one edge adds far fewer arc faces than filleting every edge.
    expect(scoped.faces.length).toBeLessThan(full.faces.length);
    expect(scoped.faces.length).toBeGreaterThan(box.faces.length);
    // Edge selection is cleared with the body selection.
    useStore.getState().selectObject(whole.id);
    expect(useStore.getState().selectedEdgeIds).toEqual([]);
  });

  describe('parametric path (feature tree)', () => {
    it('applyFilletFeature adds a child feature to a tree body', () => {
      const tree = useStore.getState().featureTree;
      tree.addFeature(createExtrudeFeature(
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
      ));
      tree.recompute();
      useStore.setState({ featureTree: tree });
      useStore.getState().recomputeTree();

      const treeBody = useStore.getState().bodies[0]!;
      useStore.getState().selectObject(treeBody.id);
      const featureCount = useStore.getState().featureTree.features.length;
      expect(useStore.getState().applyFilletFeature(1.5)).toBe(true);

      const tree2 = useStore.getState().featureTree;
      expect(tree2.features).toHaveLength(featureCount + 1);
      const child = tree2.features[tree2.features.length - 1]!;
      expect(child.type).toBe('fillet');
      expect(child.parentIds).toContain(tree.features[0]!.id);
      // Recompute produced the filleted body (more faces than the plain box).
      expect(useStore.getState().bodies[0]!.faces.length).toBeGreaterThan(6);
    });
  });

  it('findFeatureIdForBody resolves tree-produced bodies only', () => {
    const tree = new FeatureTree();
    tree.addFeature(createExtrudeFeature(
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
    ));
    tree.recompute();
    const produced = tree.getLatestBodies()[0]!;
    expect(tree.findFeatureIdForBody(produced.id)).toBe(tree.features[0]!.id);
    expect(tree.findFeatureIdForBody('nope')).toBeUndefined();
  });
});

describe('loft from sketches', () => {
  it('performLoftFromSketches builds a loft over two sketch features', () => {
    useStore.setState({ featureTree: new FeatureTree(), directBodies: [], bodies: [], objectIds: [] });
    const sketchA = createSketch('xy');
    addRectangle(sketchA, -5, -5, 5, 5);
    const sketchB = createSketch('xy');
    addCircle(sketchB, 0, 0, 3);
    const featA = createSketchFeature(sketchA);
    const featB = createSketchFeature(sketchB);
    const tree = useStore.getState().featureTree;
    tree.addFeature(featA);
    tree.addFeature(featB);
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();

    expect(useStore.getState().performLoftFromSketches([featA.id, featB.id])).toBe(true);
    const tree2 = useStore.getState().featureTree;
    const loft = tree2.features[tree2.features.length - 1]!;
    expect(loft.type).toBe('loft');
    expect(loft.parentIds).toEqual([featA.id, featB.id]);
    const result = tree2.getResult(loft.id)!;
    expect(result.error).toBeUndefined();
    expect(result.bodies[0]!.faces.length).toBeGreaterThan(0);
  });

  it('rejects fewer than two sketch ids', () => {
    useStore.setState({ featureTree: new FeatureTree(), directBodies: [], bodies: [], objectIds: [] });
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 5, 5);
    const feat = createSketchFeature(sketch);
    const tree = useStore.getState().featureTree;
    tree.addFeature(feat);
    tree.recompute();
    useStore.setState({ featureTree: tree });
    expect(useStore.getState().performLoftFromSketches([feat.id])).toBe(false);
    expect(useStore.getState().performLoftFromSketches(['nope', 'also-nope'])).toBe(false);
  });
});

describe('sketch corner fillet (store)', () => {
  it('filletSketchCorner applies to the current sketch and is undoable', () => {
    const sketch = createSketch('xy');
    const la = addLine(sketch, 0, 0, 20, 0);
    const lb = addLine(sketch, 0, 0, 0, 20);
    useStore.getState().setCurrentSketch(sketch);
    expect(useStore.getState().filletSketchCorner(la.id, lb.id, 5)).toBe(true);
    const after = useStore.getState().currentSketch!;
    expect([...after.entities.values()].filter((e) => e.type === 'arc')).toHaveLength(1);
    useStore.getState().sketchUndo();
    const restored = useStore.getState().currentSketch!;
    expect([...restored.entities.values()].filter((e) => e.type === 'arc')).toHaveLength(0);
  });

  it('rejects bad input without touching the sketch', () => {
    const sketch = createSketch('xy');
    const la = addLine(sketch, 0, 0, 20, 0);
    const lb = addLine(sketch, 0, 0, 0, 20);
    useStore.getState().setCurrentSketch(sketch);
    expect(useStore.getState().filletSketchCorner(la.id, lb.id, 0)).toBe(false);
    expect(useStore.getState().filletSketchCorner(la.id, 'nope', 3)).toBe(false);
    expect([...useStore.getState().currentSketch!.entities.values()].filter((e) => e.type === 'arc')).toHaveLength(0);
  });
});

describe('feature-tree undo/redo', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
    });
  });

  it('undo reverts a performExtrude feature edit', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performExtrude(10, false);
    expect(useStore.getState().featureTree.features.length).toBe(2);
    expect(useStore.getState().bodies).toHaveLength(1);

    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().featureTree.features.length).toBe(0);
    expect(useStore.getState().bodies).toHaveLength(0);

    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().featureTree.features.length).toBe(2);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(computeVolume(useStore.getState().bodies[0]!)).toBeCloseTo(1000, 0);
  });

  it('undo reverts a parametric fillet added to a tree body', () => {
    // Build a tree body via extrude.
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performExtrude(10, false);
    const treeBody = useStore.getState().bodies[0]!;
    useStore.getState().selectObject(treeBody.id);
    const plainFaces = treeBody.faces.length;

    expect(useStore.getState().applyFilletFeature(1)).toBe(true);
    expect(useStore.getState().featureTree.features.length).toBe(3);
    expect(useStore.getState().bodies[0]!.faces.length).toBeGreaterThan(plainFaces);

    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().featureTree.features.length).toBe(2);
    expect(useStore.getState().bodies[0]!.faces.length).toBe(plainFaces);
  });

  it('undo reverts updateFeature parameter edits', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performExtrude(10, false);
    const extrudeId = useStore.getState().featureTree.features.find((f) => f.type === 'extrude')!.id;
    useStore.getState().updateFeature(extrudeId, (f) =>
      f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 20 } } : f,
    );
    expect(computeVolume(useStore.getState().bodies[0]!)).toBeCloseTo(2000, 0);

    useStore.getState().undo();
    expect(computeVolume(useStore.getState().bodies[0]!)).toBeCloseTo(1000, 0);
  });

  it('undo history interleaves tree and direct-body edits correctly', () => {
    // Direct edit first, then a tree edit — undo peels them in LIFO order.
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().applyFilletFeature(0.5); // direct edit (no tree parent)
    const filleted = useStore.getState().bodies[0]!;

    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 4, 4);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performExtrude(6, false); // tree edit

    expect(useStore.getState().bodies).toHaveLength(2);
    useStore.getState().undo();
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().bodies[0]!.id).toBe(filleted.id);
    useStore.getState().undo();
    expect(useStore.getState().bodies[0]!.id).toBe(box.id);
    expect(useStore.getState().bodies[0]!.faces.length).toBe(box.faces.length);
  });

  it('shell scopes to the Ctrl+click face selection', () => {
    const box = createBox(20, 20, 20);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().setSelectedFaceIds([box.faces[0]!.id]);
    useStore.getState().applyShellFeature(2);
    const shelled = useStore.getState().bodies.find((b) => b.id === box.id)!;
    // The chosen face is removed and bridged to an inward offset: the mesh
    // grows by the inner face + side walls. (An open shell is not watertight,
    // so its signed volume is not a meaningful check — face count is.)
    expect(shelled.faces.length).toBeGreaterThan(box.faces.length);
  });
});
