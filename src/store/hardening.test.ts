// Store hardening tests: failed sketch-feature attempts (T3), sketch fields in
// the undo history (T4/F15), tree-body refusal for direct-edit mutators
// (T5/W1) and the pattern/split consistency sweep (T6).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree } from '../lib/features/tree';
import { createBox, computeBoundingBox } from '../lib/geometry';
import { createSketch, addLine, addRectangle } from '../lib/sketch/engine';
import { subscribe, clearToasts } from '../lib/toast';

const messages: string[] = [];
subscribe((ts) => {
  messages.length = 0;
  messages.push(...ts.map((t) => t.message));
});

/** Fresh scene: empty tree, empty history, no sketch session. */
const resetScene = () => {
  useStore.setState({
    featureTree: new FeatureTree(),
    bodies: [],
    directBodies: [],
    objectIds: [],
    selectedIds: [],
    undoStack: [],
    redoStack: [],
    currentSketch: null,
    sketchActive: false,
    workspace: 'model',
    showExtrudeDialog: false,
    showRevolveDialog: false,
  });
};

/** Build a feature-tree body (sketch + extrude) and return its id. */
const makeTreeBodyId = (): string => {
  const sketch = createSketch('xy');
  addRectangle(sketch, 0, 0, 10, 10);
  useStore.setState({ currentSketch: sketch });
  expect(useStore.getState().performExtrude(10, false)).toBe(true);
  const id = useStore.getState().bodies[0]!.id;
  expect(useStore.getState().directBodies).toHaveLength(0); // really a tree body
  return id;
};

beforeEach(() => {
  resetScene();
  clearToasts();
});

describe('failed sketch-feature attempts keep the sketch session (T3)', () => {
  it('performExtrude on an open profile returns false and leaves no trace', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0); // a single open line: no closed profile
    useStore.setState({
      currentSketch: sketch,
      sketchActive: true,
      workspace: 'sketch',
      showExtrudeDialog: true,
    });

    expect(useStore.getState().performExtrude(5, false)).toBe(false);

    // The sketch session survives untouched — the user can fix the profile.
    const s = useStore.getState();
    expect(s.currentSketch).toBe(sketch); // same reference, entities intact
    expect(s.currentSketch!.entities.size).toBeGreaterThan(0);
    expect(s.sketchActive).toBe(true);
    expect(s.workspace).toBe('sketch');
    expect(s.showExtrudeDialog).toBe(true);

    // Neither features nor history were polluted.
    expect(s.featureTree.features).toHaveLength(0);
    expect(s.undoStack).toHaveLength(0);
    expect(s.bodies).toHaveLength(0);

    // The failure was surfaced.
    expect(messages.some((m) => m.startsWith('Extrude failed:'))).toBe(true);
  });

  it('performRevolve on an open profile returns false and leaves no trace', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    useStore.setState({ currentSketch: sketch, sketchActive: true, workspace: 'sketch' });

    expect(useStore.getState().performRevolve(Math.PI * 2)).toBe(false);

    const s = useStore.getState();
    expect(s.currentSketch).toBe(sketch);
    expect(s.workspace).toBe('sketch');
    expect(s.featureTree.features).toHaveLength(0);
    expect(s.undoStack).toHaveLength(0);
    expect(messages.some((m) => m.startsWith('Revolve failed:'))).toBe(true);
  });

  it('performSweep on an open profile returns false and leaves no trace', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    useStore.setState({ currentSketch: sketch, sketchActive: true, workspace: 'sketch' });

    expect(useStore.getState().performSweep(8, 45)).toBe(false);

    const s = useStore.getState();
    expect(s.currentSketch).toBe(sketch);
    expect(s.workspace).toBe('sketch');
    expect(s.featureTree.features).toHaveLength(0);
    expect(s.undoStack).toHaveLength(0);
    expect(messages.some((m) => m.startsWith('Sweep failed:'))).toBe(true);
  });

  it('a successful extrude still returns true and produces the body', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.setState({ currentSketch: sketch });
    expect(useStore.getState().performExtrude(10, false)).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().currentSketch).toBeNull();
    expect(useStore.getState().workspace).toBe('model');
  });

  it('a retry after a failed extrude does not leave a duplicate sketch node', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    useStore.setState({ currentSketch: sketch });
    expect(useStore.getState().performExtrude(5, false)).toBe(false);
    // User closes the profile and retries — the tree gets exactly one sketch
    // feature this time (the failed attempt's nodes were fully removed).
    expect(useStore.getState().performExtrude(5, false)).toBe(false);
    expect(useStore.getState().featureTree.features).toHaveLength(0);
  });
});

describe('undo history restores the sketch session (T4 / F15)', () => {
  it('undo after a successful extrude returns to the sketch; redo returns to the body', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.setState({ currentSketch: sketch, sketchActive: true, workspace: 'sketch' });

    expect(useStore.getState().performExtrude(10, false)).toBe(true);
    expect(useStore.getState().currentSketch).toBeNull();
    expect(useStore.getState().workspace).toBe('model');

    expect(useStore.getState().undo()).toBe(true);
    const s = useStore.getState();
    expect(s.currentSketch).not.toBeNull();
    const lines = [...s.currentSketch!.entities.values()].filter((e) => e.type === 'line');
    expect(lines).toHaveLength(4); // entities came back
    expect(s.workspace).toBe('sketch');
    expect(s.sketchActive).toBe(true);
    expect(s.featureTree.features).toHaveLength(0); // features gone again

    expect(useStore.getState().redo()).toBe(true);
    const t = useStore.getState();
    expect(t.currentSketch).toBeNull();
    expect(t.workspace).toBe('model');
    expect(t.bodies).toHaveLength(1);
    expect(t.featureTree.features).toHaveLength(2); // sketch + extrude
  });

  it('the restored sketch is a deep copy — later edits do not leak into older snapshots', () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0);
    useStore.setState({ currentSketch: sketch, sketchActive: true, workspace: 'sketch' });
    useStore.getState().performExtrude(10, false); // fails: open profile → still sketching
    // Close the loop and extrude for real.
    addLine(useStore.getState().currentSketch!, 10, 0, 10, 10);
    addLine(useStore.getState().currentSketch!, 10, 10, 0, 0);
    expect(useStore.getState().performExtrude(10, false)).toBe(true);
    expect(useStore.getState().undo()).toBe(true);
    const restored = useStore.getState().currentSketch!;
    const restoredCount = restored.entities.size;
    // Mutating the restored session must not corrupt the redo snapshot.
    useStore.getState().addSketchCircle(5, 5, 2);
    expect(useStore.getState().currentSketch!.entities.size).toBe(restoredCount + 2); // circle + centre point
    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().currentSketch).toBeNull();
  });

  it('snapshots with no sketch round-trip (undo a body edit stays in the model workspace)', () => {
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    useStore.getState().addDirectBody(createBox(6, 6, 6));
    expect(useStore.getState().undo()).toBe(true);
    const s = useStore.getState();
    expect(s.currentSketch).toBeNull();
    expect(s.sketchActive).toBe(false);
    expect(s.workspace).toBe('model');
    expect(s.bodies).toHaveLength(1);
  });
});

describe('replaceBody refuses tree bodies (T5 / W1)', () => {
  it('returns false, mutates nothing, pushes no undo entry and raises the toast', () => {
    const treeBodyId = makeTreeBodyId();
    const undoDepth = useStore.getState().undoStack.length;

    expect(useStore.getState().replaceBody(treeBodyId, createBox(3, 3, 3))).toBe(false);

    const s = useStore.getState();
    expect(s.bodies).toHaveLength(1); // exactly one body — no duplicate
    expect(s.bodies[0]!.id).toBe(treeBodyId);
    expect(s.directBodies).toHaveLength(0); // the edit was NOT appended
    expect(s.undoStack).toHaveLength(undoDepth); // no orphan undo entry
    expect(messages.some((m) => m.includes('feature tree'))).toBe(true);
  });

  it('still replaces a direct body in place and returns true', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    const edited = createBox(3, 3, 3);
    expect(useStore.getState().replaceBody(box.id, edited)).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().bodies[0]!.id).toBe(edited.id);
  });

  it('resizeBodyTo on a tree body returns false without touching the scene', () => {
    const treeBodyId = makeTreeBodyId();
    const undoDepth = useStore.getState().undoStack.length;
    expect(useStore.getState().resizeBodyTo(treeBodyId, { x: 40, y: 5, z: 20 })).toBe(false);
    const s = useStore.getState();
    expect(s.bodies).toHaveLength(1);
    expect(s.undoStack).toHaveLength(undoDepth);
    // The tree body kept its original extents.
    const xs = s.bodies[0]!.vertices.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 4);
  });

  it('placeBodyInCoordinateSystem on a tree body returns null without duplicating', () => {
    const treeBodyId = makeTreeBodyId();
    const csId = useStore.getState().addCoordinateSystem(
      { x: 20, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    )!;
    expect(useStore.getState().placeBodyInCoordinateSystem(treeBodyId, csId)).toBeNull();
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });
});

describe('direct-only mutators never duplicate tree bodies (T6)', () => {
  it('linearPatternBody refuses a tree body', () => {
    const treeBodyId = makeTreeBodyId();
    const undoDepth = useStore.getState().undoStack.length;
    expect(useStore.getState().linearPatternBody(treeBodyId, 'x', 4, 10)).toEqual([]);
    const s = useStore.getState();
    expect(s.bodies).toHaveLength(1);
    expect(s.directBodies).toHaveLength(0);
    expect(s.undoStack).toHaveLength(undoDepth);
    expect(messages.some((m) => m.includes('feature tree'))).toBe(true);
  });

  it('circularPatternBody refuses a tree body', () => {
    const treeBodyId = makeTreeBodyId();
    expect(useStore.getState().circularPatternBody(treeBodyId, 'y', 6)).toEqual([]);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });

  it('gridPatternBody refuses a tree body', () => {
    const treeBodyId = makeTreeBodyId();
    expect(useStore.getState().gridPatternBody(treeBodyId, 3, 10, 2, 10)).toEqual([]);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('splitBodyByPlane refuses a tree body', () => {
    const treeBodyId = makeTreeBodyId();
    useStore.getState().ensureStandardPlanes();
    const top = useStore.getState().planes.find((p) => p.normal.y > 0.99)!;
    const midId = useStore.getState().addOffsetPlane(top.id, 5)!;
    expect(useStore.getState().splitBodyByPlane(treeBodyId, midId)).toEqual([]);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });

  it('selection transforms skip tree bodies by design (no duplication, count 0)', () => {
    const treeBodyId = makeTreeBodyId();
    useStore.getState().selectObject(treeBodyId);
    expect(useStore.getState().rotateSelected('z', 90)).toBe(0);
    expect(useStore.getState().scaleSelected(2)).toBe(0);
    expect(useStore.getState().nudgeSelected(1, 0, 0)).toBe(0);
    const s = useStore.getState();
    expect(s.bodies).toHaveLength(1);
    expect(s.directBodies).toHaveLength(0);
    // No toast for these — skipping tree bodies in a selection is the
    // documented design, not a refusal the user needs to act on.
    expect(messages).toHaveLength(0);
  });
});

describe('failed sketch features keep the redo branch (T1)', () => {
  /** Seed one redo entry: insert a box, then undo it. */
  const seedRedo = (): number => {
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().directBodies).toHaveLength(0);
    return useStore.getState().redoStack.length;
  };

  const openSketchSession = () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0); // open profile: every perform* fails
    useStore.setState({
      currentSketch: sketch,
      sketchActive: true,
      workspace: 'sketch',
      sketchUndoStack: [],
      sketchRedoStack: [],
    });
    return sketch;
  };

  it('a failed extrude leaves the redo stack intact and redo() still works', () => {
    const depth = seedRedo();
    openSketchSession();
    expect(useStore.getState().performExtrude(5, false)).toBe(false);
    // The failed attempt is no trace at all — the redo branch pushUndo cleared
    // comes back, so the undone box remains redoable.
    expect(useStore.getState().redoStack).toHaveLength(depth);
    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().directBodies).toHaveLength(1);
    expect(useStore.getState().redoStack).toHaveLength(0);
  });

  it('a failed revolve leaves the redo stack intact', () => {
    const depth = seedRedo();
    openSketchSession();
    expect(useStore.getState().performRevolve(Math.PI)).toBe(false);
    expect(useStore.getState().redoStack).toHaveLength(depth);
    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().directBodies).toHaveLength(1);
  });

  it('a failed sweep leaves the redo stack intact', () => {
    const depth = seedRedo();
    openSketchSession();
    expect(useStore.getState().performSweep(8, 45)).toBe(false);
    expect(useStore.getState().redoStack).toHaveLength(depth);
    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().directBodies).toHaveLength(1);
  });

  it('a SUCCESSFUL extrude still clears the redo branch (new edit invalidates it)', () => {
    seedRedo();
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.setState({ currentSketch: sketch });
    expect(useStore.getState().performExtrude(5, false)).toBe(true);
    expect(useStore.getState().redoStack).toHaveLength(0);
  });
});

describe('model-undo into an older sketch restores that session history (T2)', () => {
  it('in-sketch undo/redo step the restored history, not the newer session', () => {
    // Session 1: a closed profile (rect + line) extruded successfully. The
    // rect is drawn directly on the object; the line goes through the store,
    // so session 1's sketch history has exactly one entry: the rect-only sketch.
    const st = useStore.getState();
    st.setSketchPlaneId('xz');
    const s1 = createSketch('xz');
    addRectangle(s1, 0, 0, 10, 8);
    useStore.setState({ currentSketch: s1, sketchActive: true, workspace: 'sketch', sketchUndoStack: [], sketchRedoStack: [] });
    const rectOnlyCount = useStore.getState().currentSketch!.entities.size; // 8: 4 points + 4 lines
    useStore.getState().addSketchLine(20, 0, 30, 0); // pushes the rect-only clone, then adds 3 entities
    const withLineCount = useStore.getState().currentSketch!.entities.size; // 11
    expect(useStore.getState().performExtrude(5, false)).toBe(true);
    expect(useStore.getState().currentSketch).toBeNull();

    // Session 2: a different sketch with its own (newer) edit history.
    const s2 = createSketch('xz');
    addRectangle(s2, 0, 0, 4, 4);
    useStore.setState({ currentSketch: s2, sketchActive: true, workspace: 'sketch', sketchUndoStack: [], sketchRedoStack: [] });
    useStore.getState().addSketchCircle(1, 1, 2);
    const s2Count = useStore.getState().currentSketch!.entities.size;
    expect(useStore.getState().sketchUndoStack).toHaveLength(1); // the newer session's entry
    expect(useStore.getState().sketchUndoStack[0]!.entities.size).toBe(s2Count - 2); // rect-only clone of S2

    // Model-undo lands back INSIDE session 1's sketch (F15) — with ITS
    // history, not session 2's.
    expect(useStore.getState().undo()).toBe(true);
    const back = useStore.getState();
    expect(back.currentSketch).not.toBeNull();
    expect(back.currentSketch!.entities.size).toBe(withLineCount);
    expect(back.sketchActive).toBe(true);
    // The restored stack holds session 1's rect-only entry, not session 2's
    // (same length, different content — the counts distinguish them).
    expect(back.sketchUndoStack).toHaveLength(1);
    expect(back.sketchUndoStack[0]!.entities.size).toBe(rectOnlyCount);
    expect(back.sketchRedoStack).toHaveLength(0);

    // In-sketch Ctrl+Z steps the RESTORED history back to session 1's
    // rect-only sketch. With the stale stacks it jumped to session 2's sketch
    // (8 entities as well but belonging to the wrong session — so also assert
    // the content: the restored rect is 10×8, session 2's was 4×4).
    expect(useStore.getState().sketchUndo()).toBe(true);
    const undone = useStore.getState().currentSketch!;
    expect(undone.entities.size).toBe(rectOnlyCount);
    const xs = [...undone.entities.values()].filter((e) => e.type === 'point').map((p) => (p as { x: number }).x);
    expect(Math.max(...xs)).toBe(10); // session 1's rect, not session 2's (max x = 4)
    // And the sketch redo round-trips back to the with-line sketch.
    expect(useStore.getState().sketchRedo()).toBe(true);
    expect(useStore.getState().currentSketch!.entities.size).toBe(withLineCount);

    // Model redo returns to the state the undo came from: the extruded body
    // AND session 2's live sketch with ITS history (the round-trip restores
    // the stacks in both directions).
    expect(useStore.getState().redo()).toBe(true);
    const fwd = useStore.getState();
    expect(fwd.bodies).toHaveLength(1);
    expect(fwd.currentSketch).not.toBeNull();
    expect(fwd.currentSketch!.entities.size).toBe(s2Count);
    expect(fwd.sketchActive).toBe(true);
    expect(fwd.sketchUndoStack).toHaveLength(1);
    expect(fwd.sketchUndoStack[0]!.entities.size).toBe(s2Count - 2);
  });
});

describe('performSweep extrudes perpendicular to the drawn plane (T3)', () => {
  it('an xy sketch sweeps along world +Z with the profile where it was drawn', () => {
    useStore.getState().setSketchPlaneId('xy');
    useStore.getState().setWorkspace('sketch'); // starts the session on xy
    useStore.getState().addSketchRect(0, 0, 4, 10);
    expect(useStore.getState().performSweep(2, 0)).toBe(true);
    const bb = computeBoundingBox(useStore.getState().bodies[0]!);
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(4, 9);
    expect(bb.min.y).toBeCloseTo(0, 9);
    expect(bb.max.y).toBeCloseTo(10, 9);
    expect(bb.min.z).toBeCloseTo(0, 9);
    expect(bb.max.z).toBeCloseTo(2, 9); // out of the drawn plane
  });

  it('an xz (default ground) sketch keeps the legacy +Y sweep', () => {
    useStore.getState().setSketchPlaneId('xz');
    useStore.getState().setWorkspace('sketch');
    useStore.getState().addSketchRect(0, 0, 4, 10);
    expect(useStore.getState().performSweep(2, 0)).toBe(true);
    const bb = computeBoundingBox(useStore.getState().bodies[0]!);
    // Legacy ring placement: sketch (x,y) → world (y, ·, −x).
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(10, 9);
    expect(bb.min.y).toBeCloseTo(0, 9);
    expect(bb.max.y).toBeCloseTo(2, 9);
    expect(bb.min.z).toBeCloseTo(-4, 9);
    expect(bb.max.z).toBeCloseTo(0, 9);
  });
});
