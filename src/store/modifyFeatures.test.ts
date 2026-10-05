import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature, createSketchFeature } from '../lib/features/tree';
import { createBox, computeVolume, computeBoundingBox } from '../lib/geometry/brep';
import { flipBodyNormals } from '../lib/geometry/operations';
import { warmUpBooleanEngine } from '../lib/geometry/boolean';
import { createSketch, addRectangle, addCircle, addLine } from '../lib/sketch/engine';
import type { SolidBody } from '../lib/geometry/types';

const extentAlong = (b: SolidBody, axis: 'x' | 'y' | 'z') => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of b.vertices) {
    min = Math.min(min, v[axis]);
    max = Math.max(max, v[axis]);
  }
  return max - min;
};

/** Sketch+extrude feature tree producing one 10×10×10 parametric body. */
const parametricBox = (): FeatureTree => {
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
  return tree;
};

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

    it('a direct modify edit marks the project dirty', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      useStore.getState().selectObject(box.id);
      useStore.getState().setProjectDirty(false);
      expect(useStore.getState().applyFilletFeature(2)).toBe(true);
      expect(useStore.getState().projectDirty).toBe(true);
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

describe('applyHoleToBody (hole feature action)', () => {
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

  it('adds a parametric hole feature to a tree body (drills from the top face)', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;
    const volBefore = Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(volBefore).toBeCloseTo(1000, 3);

    expect(useStore.getState().applyHoleToBody(bodyId, 4, null)).toBe(true);

    const t2 = useStore.getState().featureTree;
    expect(t2.features).toHaveLength(2);
    const hole = t2.features[1]!;
    expect(hole.type).toBe('hole');
    if (hole.type === 'hole') {
      expect(hole.parentIds).toEqual([t2.features[0]!.id]);
      expect(hole.params.diameter).toBe(4);
      expect(hole.params.depth).toBeNull();
      expect(hole.params.direction).toEqual({ x: 0, y: -1, z: 0 });
      // Default placement: centroid of the 10×10×10 box's top face (y = 10).
      expect(hole.params.center).toEqual({ x: 0, y: 10, z: 0 });
    }
    // Parent consumed — one body out, with the hole volume removed.
    expect(useStore.getState().bodies).toHaveLength(1);
    const volAfter = Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(volAfter).toBeLessThan(volBefore);
    const ideal = Math.PI * 2 * 2 * 10;
    expect(volBefore - volAfter).toBeGreaterThan(ideal * 0.9);
    expect(volBefore - volAfter).toBeLessThan(ideal * 1.1);
  });

  it('drills a direct body with an undoable direct edit', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    const undoDepth = useStore.getState().undoStack.length;

    expect(useStore.getState().applyHoleToBody(box.id, 4, 5)).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeLessThan(1000);
    // Exactly one new undo entry for the direct edit.
    expect(useStore.getState().undoStack.length).toBe(undoDepth + 1);

    useStore.getState().undo();
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
  });

  it('rejects invalid diameters, depths and unknown bodies', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().applyHoleToBody(box.id, 0.1, null)).toBe(false); // diameter must exceed 0.1
    expect(useStore.getState().applyHoleToBody(box.id, -4, null)).toBe(false);
    expect(useStore.getState().applyHoleToBody(box.id, 4, 0)).toBe(false); // depth 0 is not through-all
    expect(useStore.getState().applyHoleToBody(box.id, 4, 0.1)).toBe(false); // depth must exceed 0.1
    expect(useStore.getState().applyHoleToBody('nope', 4, null)).toBe(false);
    // Nothing was drilled — the box is untouched.
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
  });

  it('updateFeature can widen an applied hole with a counterbore (FeatureEditor path)', async () => {
    // Warm the exact boolean engine as the running app does — the voxel
    // fallback compounds error over the second (counterbore) difference.
    await warmUpBooleanEngine();
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;
    expect(useStore.getState().applyHoleToBody(bodyId, 4, null)).toBe(true);

    const volPlain = Math.abs(computeVolume(useStore.getState().bodies[0]!));

    // The FeatureEditor applies parametric edits through updateFeature.
    const holeId = useStore.getState().featureTree.features
      .find((f) => f.type === 'hole')!.id;
    useStore.getState().updateFeature(holeId, (f) =>
      f.type === 'hole'
        ? { ...f, params: { ...f.params, counterbore: { diameter: 8, depth: 2 } } }
        : f,
    );

    const hole = useStore.getState().featureTree.features.find((f) => f.id === holeId)!;
    expect(hole.type === 'hole' && hole.params.counterbore).toEqual({ diameter: 8, depth: 2 });
    // The recompute behind updateFeature removed the counterbore ring as well:
    // extra volume = π(4² − 2²)·2 = 24π ≈ 75.4 (±10% boolean tolerance).
    const volCountersunk = Math.abs(computeVolume(useStore.getState().bodies[0]!));
    const extra = volPlain - volCountersunk;
    expect(extra).toBeGreaterThan(24 * Math.PI * 0.9);
    expect(extra).toBeLessThan(24 * Math.PI * 1.1);
  });

  it('an explicit center overrides the top-face centroid on a tree body', async () => {
    await warmUpBooleanEngine();
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    // Off-centre entry point on the top face (y = 10) of the 10×10×10 box.
    const center = { x: 3, y: 10, z: -2 };
    expect(useStore.getState().applyHoleToBody(bodyId, 4, null, center)).toBe(true);

    const hole = useStore.getState().featureTree.features.find((f) => f.type === 'hole')!;
    expect(hole.type === 'hole' && hole.params.center).toEqual(center);
    expect(hole.type === 'hole' && hole.params.direction).toEqual({ x: 0, y: -1, z: 0 });
    // The opening sits at the given centre, not at the origin centroid.
    const bb = computeBoundingBox(useStore.getState().bodies[0]!);
    expect(bb.max.y).toBeCloseTo(10, 3);
    expect(bb.min.x).toBeCloseTo(-5, 3); // left face untouched
  });

  it('an explicit center overrides the top-face centroid on a direct body', async () => {
    await warmUpBooleanEngine();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    const center = { x: 3, y: 10, z: -2 };
    expect(useStore.getState().applyHoleToBody(box.id, 4, 5, center)).toBe(true);
    // The feature tree stayed empty — a direct edit — and the hole removed
    // roughly the blind cylinder's volume at the off-centre spot.
    expect(useStore.getState().featureTree.features).toHaveLength(0);
    const removed = 1000 - Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(removed).toBeGreaterThan(Math.PI * 4 * 5 * 0.9);
    expect(removed).toBeLessThan(Math.PI * 4 * 5 * 1.1);
  });

  it('omitting the center keeps the top-face-centroid default', async () => {
    await warmUpBooleanEngine();
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;
    expect(useStore.getState().applyHoleToBody(bodyId, 4, null)).toBe(true);
    const hole = useStore.getState().featureTree.features.find((f) => f.type === 'hole')!;
    expect(hole.type === 'hole' && hole.params.center).toEqual({ x: 0, y: 10, z: 0 });
  });

  it('tree body: an explicit direction drills along it, NORMALIZED into the feature params', async () => {
    await warmUpBooleanEngine();
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    // Enter from the +X face (x = 5), drilling inward along −X — the clicked
    // face's INWARD normal, as the viewport passes it (here unnormalized).
    expect(useStore.getState().applyHoleToBody(
      bodyId, 4, null, { x: 5, y: 5, z: 0 }, { x: -2, y: 0, z: 0 },
    )).toBe(true);

    const hole = useStore.getState().featureTree.features.find((f) => f.type === 'hole')!;
    expect(hole.type === 'hole' && hole.params.direction).toEqual({ x: -1, y: 0, z: 0 }); // unit
    expect(hole.type === 'hole' && hole.params.center).toEqual({ x: 5, y: 5, z: 0 });
    // Through hole along X: removed ≈ π·2²·10.
    const removed = 1000 - Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(removed).toBeGreaterThan(Math.PI * 4 * 10 * 0.9);
    expect(removed).toBeLessThan(Math.PI * 4 * 10 * 1.1);
  });

  it('direct body: the explicit direction drives the direct drill (undoable)', async () => {
    await warmUpBooleanEngine();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    const undoDepth = useStore.getState().undoStack.length;

    // Blind hole entering the +X face (x = 5) along its inward normal (−X),
    // 5 mm deep. The default −Y axis would only graze this off-axis entry
    // point, so the removed volume proves the direction was honoured.
    expect(useStore.getState().applyHoleToBody(
      box.id, 4, 5, { x: 5, y: 5, z: 0 }, { x: -1, y: 0, z: 0 },
    )).toBe(true);

    // Direct edit: no feature landed, one undo entry, ~π·4·5 removed.
    expect(useStore.getState().featureTree.features).toHaveLength(0);
    expect(useStore.getState().undoStack.length).toBe(undoDepth + 1);
    const removed = 1000 - Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(removed).toBeGreaterThan(Math.PI * 4 * 5 * 0.9);
    expect(removed).toBeLessThan(Math.PI * 4 * 5 * 1.1);
  });

  it('omitting the direction keeps the straight-down (−Y) default on a tree body', async () => {
    await warmUpBooleanEngine();
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    expect(useStore.getState().applyHoleToBody(bodyId, 4, null, { x: 0, y: 10, z: 0 })).toBe(true);
    const hole = useStore.getState().featureTree.features.find((f) => f.type === 'hole')!;
    expect(hole.type === 'hole' && hole.params.direction).toEqual({ x: 0, y: -1, z: 0 });
  });

  it('a zero-length direction is refused without drilling', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().applyHoleToBody(box.id, 4, null, undefined, { x: 0, y: 0, z: 0 })).toBe(false);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
  });

  it('a hole that does not reach a TREE body rolls the feature back and toasts holeMissed', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    await warmUpBooleanEngine();
    const tree = parametricBox(); // 10×10×10, top face at y = 10
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;
    const undoDepth = useStore.getState().undoStack.length;
    clearToasts();

    // Blind hole starting 20 mm above the box: the 5 mm cutter spans
    // y 25..30 and never touches the body (y 0..10).
    expect(useStore.getState().applyHoleToBody(bodyId, 4, 5, { x: 0, y: 30, z: 0 })).toBe(false);
    // The failed attempt left no trace: no hole feature, no undo entry, the
    // body un-drilled — and the user was told why.
    expect(useStore.getState().featureTree.features).toHaveLength(1);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
    expect(getToasts().at(-1)!.message).toContain('did not reach the body');
  });

  it('a hole that does not reach a DIRECT body mutates nothing and toasts holeMissed', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    await warmUpBooleanEngine();
    const box = createBox(10, 10, 10); // spans y -5..5
    useStore.getState().addDirectBody(box);
    const undoDepth = useStore.getState().undoStack.length;
    useStore.setState({ projectDirty: false });
    clearToasts();

    expect(useStore.getState().applyHoleToBody(box.id, 4, 5, { x: 0, y: 30, z: 0 })).toBe(false);
    expect(useStore.getState().featureTree.features).toHaveLength(0);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
    expect(useStore.getState().projectDirty).toBe(false);
    expect(getToasts().at(-1)!.message).toContain('did not reach the body');
  });

  it('a flipped-normal body turns the default blind hole into a miss: refused, toasted, untouched', async () => {
    // topFaceHolePlacement picks faces by normal: after flipBodyNormals the
    // geometric BOTTOM face is the one whose normal points up, so the default
    // blind drill starts there and points AWAY from the material — a true
    // miss the probe must report instead of a fake success.
    const { clearToasts, getToasts } = await import('../lib/toast');
    await warmUpBooleanEngine();
    const box = flipBodyNormals(createBox(10, 10, 10));
    useStore.getState().addDirectBody(box);
    const undoDepth = useStore.getState().undoStack.length;
    useStore.setState({ projectDirty: false });
    clearToasts();

    expect(useStore.getState().applyHoleToBody(box.id, 4, 5)).toBe(false);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
    expect(useStore.getState().projectDirty).toBe(false);
    expect(getToasts().at(-1)!.message).toContain('did not reach the body');
  });

  it('the probe does not over-reject flipped-normal bodies: an on-surface entry still drills', async () => {
    await warmUpBooleanEngine();
    const box = flipBodyNormals(createBox(10, 10, 10));
    useStore.getState().addDirectBody(box);
    // Explicit entry ON the real top face (y = 5): the mesh is inside-out but
    // the geometry is real, so the probe passes and the hole is drilled.
    expect(useStore.getState().applyHoleToBody(box.id, 4, 5, { x: 0, y: 5, z: 0 })).toBe(true);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeLessThan(1000);
  });
});

describe('updateFeature fillet/chamfer size gate (param edits)', () => {
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

  /** Parametric 10×10×10 tree body with a fillet (r1) child feature, selected. */
  const setup = (): { filletId: string; undoDepth: number; faces: number } => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    useStore.getState().selectObject(useStore.getState().bodies[0]!.id);
    expect(useStore.getState().applyFilletFeature(1)).toBe(true); // limit is 5
    const filletId = useStore.getState().featureTree.features
      .find((f) => f.type === 'fillet')!.id;
    return {
      filletId,
      undoDepth: useStore.getState().undoStack.length,
      faces: useStore.getState().bodies[0]!.faces.length,
    };
  };

  it('refuses an oversize radius edit with the limit toast and no mutation', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    const { filletId, undoDepth, faces } = setup();
    clearToasts();

    // The ParametersPanel / AI update_feature path: editing the EXISTING
    // fillet's radius past the geometric limit (5 on a 10 mm box) must be
    // refused exactly like an oversize apply.
    expect(useStore.getState().updateFeature(filletId, (f) =>
      f.type === 'fillet' ? { ...f, params: { ...f.params, radius: 50 } } : f,
    )).toBe(false);
    const feat = useStore.getState().featureTree.getFeature(filletId)!;
    expect(feat.type === 'fillet' && feat.params.radius).toBe(1);
    // Refused = nothing happened: same body, no history entry.
    expect(useStore.getState().bodies[0]!.faces.length).toBe(faces);
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
    expect(getToasts().at(-1)!.message).toContain('max 5 mm');
  });

  it('an in-limit radius edit applies through the same path', () => {
    const { filletId } = setup();
    expect(useStore.getState().updateFeature(filletId, (f) =>
      f.type === 'fillet' ? { ...f, params: { ...f.params, radius: 2 } } : f,
    )).toBe(true);
    const feat = useStore.getState().featureTree.getFeature(filletId)!;
    expect(feat.type === 'fillet' && feat.params.radius).toBe(2);
    // The recompute behind the edit re-played the fillet at the new radius.
    expect(useStore.getState().bodies[0]!.faces.length).toBeGreaterThan(6);
  });

  it('refuses an oversize chamfer distance edit the same way', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    useStore.getState().selectObject(useStore.getState().bodies[0]!.id);
    expect(useStore.getState().applyChamferFeature(1)).toBe(true); // limit is 5
    const chamferId = useStore.getState().featureTree.features
      .find((f) => f.type === 'chamfer')!.id;
    const undoDepth = useStore.getState().undoStack.length;
    clearToasts();

    expect(useStore.getState().updateFeature(chamferId, (f) =>
      f.type === 'chamfer' ? { ...f, params: { ...f.params, distance: 50 } } : f,
    )).toBe(false);
    const feat = useStore.getState().featureTree.getFeature(chamferId)!;
    expect(feat.type === 'chamfer' && feat.params.distance).toBe(1);
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
    expect(getToasts().at(-1)!.message).toContain('max 5 mm');
  });

  it('edits that do not touch the gated value are not held hostage', () => {
    const { filletId } = setup();
    // Suppress and rename leave radius/edgeIds alone — the gate must not
    // refuse them even if a legacy feature were over the limit.
    expect(useStore.getState().updateFeature(filletId, (f) => ({ ...f, suppressed: true }))).toBe(true);
    expect(useStore.getState().featureTree.getFeature(filletId)!.suppressed).toBe(true);
    expect(useStore.getState().updateFeature(filletId, (f) => ({ ...f, name: 'Edge blend' }))).toBe(true);
    expect(useStore.getState().featureTree.getFeature(filletId)!.name).toBe('Edge blend');
  });

  it('a missing feature id is a plain false (no junk undo entry)', () => {
    const before = useStore.getState().undoStack.length;
    expect(useStore.getState().updateFeature('nope', (f) => f)).toBe(false);
    expect(useStore.getState().undoStack.length).toBe(before);
  });
});

describe('setDimensionTarget (editable drawing dimensions)', () => {  beforeEach(() => {
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

  it('resizes a direct body along one axis, leaving the others alone', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().setDimensionTarget({ bodyId: box.id, axis: 'x' }, 25)).toBe(true);
    const body = useStore.getState().bodies[0]!;
    expect(extentAlong(body, 'x')).toBeCloseTo(25, 3);
    expect(extentAlong(body, 'y')).toBeCloseTo(10, 3);
    expect(extentAlong(body, 'z')).toBeCloseTo(10, 3);
  });

  it('a direct resize marks the project dirty', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().setProjectDirty(false);
    expect(useStore.getState().setDimensionTarget({ bodyId: box.id, axis: 'x' }, 25)).toBe(true);
    expect(useStore.getState().projectDirty).toBe(true);
  });

  it('a parametric dimension edit bumps featureVersion so panels re-render', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    const v0 = useStore.getState().featureVersion;
    expect(useStore.getState().setDimensionTarget({ bodyId, axis: 'y' }, 25)).toBe(true);
    expect(useStore.getState().featureVersion).toBe(v0 + 1);

    // Repeated edits of the same dimension bump again (updateFeature path).
    const bodyId2 = useStore.getState().bodies[0]!.id; // id changed by the scale
    expect(useStore.getState().setDimensionTarget({ bodyId: bodyId2, axis: 'y' }, 40)).toBe(true);
    expect(useStore.getState().featureVersion).toBe(v0 + 2);
  });

  it('direct resize is undoable', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().setDimensionTarget({ bodyId: box.id, axis: 'x' }, 25);
    useStore.getState().undo();
    expect(extentAlong(useStore.getState().bodies[0]!, 'x')).toBeCloseTo(10, 3);
  });

  it('rejects invalid values and unknown bodies', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().setDimensionTarget({ bodyId: box.id, axis: 'x' }, 0)).toBe(false);
    expect(useStore.getState().setDimensionTarget({ bodyId: box.id, axis: 'x' }, -5)).toBe(false);
    expect(useStore.getState().setDimensionTarget({ bodyId: 'nope', axis: 'x' }, 5)).toBe(false);
  });

  it('adds a driving scale feature to a tree body', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    expect(useStore.getState().setDimensionTarget({ bodyId, axis: 'y' }, 25)).toBe(true);
    const t2 = useStore.getState().featureTree;
    expect(t2.features).toHaveLength(2);
    const scale = t2.features[1]!;
    expect(scale.type).toBe('scale');
    if (scale.type === 'scale') {
      expect(scale.params).toEqual({ axis: 'y', target: 25 });
      expect(scale.parentIds).toEqual([t2.features[0]!.id]);
    }
    expect(extentAlong(useStore.getState().bodies[0]!, 'y')).toBeCloseTo(25, 3);
  });

  it('repeated edits update the same scale feature instead of stacking', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    useStore.getState().setDimensionTarget({ bodyId, axis: 'y' }, 25);
    const bodyId2 = useStore.getState().bodies[0]!.id; // body id changed by the scale
    useStore.getState().setDimensionTarget({ bodyId: bodyId2, axis: 'y' }, 40);

    const t2 = useStore.getState().featureTree;
    expect(t2.features.filter((f) => f.type === 'scale')).toHaveLength(1);
    const scale = t2.features[1]!;
    if (scale.type === 'scale') expect(scale.params.target).toBe(40);
    expect(extentAlong(useStore.getState().bodies[0]!, 'y')).toBeCloseTo(40, 3);
  });

  it('the scale feature is driving: upstream changes are re-fitted to the target', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;
    useStore.getState().setDimensionTarget({ bodyId, axis: 'y' }, 25);

    // Widen the underlying extrude: the scale feature must re-fit to 25.
    useStore.getState().updateFeature(tree.features[0]!.id, (f) =>
      f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 20 } } : f,
    );
    useStore.getState().recomputeTree();
    expect(extentAlong(useStore.getState().bodies[0]!, 'y')).toBeCloseTo(25, 3);
  });

  it('parametric dimension edits are undoable as a unit', () => {
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const bodyId = useStore.getState().bodies[0]!.id;

    useStore.getState().setDimensionTarget({ bodyId, axis: 'y' }, 25);
    useStore.getState().undo();
    const t = useStore.getState().featureTree;
    expect(t.features.filter((f) => f.type === 'scale')).toHaveLength(0);
    expect(extentAlong(useStore.getState().bodies[0]!, 'y')).toBeCloseTo(10, 3);
  });
});

describe('viewport drag-move (bodyDragging lifecycle)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      bodyDragging: false,
      dragMovedThisDrag: false,
    });
  });

  const xOf = (): number => {
    const b = useStore.getState().bodies[0]!;
    return b.vertices.reduce((m, v) => Math.min(m, v.x), Infinity);
  };

  it('a drag previews via dragOffset, bakes on release with one undo entry, keeps ids', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    const undoBefore = useStore.getState().undoStack.length;

    useStore.getState().beginSelectionDrag();
    expect(useStore.getState().bodyDragging).toBe(true);
    const bodyBefore = useStore.getState().directBodies[0]!;
    // Several silent deltas — like mousemove frames — accumulate into the
    // preview offset; geometry itself is untouched until release (the viewport
    // shows the motion as a mesh transform, no per-frame rebuilds).
    expect(useStore.getState().dragSelectionBy(2, 0, 0)).toBe(1);
    expect(useStore.getState().dragSelectionBy(3, 0, 0)).toBe(1);
    // Same body object → the viewport mesh cache hits; only the release bake
    // (one translate) creates new geometry.
    expect(useStore.getState().directBodies[0]).toBe(bodyBefore);
    expect(useStore.getState().bodies[0]!.id).toBe(box.id);
    expect(useStore.getState().dragOffset).toEqual({ x: 5, y: 0, z: 0 });
    expect(xOf()).toBeCloseTo(-5, 3); // still at rest — nothing baked yet
    expect(useStore.getState().undoStack.length).toBe(undoBefore); // no mid-drag entries
    useStore.getState().endSelectionDrag();
    expect(useStore.getState().bodyDragging).toBe(false);
    expect(useStore.getState().dragOffset).toBeNull();
    expect(xOf()).toBeCloseTo(0, 3); // box spans -5..5 → moved +5, baked once
    // Exactly one history entry for the whole drag.
    expect(useStore.getState().undoStack.length).toBe(undoBefore + 1);

    // One undo restores the pre-drag position.
    useStore.getState().undo();
    expect(xOf()).toBeCloseTo(-5, 3);
  });

  it('a press without motion is a click: the empty snapshot is dropped', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    const undoBefore = useStore.getState().undoStack.length;

    useStore.getState().beginSelectionDrag();
    useStore.getState().endSelectionDrag();
    expect(useStore.getState().undoStack.length).toBe(undoBefore);
    // Undo still steps to the pre-insert state, not a no-op.
    useStore.getState().undo();
    expect(useStore.getState().bodies).toHaveLength(0);
  });

  it('Esc mid-drag (cancelSelectionDrag) restores the pre-drag state', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().beginSelectionDrag();
    useStore.getState().dragSelectionBy(7, 0, 0);
    // Preview only — vertices never moved, so cancel just drops the offset.
    expect(useStore.getState().dragOffset).toEqual({ x: 7, y: 0, z: 0 });
    expect(xOf()).toBeCloseTo(-5, 3);
    useStore.getState().cancelSelectionDrag();
    expect(useStore.getState().bodyDragging).toBe(false);
    expect(useStore.getState().dragOffset).toBeNull();
    expect(xOf()).toBeCloseTo(-5, 3);
  });

  it('dragSelectionBy is inert outside a drag; feature-only selections move nothing', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().dragSelectionBy(5, 0, 0)).toBe(0);
    expect(xOf()).toBeCloseTo(-5, 3);
    expect(useStore.getState().undoStack).toHaveLength(useStore.getState().undoStack.length);

    // Tree-produced body: a drag starts but the first motion reports 0 moves
    // (nothing direct selected) so the viewport stops the drag.
    const tree = parametricBox();
    tree.recompute();
    useStore.setState({ featureTree: tree });
    useStore.getState().recomputeTree();
    const paramId = useStore.getState().bodies[0]!.id;
    useStore.getState().selectObject(paramId);
    useStore.getState().beginSelectionDrag();
    expect(useStore.getState().dragSelectionBy(5, 0, 0)).toBe(0);
    useStore.getState().endSelectionDrag();
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

  it('bumps featureVersion so the timeline re-renders', () => {
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

    const v0 = useStore.getState().featureVersion;
    expect(useStore.getState().performLoftFromSketches([featA.id, featB.id])).toBe(true);
    expect(useStore.getState().featureVersion).toBe(v0 + 1);
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

  it('fillet/chamfer refuse oversize values with the limit toast and no mutation', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    clearToasts();
    const box = createBox(20, 20, 20);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.setState({ projectDirty: false, undoStack: [] });

    // A 50 mm fillet on a 20 mm box would mangle the body (audit F8).
    expect(useStore.getState().applyFilletFeature(50)).toBe(false);
    expect(getToasts().at(-1)!.message).toContain('max 10 mm');
    // Refused = nothing happened: same body, no history, not dirty.
    expect(useStore.getState().bodies[0]!.faces.length).toBe(box.faces.length);
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(useStore.getState().projectDirty).toBe(false);

    // In-limit values still apply (faces grow as before).
    expect(useStore.getState().applyFilletFeature(2)).toBe(true);
    expect(useStore.getState().bodies[0]!.faces.length).toBeGreaterThan(box.faces.length);

    // Chamfer on a FRESH box (the filleted body's edges are no longer
    // chamferable — all skipped — which the guard also refuses).
    clearToasts();
    const box2 = createBox(20, 20, 20);
    useStore.getState().addDirectBody(box2);
    useStore.getState().selectObject(box2.id);
    expect(useStore.getState().applyChamferFeature(50)).toBe(false);
    expect(getToasts().at(-1)!.message).toContain('max 10 mm');
    expect(useStore.getState().bodies.find((b) => b.id === box2.id)!.faces.length).toBe(box2.faces.length);
  });

  it('an all-edges-skipped selection refuses with a clear refusal and no mutation', async () => {
    const { clearToasts, getToasts } = await import('../lib/toast');
    // Since the fillet became a CLOSED shell (pass #30), the filleted body's
    // arc surface has facet-to-facet edges (11.25° dihedral, tiny faces) —
    // exactly like any tessellated cylinder. Chamfering them is refused with
    // an honest tiny maximum ("max 0.05 mm"), which replaced the old "no
    // filletable edges" message: there ARE edges, they are just uselessly
    // small. Both are refusals; what matters is nothing mutates.
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().applyFilletFeature(1)).toBe(true); // arc edges exist now
    useStore.setState({ undoStack: [] });
    clearToasts();

    expect(useStore.getState().applyChamferFeature(1)).toBe(false);
    const msgC = getToasts().at(-1)!.message;
    expect(msgC.includes('No filletable edges') || /max 0?\.\d+ mm/.test(msgC)).toBe(true);
    clearToasts();
    expect(useStore.getState().applyFilletFeature(1)).toBe(false);
    const msgF = getToasts().at(-1)!.message;
    expect(msgF.includes('No filletable edges') || /max 0?\.\d+ mm/.test(msgF)).toBe(true);
    // Refused: the filleted body is untouched and no history entry landed.
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(useStore.getState().bodies[0]!.faces.length).toBeGreaterThan(box.faces.length);
  });
});
