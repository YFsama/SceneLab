import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature } from '../lib/features/tree';
import { defaultCamSetup } from '../lib/cam';
import { createBox } from '../lib/geometry/brep';
import type { CAMOperation } from '../lib/cam';

// F3 — stable identity for CAM operations that target feature-tree bodies.
// Tree recompute mints fresh body ids on every upstream parametric edit, so
// an op holding only the exact body id dangles forever after one edit:
// Regenerate could not recover it and the G-code export silently omitted it
// (QA repro: cut distance 10→6 killed a pocket op; export had 2 sections,
// not 3). The store now captures the producing FEATURE id on the op at
// add/retarget time and resolves exact-id-first, feature-second, repointing
// the op inside the no-undo regenerate.

const params = {
  feedRate: 1000, plungeRate: 300, spindleSpeed: 10000,
  depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -10,
};

/** The stable-identity binding the store hides on the op (BoundCamOperation). */
const bindingOf = (op: CAMOperation): string | undefined =>
  (op as { bodyFeatureId?: string }).bodyFeatureId;

/** A sketch-less extrude feature producing one 10×10×distance parametric body. */
const parametricExtrude = (distance: number) =>
  createExtrudeFeature(
    {
      profile: [
        { x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 },
        { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 },
      ],
      direction: { x: 0, y: 1, z: 0 },
      distance,
      symmetric: false,
    },
    [],
  );

/** Seed the store with one parametric tree body (10×10×10) and fresh CAM state. */
const seedTreeBody = (): { tree: FeatureTree; extId: string } => {
  const tree = new FeatureTree();
  const ext = parametricExtrude(10);
  tree.addFeature(ext);
  tree.recompute();
  useStore.setState({ featureTree: tree });
  useStore.getState().recomputeTree();
  return { tree, extId: ext.id };
};

const resetCam = (): void => {
  useStore.setState({
    camSetup: defaultCamSetup(), camToolpaths: {},
    undoStack: [], redoStack: [], projectDirty: false,
    selectedIds: [], selectedFaceIds: [], selectedEdgeIds: [],
  });
};

describe('CAM op stable identity (F3) — tree-body ops survive parametric edits', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(), directBodies: [], bodies: [], objectIds: [],
      clipboard: [], pasteCount: 0,
    });
    resetCam();
  });

  it('addCamOperation captures the producing feature id for a tree body', () => {
    const { extId } = seedTreeBody();
    const bodyId = useStore.getState().bodies[0]!.id;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket', bodyId, toolId: 'em-6mm', params,
    });
    const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(bindingOf(op)).toBe(extId);
    expect(useStore.getState().camToolpaths[id]).toBeDefined();
  });

  it('pocket op on a tree body recovers after an upstream edit + regenerate (QA repro)', () => {
    const { extId } = seedTreeBody();
    const bodyId = useStore.getState().bodies[0]!.id;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket', bodyId, toolId: 'em-6mm', params,
    });
    expect(useStore.getState().camToolpaths[id]).toBeDefined();

    // Parametric edit: cut distance 10 → 6. Recompute rotates the result-body
    // id — the exact-match premise of the old resolver is gone.
    expect(useStore.getState().updateFeature(
      extId,
      (f) => (f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 6 } } : f),
    )).toBe(true);
    const newBodyId = useStore.getState().bodies[0]!.id;
    expect(newBodyId).not.toBe(bodyId);

    // Regenerate repairs instead of dropping: the op repoints at the live
    // body through its feature binding and the cache (what G-code export
    // consumes) is back.
    const undoDepth = useStore.getState().undoStack.length;
    useStore.getState().regenerateCamToolpaths();
    const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(op.bodyId).toBe(newBodyId); // repointed, persisted in camSetup
    const cache = useStore.getState().camToolpaths[id]!;
    expect(cache).toBeDefined();
    expect(cache.toolpath.points.length).toBeGreaterThan(0);
    // Cache repair is not a user edit: no undo entry, and every op in the
    // setup resolves — the export's toolpath list would include all of them.
    expect(useStore.getState().undoStack).toHaveLength(undoDepth);
    for (const o of useStore.getState().camSetup.operations) {
      expect(useStore.getState().camToolpaths[o.id], o.id).toBeDefined();
    }

    // Undo restores the pre-edit snapshot: camSetup goes back to the older
    // bodyId, and the older features return. But recompute re-evaluates the
    // restored feature objects (the incremental memo is keyed by object
    // identity, which the edit replaced) and mints yet another body id — so
    // the restored pair needs ONE regenerate, which the binding repairs
    // again. The feature id, not the body id, is the durable identity.
    expect(useStore.getState().undo()).toBe(true);
    const restored = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(restored.bodyId).toBe(bodyId); // the snapshot's camSetup, verbatim
    expect(useStore.getState().bodies.some((b) => b.id === bodyId)).toBe(false);
    useStore.getState().regenerateCamToolpaths();
    const liveId = useStore.getState().bodies[0]!.id;
    expect(useStore.getState().camSetup.operations.find((o) => o.id === id)!.bodyId).toBe(liveId);
    expect(useStore.getState().camToolpaths[id]).toBeDefined();
  });

  it('regenerate alone (no edit) leaves exact-match ops untouched', () => {
    seedTreeBody();
    const bodyId = useStore.getState().bodies[0]!.id;
    const id = useStore.getState().addCamOperation({
      name: 'Contour', enabled: true, type: 'contour', bodyId, toolId: 'em-3mm', params,
    });
    useStore.getState().regenerateCamToolpaths();
    const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(op.bodyId).toBe(bodyId); // no phantom repoint
    expect(useStore.getState().camToolpaths[id]).toBeDefined();
  });
});

describe('CAM op stable identity (F3) — direct bodies keep the exact-id path', () => {
  let box: ReturnType<typeof createBox>;
  beforeEach(() => {
    box = createBox(20, 15, 10);
    useStore.setState({
      featureTree: new FeatureTree(), directBodies: [box], bodies: [box], objectIds: [box.id],
      clipboard: [], pasteCount: 0,
    });
    resetCam();
  });

  it('a direct-body op gets no feature binding and survives tree churn', () => {
    const id = useStore.getState().addCamOperation({
      name: 'Face', enabled: true, type: 'face', bodyId: box.id, toolId: 'em-6mm', params,
    });
    const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(bindingOf(op)).toBeUndefined();

    // Tree bodies appear and rotate around it — the direct target is exact-id,
    // so nothing retargets it.
    seedTreeBody();
    const treeBodyId = useStore.getState().bodies.find((b) => b.id !== box.id)!.id;
    expect(treeBodyId).toBeDefined();
    useStore.getState().regenerateCamToolpaths();
    const after = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(after.bodyId).toBe(box.id);
    expect(useStore.getState().camToolpaths[id]).toBeDefined();
  });

  it('deleting the direct body behind CAM still degrades to the stale flag', () => {
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket', bodyId: box.id, toolId: 'em-6mm', params,
    });
    useStore.setState({ bodies: [], directBodies: [] }); // gone behind CAM's back
    useStore.getState().regenerateCamToolpaths();
    expect(useStore.getState().camToolpaths[id]).toBeUndefined(); // honest stale
    const op = useStore.getState().camSetup.operations.find((o) => o.id === id)!;
    expect(op.bodyId).toBe(box.id); // no phantom retarget
  });

  it('retargeting an op rebinding: tree → direct clears, direct → tree captures', () => {
    const { extId } = seedTreeBody();
    const treeBodyId = useStore.getState().bodies[0]!.id;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket', bodyId: treeBodyId, toolId: 'em-6mm', params,
    });
    expect(bindingOf(useStore.getState().camSetup.operations.find((o) => o.id === id)!)).toBe(extId);

    // Retarget to the direct body: the stale binding must go, or the op would
    // resurrect the old tree body once the direct target dies.
    useStore.getState().updateCamOperation(id, { bodyId: box.id });
    expect(bindingOf(useStore.getState().camSetup.operations.find((o) => o.id === id)!)).toBeUndefined();
    expect(useStore.getState().camToolpaths[id]).toBeDefined();

    // And back onto the tree body: the binding is re-captured.
    useStore.getState().updateCamOperation(id, { bodyId: treeBodyId });
    expect(bindingOf(useStore.getState().camSetup.operations.find((o) => o.id === id)!)).toBe(extId);
  });
});

describe('CAM op stable identity (F3) — dead features degrade honestly', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(), directBodies: [], bodies: [], objectIds: [],
      clipboard: [], pasteCount: 0,
    });
    resetCam();
  });

  it('an op whose feature was deleted stays unresolvable (no phantom retarget)', () => {
    const { extId } = seedTreeBody();
    const bodyId = useStore.getState().bodies[0]!.id;
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket', bodyId, toolId: 'em-6mm', params,
    });
    expect(useStore.getState().camToolpaths[id]).toBeDefined();

    useStore.getState().removeFeature(extId); // the producing feature is gone
    expect(useStore.getState().bodies).toHaveLength(0);
    useStore.getState().regenerateCamToolpaths();

    // No other body to retarget to: cache dropped (the panel's stale flag is
    // the honest signal) and bodyId untouched rather than pointed at noise.
    expect(useStore.getState().camToolpaths[id]).toBeUndefined();
    expect(useStore.getState().camSetup.operations.find((o) => o.id === id)!.bodyId).toBe(bodyId);
  });

  it('a suppressed producing feature also degrades to stale, and recovers on unsuppress', () => {
    const { extId } = seedTreeBody();
    const id = useStore.getState().addCamOperation({
      name: 'Pocket', enabled: true, type: 'pocket',
      bodyId: useStore.getState().bodies[0]!.id, toolId: 'em-6mm', params,
    });
    useStore.getState().updateFeature(extId, (f) => ({ ...f, suppressed: true }));
    expect(useStore.getState().bodies).toHaveLength(0);
    useStore.getState().regenerateCamToolpaths();
    expect(useStore.getState().camToolpaths[id]).toBeUndefined();

    // Unsuppress: the feature's result returns (with rotated ids) and the
    // binding rescues the op again through regenerate.
    useStore.getState().updateFeature(extId, (f) => ({ ...f, suppressed: false }));
    const liveId = useStore.getState().bodies[0]!.id;
    useStore.getState().regenerateCamToolpaths();
    expect(useStore.getState().camToolpaths[id]).toBeDefined();
    expect(useStore.getState().camSetup.operations.find((o) => o.id === id)!.bodyId).toBe(liveId);
  });
});
