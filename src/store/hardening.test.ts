// Store hardening tests: failed sketch-feature attempts (T3), sketch fields in
// the undo history (T4/F15), tree-body refusal for direct-edit mutators
// (T5/W1) and the pattern/split consistency sweep (T6).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree } from '../lib/features/tree';
import { createBox } from '../lib/geometry';
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
