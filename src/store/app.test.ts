import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature, createSketchFeature } from '../lib/features/tree';
import { createBox, computeVolume, translateBody } from '../lib/geometry';
import { createSketch, addRectangle } from '../lib/sketch/engine';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, deserializeDirectBodies } from '../lib/io';

describe('app store', () => {
  it('should have default theme', () => {
    const theme = useStore.getState().theme;
    expect(theme).toBe('dark');
  });

  it('should have default locale', () => {
    const locale = useStore.getState().locale;
    expect(locale).toBe('en');
  });

  it('should have default workspace', () => {
    const workspace = useStore.getState().workspace;
    expect(workspace).toBe('model');
  });

  it('should set theme', () => {
    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
    useStore.getState().setTheme('dark');
  });

  it('should persist theme and locale to localStorage', () => {
    useStore.getState().setTheme('high-contrast');
    expect(localStorage.getItem('scenelab.theme')).toBe('high-contrast');
    useStore.getState().setLocale('zh');
    expect(localStorage.getItem('scenelab.locale')).toBe('zh');
    useStore.getState().setTheme('dark');
    useStore.getState().setLocale('en');
  });

  it('should set locale', () => {
    useStore.getState().setLocale('zh');
    expect(useStore.getState().locale).toBe('zh');
    useStore.getState().setLocale('en');
  });

  it('should set workspace', () => {
    useStore.getState().setWorkspace('sketch');
    expect(useStore.getState().workspace).toBe('sketch');
    useStore.getState().setWorkspace('model');
  });

  it('should set view direction', () => {
    useStore.getState().setViewDirection('top');
    expect(useStore.getState().viewDirection).toBe('top');
    useStore.getState().setViewDirection('iso');
  });

  it('should toggle browser tree', () => {
    const initial = useStore.getState().showBrowserTree;
    useStore.getState().toggleBrowserTree();
    expect(useStore.getState().showBrowserTree).toBe(!initial);
    useStore.getState().toggleBrowserTree();
  });

  it('should toggle properties', () => {
    const initial = useStore.getState().showProperties;
    useStore.getState().toggleProperties();
    expect(useStore.getState().showProperties).toBe(!initial);
    useStore.getState().toggleProperties();
  });

  it('should add and select objects', () => {
    useStore.getState().addObject('test-1');
    expect(useStore.getState().objectIds).toContain('test-1');

    useStore.getState().selectObject('test-1');
    expect(useStore.getState().selectedIds).toEqual(['test-1']);

    useStore.getState().deselectAll();
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('should set sketch tool', () => {
    useStore.getState().setSketchTool('line');
    expect(useStore.getState().sketchTool).toBe('line');
    useStore.getState().setSketchTool('select');
  });

  it('should set sketch active', () => {
    useStore.getState().setSketchActive(true);
    expect(useStore.getState().sketchActive).toBe(true);
    useStore.getState().setSketchActive(false);
  });

  it('should set project name', () => {
    useStore.getState().setProjectName('Test Project');
    expect(useStore.getState().projectName).toBe('Test Project');
    useStore.getState().setProjectName('Untitled');
  });

  it('should set project dirty', () => {
    useStore.getState().setProjectDirty(true);
    expect(useStore.getState().projectDirty).toBe(true);
    useStore.getState().setProjectDirty(false);
  });
});

describe('app store — direct bodies', () => {
  beforeEach(() => {
    // Reset geometry-related state to a clean tree.
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [],
      directBodies: [],
      objectIds: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });
  });

  it('direct bodies survive a tree recompute', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().bodies).toHaveLength(1);

    // Recomputing the (empty) tree must not wipe the direct body.
    useStore.getState().recomputeTree();
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().bodies[0]?.id).toBe(box.id);
  });

  it('combined render list = tree bodies + direct bodies', () => {
    const ext = createExtrudeFeature(
      {
        profile: [
          { x: -5, y: 0, z: -5 },
          { x: 5, y: 0, z: -5 },
          { x: 5, y: 0, z: 5 },
          { x: -5, y: 0, z: 5 },
        ],
        direction: { x: 0, y: 1, z: 0 },
        distance: 10,
      },
      [],
    );
    useStore.getState().addFeature(ext);
    expect(useStore.getState().bodies).toHaveLength(1); // tree body

    useStore.getState().addDirectBody(createBox(2, 2, 2));
    expect(useStore.getState().bodies).toHaveLength(2); // tree + direct
  });

  it('performRevolve turns the current sketch into a solid of revolution', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 2, 0, 4, 2); // section offset from the Y axis
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performRevolve(Math.PI * 2);

    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    // Pappus: area 4 × 2π × centroidRadius 3 = 24π
    expect(Math.abs(computeVolume(bodies[0]!))).toBeGreaterThan(24 * Math.PI * 0.95);
    expect(useStore.getState().currentSketch).toBeNull();
  });

  it('loadProject rebuilds geometry from a saved project file', () => {
    // Author a part, save it, then load it back through the store.
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      {
        profile: [
          { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 10 },
        ],
        direction: { x: 0, y: 1, z: 0 },
        distance: 5,
      },
      [sf.id],
    );
    const json = saveToFile(serializeProject('Loaded', [sf, ef], []));

    useStore.getState().clearScene();
    const features = deserializeFeatures(loadFromFile(json));
    useStore.getState().loadProject(features, 'Loaded');

    expect(useStore.getState().projectName).toBe('Loaded');
    expect(useStore.getState().projectDirty).toBe(false);
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(bodies[0]!))).toBeCloseTo(500, 3);
  });

  it('persists and restores direct (non-tree) bodies through save/load', () => {
    const box = createBox(10, 10, 10);
    const json = saveToFile(serializeProject('WithDirect', [], [box], [box]));
    const project = loadFromFile(json);

    useStore.getState().clearScene();
    useStore.getState().loadProject(
      deserializeFeatures(project),
      project.name,
      deserializeDirectBodies(project),
    );

    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    // Full mesh restored (faces, not just a vertex summary).
    expect(bodies[0]!.faces.length).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(bodies[0]!))).toBeCloseTo(1000, 3);
  });

  it('replaceBody edits a direct body in place and survives recompute', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);

    const edited = createBox(3, 3, 3);
    useStore.getState().replaceBody(box.id, edited);

    let bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.id).toBe(edited.id);

    useStore.getState().recomputeTree();
    bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.id).toBe(edited.id);
  });

  it('addPrimitive creates each kind and adds it to the scene', () => {
    const kinds = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism', 'tube', 'coil'] as const;
    for (const kind of kinds) {
      useStore.setState({ featureTree: new FeatureTree(), bodies: [], directBodies: [], objectIds: [] });
      const id = useStore.getState().addPrimitive(kind);
      const bodies = useStore.getState().bodies;
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.id).toBe(id);
      expect(bodies[0]!.faces.length).toBeGreaterThan(0);
      expect(useStore.getState().projectDirty).toBe(true);
    }
  });

  it('deleteSelected removes selected direct bodies and clears their selection', () => {
    const a = createBox(10, 10, 10);
    const b = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().selectObject(a.id);
    useStore.setState({ projectDirty: false });

    const removed = useStore.getState().deleteSelected();

    expect(removed).toBe(1);
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.id).toBe(b.id); // unselected body survives
    expect(useStore.getState().selectedIds).not.toContain(a.id);
    expect(useStore.getState().projectDirty).toBe(true);
  });

  it('deleteSelected is a no-op with nothing selected', () => {
    useStore.getState().addDirectBody(createBox(10, 10, 10));
    useStore.getState().deselectAll();
    expect(useStore.getState().deleteSelected()).toBe(0);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('autosave writes to localStorage and restoreAutosave reloads the scene', () => {
    localStorage.removeItem('scenelab.autosave');
    useStore.getState().addDirectBody(createBox(10, 10, 10)); // marks dirty
    expect(useStore.getState().autosave()).toBe(true);
    expect(useStore.getState().hasAutosave()).toBe(true);

    useStore.getState().clearScene();
    expect(useStore.getState().bodies).toHaveLength(0);

    expect(useStore.getState().restoreAutosave()).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(1000, 3);
    localStorage.removeItem('scenelab.autosave');
  });

  it('autosave is a no-op when there are no unsaved changes', () => {
    localStorage.removeItem('scenelab.autosave');
    useStore.setState({ projectDirty: false });
    expect(useStore.getState().autosave()).toBe(false);
  });

  it('undo/redo revert and re-apply scene-body edits', () => {
    const a = createBox(10, 10, 10);
    const b = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    expect(useStore.getState().bodies).toHaveLength(2);

    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().bodies[0]!.id).toBe(a.id);

    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(0);
    expect(useStore.getState().undo()).toBe(false);

    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().redo()).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(2);
    expect(useStore.getState().redo()).toBe(false);
  });

  it('a new edit clears the redo stack', () => {
    useStore.getState().addDirectBody(createBox(10, 10, 10));
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    expect(useStore.getState().redoStack.length).toBe(0);
    expect(useStore.getState().redo()).toBe(false);
  });

  it('resizeBodyTo resizes a body to exact extents and keeps it selected', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    const ok = useStore.getState().resizeBodyTo(box.id, { x: 40, y: 5, z: 20 });
    expect(ok).toBe(true);
    const sel = useStore.getState().selectedIds;
    expect(sel).toHaveLength(1);
    const resized = useStore.getState().bodies.find((b) => b.id === sel[0])!;
    const xs = resized.vertices.map((v) => v.x);
    const ys = resized.vertices.map((v) => v.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(5, 4);
  });

  it('exitSketch leaves sketch mode and returns to the model workspace', () => {
    useStore.setState({ sketchActive: true, sketchTool: 'rect', drawStart: { x: 1, y: 1 }, workspace: 'sketch' });
    useStore.getState().exitSketch();
    expect(useStore.getState().sketchActive).toBe(false);
    expect(useStore.getState().sketchTool).toBe('select');
    expect(useStore.getState().drawStart).toBeNull();
    expect(useStore.getState().workspace).toBe('model');
  });

  it('renameBody updates a direct body name; rejects blank or unknown id', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().renameBody(box.id, '  Bracket  ')).toBe(true);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)!.name).toBe('Bracket'); // trimmed
    expect(useStore.getState().renameBody(box.id, '   ')).toBe(false); // blank rejected
    expect(useStore.getState().renameBody('nope', 'X')).toBe(false);
  });

  it('setBodyColor stores a colour on a direct body; rejects unknown id', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().setBodyColor(box.id, 0xf38ba8)).toBe(true);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)!.color).toBe(0xf38ba8);
    expect(useStore.getState().setBodyColor('nope', 0x000000)).toBe(false);
  });

  it('rememberPrimitiveParams stores last dimensions per kind', () => {
    useStore.getState().rememberPrimitiveParams('box', { w: 30, h: 12, d: 8 });
    expect(useStore.getState().lastPrimitiveParams.box).toEqual({ w: 30, h: 12, d: 8 });
    useStore.getState().rememberPrimitiveParams('box', { w: 5, h: 5, d: 5 }); // overwrites
    expect(useStore.getState().lastPrimitiveParams.box).toEqual({ w: 5, h: 5, d: 5 });
    expect(useStore.getState().lastPrimitiveParams.cylinder).toBeUndefined();
  });

  it('duplicateSelected clones selected bodies (offset, colour kept) and selects copies', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    useStore.getState().setBodyColor(box.id, 0xf38ba8);
    useStore.getState().selectObject(box.id);
    const ids = useStore.getState().duplicateSelected();
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(box.id);
    expect(useStore.getState().bodies).toHaveLength(2);
    expect(useStore.getState().selectedIds).toEqual(ids); // copy is selected
    const copy = useStore.getState().bodies.find((b) => b.id === ids[0])!;
    expect(copy.color).toBe(0xf38ba8); // colour preserved
    expect(useStore.getState().duplicateSelected.length).toBeGreaterThanOrEqual(0);
  });

  it('nudgeSelected translates selected bodies in place, keeping ids', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10); // x ∈ [-5,5]
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().nudgeSelected(2, 0, 0)).toBe(1);
    const moved = useStore.getState().bodies.find((b) => b.id === box.id)!; // same id
    expect(moved).toBeDefined();
    const minX = Math.min(...moved.vertices.map((v) => v.x));
    expect(minX).toBeCloseTo(-3, 5); // -5 + 2
    expect(useStore.getState().selectedIds).toEqual([box.id]); // selection preserved
  });

  it('copySelected + paste creates offset copies and supports multiple pastes', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().copySelected()).toBe(1);
    const first = useStore.getState().paste();
    expect(first).toHaveLength(1);
    expect(useStore.getState().bodies).toHaveLength(2);
    const second = useStore.getState().paste(); // clipboard persists → paste again
    expect(second).toHaveLength(1);
    expect(useStore.getState().bodies).toHaveLength(3);
    expect(useStore.getState().selectedIds).toEqual(second);
  });

  it('paste is a no-op with an empty clipboard', () => {
    useStore.getState().clearScene();
    expect(useStore.getState().paste()).toEqual([]);
  });

  it('rotateSelected rotates in place keeping id (90° about Z swaps X/Y extents)', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 20, 10); // x extent 10, y extent 20
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().rotateSelected('z', 90)).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!; // id preserved
    const xs = r.vertices.map((v) => v.x);
    const ys = r.vertices.map((v) => v.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 4); // swapped
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 4);
  });

  it('alignSelected centers selected bodies on an axis (keeps ids)', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // x ∈ [-5,5], center 0
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25], center 20
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    expect(useStore.getState().alignSelected('x', 'center')).toBe(2);
    // Overall center is (−5..25) → 10; both bodies' centers move to x=10.
    const center = (body: { vertices: { x: number }[] }) => {
      const xs = body.vertices.map((v) => v.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const ra = useStore.getState().bodies.find((x) => x.id === a.id)!;
    const rb = useStore.getState().bodies.find((x) => x.id === b.id)!;
    expect(center(ra)).toBeCloseTo(10, 4);
    expect(center(rb)).toBeCloseTo(10, 4);
  });

  it('distributeSelected evenly spaces middle bodies, ends fixed', () => {
    useStore.getState().clearScene();
    const a = createBox(2, 2, 2); // center 0 (x ∈ [-1,1])
    const b = translateBody(createBox(2, 2, 2), { x: 3, y: 0, z: 0 }); // center 3
    const c = translateBody(createBox(2, 2, 2), { x: 10, y: 0, z: 0 }); // center 10
    useStore.getState().addDirectBodies([a, b, c]);
    useStore.getState().selectAll();
    expect(useStore.getState().distributeSelected('x')).toBe(3);
    const cx = (body: { vertices: { x: number }[] }) => {
      const xs = body.vertices.map((v) => v.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const rb = useStore.getState().bodies.find((x) => x.id === b.id)!;
    expect(cx(rb)).toBeCloseTo(5, 4); // midpoint between ends 0 and 10
  });

  it('dropSelectedToFloor moves a body so its min Y is 0', () => {
    useStore.getState().clearScene();
    const box = translateBody(createBox(10, 10, 10), { x: 0, y: 5, z: 0 }); // y ∈ [5,15]
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().dropSelectedToFloor()).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!;
    expect(Math.min(...r.vertices.map((v) => v.y))).toBeCloseTo(0, 5);
  });

  it('linearPatternBody replaces a body with count copies along an axis', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    const ids = useStore.getState().linearPatternBody(box.id, 'x', 4, 10);
    expect(ids).toHaveLength(4);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)).toBeUndefined(); // original replaced
    expect(useStore.getState().bodies).toHaveLength(4);
    // Copies span 3 gaps of 10 → 30mm spread between first and last centres.
    const centers = ids.map((id) => {
      const b = useStore.getState().bodies.find((x) => x.id === id)!;
      const xs = b.vertices.map((v) => v.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    }).sort((a, b) => a - b);
    expect(centers[centers.length - 1]! - centers[0]!).toBeCloseTo(30, 4);
  });

  it('circularPatternBody replaces a body with count copies around an axis', () => {
    useStore.getState().clearScene();
    const box = translateBody(createBox(4, 4, 4), { x: 20, y: 0, z: 0 }); // offset from origin
    useStore.getState().addDirectBody(box);
    const ids = useStore.getState().circularPatternBody(box.id, 'y', 6);
    expect(ids).toHaveLength(6);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)).toBeUndefined();
    expect(useStore.getState().bodies).toHaveLength(6);
  });

  it('linearPatternBody returns [] for a missing body or bad params', () => {
    useStore.getState().clearScene();
    const box = createBox(2, 2, 2);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().linearPatternBody('nope', 'x', 3, 5)).toEqual([]);
    expect(useStore.getState().linearPatternBody(box.id, 'x', 3, 0)).toEqual([]);
  });

  it('dropSelectedToFloor is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    expect(useStore.getState().dropSelectedToFloor()).toBe(0);
  });

  it('distributeSelected needs at least three bodies', () => {
    useStore.getState().clearScene();
    const a = createBox(2, 2, 2);
    const b = translateBody(createBox(2, 2, 2), { x: 5, y: 0, z: 0 });
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    expect(useStore.getState().distributeSelected('x')).toBe(0);
  });

  it('alignSelected needs at least two bodies', () => {
    useStore.getState().clearScene();
    const box = createBox(2, 2, 2);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().alignSelected('x', 'min')).toBe(0);
  });

  it('scaleSelected scales about the body centre keeping id (2× doubles extent, centre fixed)', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10); // x ∈ [-5,5], center 0
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().scaleSelected(2)).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!;
    const xs = r.vertices.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 4); // doubled
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0, 4); // centre unchanged
  });

  it('scaleSelected rejects nothing-selected and non-positive factor', () => {
    useStore.getState().clearScene();
    const box = createBox(2, 2, 2);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().scaleSelected(0)).toBe(0);
    useStore.getState().deselectAll();
    expect(useStore.getState().scaleSelected(2)).toBe(0);
  });

  it('rotateSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    expect(useStore.getState().rotateSelected('z', 90)).toBe(0);
  });

  it('nudgeSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    expect(useStore.getState().nudgeSelected(1, 0, 0)).toBe(0);
  });

  it('duplicateSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    expect(useStore.getState().duplicateSelected()).toEqual([]);
  });

  it('setGridSize updates the snap step and rejects non-positive values', () => {
    useStore.getState().setGridSize(5);
    expect(useStore.getState().gridSize).toBe(5);
    useStore.getState().setGridSize(0); // invalid → falls back to 0.5
    expect(useStore.getState().gridSize).toBe(0.5);
  });

  it('selectAll selects every body', () => {
    useStore.getState().clearScene();
    const a = createBox(2, 2, 2); const b = createBox(3, 3, 3);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().selectAll();
    expect(useStore.getState().selectedIds.sort()).toEqual([a.id, b.id].sort());
  });

  it('isolateSelected hides all but the selection; showAllBodies restores', () => {
    useStore.getState().clearScene();
    const a = createBox(2, 2, 2); const b = createBox(3, 3, 3);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().selectObject(a.id);
    useStore.getState().isolateSelected();
    expect(useStore.getState().hiddenIds).toEqual([b.id]);
    useStore.getState().showAllBodies();
    expect(useStore.getState().hiddenIds).toEqual([]);
  });

  it('isolateSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    useStore.getState().isolateSelected();
    expect(useStore.getState().hiddenIds).toEqual([]);
  });

  it('toggleBodyVisibility hides and shows a body; clearScene resets', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    useStore.getState().toggleBodyVisibility(box.id);
    expect(useStore.getState().hiddenIds).toContain(box.id);
    useStore.getState().toggleBodyVisibility(box.id);
    expect(useStore.getState().hiddenIds).not.toContain(box.id);
    useStore.getState().toggleBodyVisibility(box.id);
    useStore.getState().clearScene();
    expect(useStore.getState().hiddenIds).toEqual([]);
  });

  it('setMoveDialogOpen toggles the move dialog flag', () => {
    expect(useStore.getState().moveDialogOpen).toBe(false);
    useStore.getState().setMoveDialogOpen(true);
    expect(useStore.getState().moveDialogOpen).toBe(true);
    useStore.getState().setMoveDialogOpen(false);
    expect(useStore.getState().moveDialogOpen).toBe(false);
  });

  it('setScaleDialogOpen toggles the scale dialog flag', () => {
    expect(useStore.getState().scaleDialogOpen).toBe(false);
    useStore.getState().setScaleDialogOpen(true);
    expect(useStore.getState().scaleDialogOpen).toBe(true);
    useStore.getState().setScaleDialogOpen(false);
    expect(useStore.getState().scaleDialogOpen).toBe(false);
  });

  it('setRotateDialogOpen toggles the rotate dialog flag', () => {
    expect(useStore.getState().rotateDialogOpen).toBe(false);
    useStore.getState().setRotateDialogOpen(true);
    expect(useStore.getState().rotateDialogOpen).toBe(true);
    useStore.getState().setRotateDialogOpen(false);
    expect(useStore.getState().rotateDialogOpen).toBe(false);
  });

  it('setShowGrid toggles the grid visibility flag (default on)', () => {
    expect(useStore.getState().showGrid).toBe(true);
    useStore.getState().setShowGrid(false);
    expect(useStore.getState().showGrid).toBe(false);
    useStore.getState().setShowGrid(true);
    expect(useStore.getState().showGrid).toBe(true);
  });

  it('setWireframe toggles the wireframe display flag', () => {
    expect(useStore.getState().wireframe).toBe(false);
    useStore.getState().setWireframe(true);
    expect(useStore.getState().wireframe).toBe(true);
    useStore.getState().setWireframe(false);
    expect(useStore.getState().wireframe).toBe(false);
  });

  it('setShowShortcuts toggles the shortcuts overlay flag', () => {
    expect(useStore.getState().showShortcuts).toBe(false);
    useStore.getState().setShowShortcuts(true);
    expect(useStore.getState().showShortcuts).toBe(true);
    useStore.getState().setShowShortcuts(false);
    expect(useStore.getState().showShortcuts).toBe(false);
  });

  it('hollowBodyById replaces a body with a lighter shell, keeping it selected', () => {
    useStore.getState().clearScene();
    const box = createBox(20, 20, 20); // vol 8000
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    const id = useStore.getState().hollowBodyById(box.id, 2);
    expect(id).toBeTruthy();
    expect(useStore.getState().selectedIds).toEqual([id]);
    const shell = useStore.getState().bodies.find((b) => b.id === id)!;
    expect(Math.abs(computeVolume(shell))).toBeLessThan(8000 * 0.75); // material removed
  });

  it('hollowBodyById returns null for a missing body or non-positive thickness', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().hollowBodyById('nope', 2)).toBeNull();
    expect(useStore.getState().hollowBodyById(box.id, 0)).toBeNull();
  });

  it('combineSelected unions the first two selected bodies into one', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }); // overlapping
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectObject(a.id);
    useStore.getState().toggleSelect(b.id);
    const id = useStore.getState().combineSelected('union');
    expect(id).toBeTruthy();
    expect(useStore.getState().bodies).toHaveLength(1); // a and b replaced by the union
    expect(useStore.getState().selectedIds).toEqual([id]);
  });

  it('combineSelected returns null with fewer than two selected', () => {
    useStore.getState().clearScene();
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().selectObject(a.id);
    expect(useStore.getState().combineSelected('union')).toBeNull();
  });

  it('toggleSelect adds and removes ids for multi-select', () => {
    useStore.getState().deselectAll();
    useStore.getState().toggleSelect('a');
    useStore.getState().toggleSelect('b');
    expect(useStore.getState().selectedIds).toEqual(['a', 'b']);
    useStore.getState().toggleSelect('a'); // remove
    expect(useStore.getState().selectedIds).toEqual(['b']);
    useStore.getState().selectObject('c'); // replaces
    expect(useStore.getState().selectedIds).toEqual(['c']);
  });

  it('measure tool: points accumulate to 3 then restart, and toggling off clears', () => {
    useStore.getState().setMeasureActive(true);
    useStore.getState().addMeasurePoint({ x: 0, y: 0, z: 0 });
    useStore.getState().addMeasurePoint({ x: 3, y: 4, z: 0 });
    useStore.getState().addMeasurePoint({ x: 6, y: 0, z: 0 });
    expect(useStore.getState().measurePts).toHaveLength(3);
    useStore.getState().addMeasurePoint({ x: 9, y: 9, z: 9 }); // fourth pick restarts
    expect(useStore.getState().measurePts).toEqual([{ x: 9, y: 9, z: 9 }]);
    useStore.getState().setMeasureActive(false);
    expect(useStore.getState().measurePts).toHaveLength(0);
  });

  it('resizeBodyTo rejects a missing body or non-positive dims', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().resizeBodyTo('nope', { x: 1, y: 1, z: 1 })).toBe(false);
    expect(useStore.getState().resizeBodyTo(box.id, { x: 0, y: 1, z: 1 })).toBe(false);
  });

  it('removeDirectBody clears its selection and marks the project dirty', () => {
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.setState({ projectDirty: false });

    useStore.getState().removeDirectBody(box.id);

    expect(useStore.getState().bodies).toHaveLength(0);
    expect(useStore.getState().selectedIds).not.toContain(box.id);
    expect(useStore.getState().projectDirty).toBe(true);
  });

  describe('datum planes', () => {
    beforeEach(() => useStore.getState().clearScene());

    it('ensureStandardPlanes seeds three planes once', () => {
      expect(useStore.getState().ensureStandardPlanes()).toBe(3);
      expect(useStore.getState().planes).toHaveLength(3);
      // Idempotent: a second call adds nothing.
      expect(useStore.getState().ensureStandardPlanes()).toBe(0);
      expect(useStore.getState().planes).toHaveLength(3);
    });

    it('addPlaneFromFace builds a datum on a body face and returns its id', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      const top = box.faces.find((f) => f.normal.y > 0.99)!;
      const id = useStore.getState().addPlaneFromFace(box.id, top.id, 2);
      expect(id).toBeTruthy();
      const plane = useStore.getState().planes.find((p) => p.id === id)!;
      expect(plane.normal.y).toBeCloseTo(1, 6);
      expect(plane.origin.y).toBeCloseTo(12, 4);
    });

    it('addPlaneFromFace returns null for an unknown body or face', () => {
      expect(useStore.getState().addPlaneFromFace('nope', 'x')).toBeNull();
    });

    it('addOffsetPlane offsets an existing plane', () => {
      useStore.getState().ensureStandardPlanes();
      const front = useStore.getState().planes[0]!;
      const id = useStore.getState().addOffsetPlane(front.id, 5);
      const off = useStore.getState().planes.find((p) => p.id === id)!;
      expect(off.origin.z).toBeCloseTo(front.origin.z + 5, 6);
      expect(useStore.getState().addOffsetPlane('nope', 5)).toBeNull();
    });

    it('addMidplane builds the mid-plane between two parallel faces', () => {
      const box = createBox(10, 20, 10);
      useStore.getState().addDirectBody(box);
      const top = box.faces.find((f) => f.normal.y > 0.99)!;
      const bottom = box.faces.find((f) => f.normal.y < -0.99)!;
      const id = useStore.getState().addMidplane(box.id, top.id, bottom.id);
      const mid = useStore.getState().planes.find((p) => p.id === id)!;
      expect(mid.origin.y).toBeCloseTo(10, 4);
    });

    it('splitBodyByPlane replaces a body with its two halves', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      useStore.getState().ensureStandardPlanes();
      // Top plane is the XZ plane (normal +Y) through the origin; offset it to the
      // body's mid-height so it actually cuts through the box (y ∈ [0,10]).
      const top = useStore.getState().planes.find((p) => p.normal.y > 0.99)!;
      const midId = useStore.getState().addOffsetPlane(top.id, 5)!;
      const ids = useStore.getState().splitBodyByPlane(box.id, midId);
      expect(ids).toHaveLength(2);
      expect(useStore.getState().bodies.find((b) => b.id === box.id)).toBeUndefined();
      for (const id of ids) expect(useStore.getState().bodies.find((b) => b.id === id)).toBeDefined();
    });

    it('splitBodyByPlane returns empty for an unknown body or plane', () => {
      expect(useStore.getState().splitBodyByPlane('nope', 'nope')).toEqual([]);
    });

    it('removePlane removes by id and clearScene wipes all planes', () => {
      useStore.getState().ensureStandardPlanes();
      const id = useStore.getState().planes[0]!.id;
      useStore.getState().removePlane(id);
      expect(useStore.getState().planes.find((p) => p.id === id)).toBeUndefined();
      expect(useStore.getState().planes).toHaveLength(2);
      useStore.getState().clearScene();
      expect(useStore.getState().planes).toHaveLength(0);
    });
  });

  describe('datum axes', () => {
    beforeEach(() => useStore.getState().clearScene());

    it('addAxisFromPlanes builds the intersection axis of two standard planes', () => {
      useStore.getState().ensureStandardPlanes();
      const [front, top] = useStore.getState().planes;
      const id = useStore.getState().addAxisFromPlanes(front!.id, top!.id);
      expect(id).toBeTruthy();
      const axis = useStore.getState().axes.find((a) => a.id === id)!;
      expect(Math.abs(axis.direction.x)).toBeCloseTo(1, 6); // Front ∩ Top = X axis
    });

    it('addAxisFromPlanes returns null for parallel or missing planes', () => {
      useStore.getState().ensureStandardPlanes();
      const front = useStore.getState().planes[0]!;
      const offsetId = useStore.getState().addOffsetPlane(front.id, 5)!;
      expect(useStore.getState().addAxisFromPlanes(front.id, offsetId)).toBeNull(); // parallel
      expect(useStore.getState().addAxisFromPlanes('nope', front.id)).toBeNull();
    });

    it('addAxisFromPoints builds an axis; null if coincident', () => {
      const id = useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
      expect(id).toBeTruthy();
      expect(useStore.getState().axes.find((a) => a.id === id)!.direction.z).toBeCloseTo(1, 6);
      expect(useStore.getState().addAxisFromPoints({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toBeNull();
    });

    it('circularPatternAboutAxis patterns a body around a datum axis', () => {
      const box = createBox(4, 4, 4);
      useStore.getState().addDirectBody(box);
      // Z axis through the origin.
      const axisId = useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })!;
      const ids = useStore.getState().circularPatternAboutAxis(box.id, axisId, 4);
      expect(ids).toHaveLength(4);
      // Original replaced by the 4 instances.
      expect(useStore.getState().bodies.find((b) => b.id === box.id)).toBeUndefined();
      for (const id of ids) expect(useStore.getState().bodies.find((b) => b.id === id)).toBeDefined();
    });

    it('circularPatternAboutAxis returns [] for an unknown body, axis or count', () => {
      const box = createBox(4, 4, 4);
      useStore.getState().addDirectBody(box);
      const axisId = useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })!;
      expect(useStore.getState().circularPatternAboutAxis('nope', axisId, 4)).toEqual([]);
      expect(useStore.getState().circularPatternAboutAxis(box.id, 'nope', 4)).toEqual([]);
      expect(useStore.getState().circularPatternAboutAxis(box.id, axisId, 0)).toEqual([]);
    });

    it('removeAxis removes by id and clearScene wipes all axes', () => {
      const id = useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })!;
      useStore.getState().removeAxis(id);
      expect(useStore.getState().axes).toHaveLength(0);
      useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      useStore.getState().clearScene();
      expect(useStore.getState().axes).toHaveLength(0);
    });
  });

  describe('datum points', () => {
    beforeEach(() => useStore.getState().clearScene());

    it('addPoint and addMidpoint store points', () => {
      useStore.getState().addPoint({ x: 1, y: 2, z: 3 });
      const midId = useStore.getState().addMidpoint({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
      expect(useStore.getState().points).toHaveLength(2);
      expect(useStore.getState().points.find((p) => p.id === midId)!.position.x).toBeCloseTo(2, 6);
    });

    it('addPointAtAxisPlane finds the pierce point of an axis through a plane', () => {
      // Z axis at (3,4) and the offset of the Top (XZ) plane... use a Z=7 plane via offset.
      const axisId = useStore.getState().addAxisFromPoints({ x: 3, y: 4, z: 0 }, { x: 3, y: 4, z: 1 })!;
      useStore.getState().ensureStandardPlanes();
      const front = useStore.getState().planes[0]!; // Front (XY), normal +Z, origin z=0
      const z7 = useStore.getState().addOffsetPlane(front.id, 7)!; // plane z=7
      const id = useStore.getState().addPointAtAxisPlane(axisId, z7);
      expect(id).toBeTruthy();
      const p = useStore.getState().points.find((pt) => pt.id === id)!;
      expect(p.position.x).toBeCloseTo(3, 6);
      expect(p.position.y).toBeCloseTo(4, 6);
      expect(p.position.z).toBeCloseTo(7, 6);
    });

    it('addPointAtAxisPlane returns null for missing ids or a parallel axis', () => {
      const xAxis = useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })!;
      useStore.getState().ensureStandardPlanes();
      const front = useStore.getState().planes[0]!; // z=0 plane; X axis lies in it → parallel
      expect(useStore.getState().addPointAtAxisPlane(xAxis, front.id)).toBeNull();
      expect(useStore.getState().addPointAtAxisPlane('nope', front.id)).toBeNull();
    });

    it('removePoint removes by id and clearScene wipes all points', () => {
      const id = useStore.getState().addPoint({ x: 0, y: 0, z: 0 });
      useStore.getState().removePoint(id);
      expect(useStore.getState().points).toHaveLength(0);
      useStore.getState().addPoint({ x: 1, y: 1, z: 1 });
      useStore.getState().clearScene();
      expect(useStore.getState().points).toHaveLength(0);
    });

    it('autosave + restoreAutosave preserves datum planes, axes, points and coordinate systems', () => {
      useStore.getState().clearScene();
      useStore.getState().ensureStandardPlanes();
      useStore.getState().addAxisFromPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      useStore.getState().addPoint({ x: 5, y: 6, z: 7 });
      useStore.getState().addCoordinateSystem({ x: 1, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
      expect(useStore.getState().autosave()).toBe(true);
      useStore.getState().clearScene();
      expect(useStore.getState().planes).toHaveLength(0);
      expect(useStore.getState().restoreAutosave()).toBe(true);
      expect(useStore.getState().planes).toHaveLength(3);
      expect(useStore.getState().axes).toHaveLength(1);
      expect(useStore.getState().points).toHaveLength(1);
      expect(useStore.getState().points[0]!.position).toEqual({ x: 5, y: 6, z: 7 });
      expect(useStore.getState().coordSystems).toHaveLength(1);
    });
  });

  describe('coordinate systems', () => {
    beforeEach(() => useStore.getState().clearScene());

    it('addCoordinateSystem stores an orthonormal frame; clearScene wipes it', () => {
      const id = useStore.getState().addCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 5, z: 0 });
      expect(id).toBeTruthy();
      const cs = useStore.getState().coordSystems.find((c) => c.id === id)!;
      expect(Math.hypot(cs.xAxis.x, cs.xAxis.y, cs.xAxis.z)).toBeCloseTo(1, 6);
      useStore.getState().clearScene();
      expect(useStore.getState().coordSystems).toHaveLength(0);
    });

    it('addCoordinateSystem returns null for parallel directions', () => {
      expect(useStore.getState().addCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 })).toBeNull();
    });

    it('removeCoordinateSystem removes by id', () => {
      const id = useStore.getState().addCoordinateSystem({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })!;
      useStore.getState().removeCoordinateSystem(id);
      expect(useStore.getState().coordSystems).toHaveLength(0);
    });

    it('placeBodyInCoordinateSystem rigidly relocates a body in place', () => {
      const box = createBox(10, 10, 10);
      useStore.getState().addDirectBody(box);
      const csId = useStore.getState().addCoordinateSystem({ x: 20, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })!;
      const newId = useStore.getState().placeBodyInCoordinateSystem(box.id, csId);
      expect(newId).toBeTruthy();
      const placed = useStore.getState().bodies.find((b) => b.id === newId)!;
      expect(Math.abs(computeVolume(placed))).toBeCloseTo(1000, 3); // rigid: volume preserved
      const minX = Math.min(...placed.vertices.map((v) => v.x));
      expect(minX).toBeCloseTo(15, 4); // -5 shifted by +20
    });

    it('placeBodyInCoordinateSystem returns null for a missing body or csys', () => {
      expect(useStore.getState().placeBodyInCoordinateSystem('nope', 'nope')).toBeNull();
    });
  });
});
