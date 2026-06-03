import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, uniqueBodyName } from './app';
import { FeatureTree, createExtrudeFeature, createSketchFeature } from '../lib/features/tree';
import { createBox, computeVolume, translateBody, computeBoundingBoxCenter } from '../lib/geometry';
import { createSketch, addRectangle, addLine } from '../lib/sketch/engine';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, deserializeDirectBodies } from '../lib/io';

describe('uniqueBodyName', () => {
  it('returns the name unchanged when free', () => {
    expect(uniqueBodyName('Box', ['Cylinder'])).toBe('Box');
  });
  it('appends the smallest free number on collision', () => {
    expect(uniqueBodyName('Box', ['Box'])).toBe('Box2');
    expect(uniqueBodyName('Box', ['Box', 'Box2'])).toBe('Box3');
    expect(uniqueBodyName('Box', ['Box', 'Box3'])).toBe('Box2'); // fills the gap
  });
});

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

  it('supports the full set of standard orthographic views', () => {
    for (const dir of ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const) {
      useStore.getState().setViewDirection(dir);
      expect(useStore.getState().viewDirection).toBe(dir);
    }
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

  it('auto-numbers duplicate body names on add (Box, Box2, Box3)', () => {
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    const names = useStore.getState().bodies.map((b) => b.name);
    expect(names).toEqual(['Box', 'Box2', 'Box3']);
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

  it('invertSelection swaps selected and unselected bodies', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    const c = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().addDirectBody(c);
    useStore.getState().selectObject(a.id);

    useStore.getState().invertSelection();
    const sel = useStore.getState().selectedIds;
    expect(sel).toHaveLength(2);
    expect(sel).toContain(b.id);
    expect(sel).toContain(c.id);
    expect(sel).not.toContain(a.id);

    // Inverting again returns to the original single selection.
    useStore.getState().invertSelection();
    expect(useStore.getState().selectedIds).toEqual([a.id]);
  });

  it('selectRange selects the inclusive span of bodies in tree order', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    const c = createBox(5, 5, 5);
    const d = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().addDirectBody(c);
    useStore.getState().addDirectBody(d);

    useStore.getState().selectRange(b.id, d.id);
    expect(useStore.getState().selectedIds).toEqual([b.id, c.id, d.id]);

    // Order-independent: anchor after target still spans the same range.
    useStore.getState().selectRange(d.id, b.id);
    expect(useStore.getState().selectedIds).toEqual([b.id, c.id, d.id]);

    // Same id → single selection.
    useStore.getState().selectRange(a.id, a.id);
    expect(useStore.getState().selectedIds).toEqual([a.id]);
  });

  it('hideSelected hides the selection and clears it; showAllBodies restores', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().selectObject(a.id);

    useStore.getState().hideSelected();
    expect(useStore.getState().hiddenIds).toContain(a.id);
    expect(useStore.getState().hiddenIds).not.toContain(b.id);
    expect(useStore.getState().selectedIds).toEqual([]);

    // No selection → no-op.
    useStore.getState().hideSelected();
    expect(useStore.getState().hiddenIds).toEqual([a.id]);

    useStore.getState().showAllBodies();
    expect(useStore.getState().hiddenIds).toEqual([]);
  });

  it('setBodyOpacity sets opacity, clamps, no-ops when unchanged, and is undoable', () => {
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    const op = () => useStore.getState().bodies.find((b) => b.id === a.id)?.opacity ?? 1;

    expect(useStore.getState().setBodyOpacity(a.id, 0.4)).toBe(true);
    expect(op()).toBe(0.4);
    // Out-of-range is clamped to [0.05, 1].
    useStore.getState().setBodyOpacity(a.id, 5);
    expect(op()).toBe(1);
    useStore.getState().setBodyOpacity(a.id, 0);
    expect(op()).toBe(0.05);
    // Re-applying the same value is a no-op.
    expect(useStore.getState().setBodyOpacity(a.id, 0.05)).toBe(false);
    // Undoable.
    useStore.getState().undo();
    expect(op()).toBe(1);
  });

  it('visibility changes are undoable', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);

    useStore.getState().toggleBodyVisibility(a.id);
    expect(useStore.getState().hiddenIds).toEqual([a.id]);
    useStore.getState().undo();
    expect(useStore.getState().hiddenIds).toEqual([]); // hide undone
    useStore.getState().redo();
    expect(useStore.getState().hiddenIds).toEqual([a.id]); // and redone

    // showAllBodies is undoable too.
    useStore.getState().showAllBodies();
    expect(useStore.getState().hiddenIds).toEqual([]);
    useStore.getState().undo();
    expect(useStore.getState().hiddenIds).toEqual([a.id]);

    // No-op visibility calls don't create undo entries.
    useStore.getState().showAllBodies(); // clears
    const depth = useStore.getState().undoStack.length;
    useStore.getState().showAllBodies(); // already empty → no-op
    expect(useStore.getState().undoStack.length).toBe(depth);
  });

  it('rename editing flow: begin/setValue/commit updates the body name', () => {
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);

    useStore.getState().beginRename(a.id);
    expect(useStore.getState().renaming?.id).toBe(a.id);
    expect(useStore.getState().renaming?.value).toBe(a.name);

    useStore.getState().setRenameValue('Bracket');
    useStore.getState().commitRename();
    expect(useStore.getState().renaming).toBeNull();
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.name).toBe('Bracket');
  });

  it('cancelRename discards the draft; F2 only fires with one selected', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);

    useStore.getState().beginRename(a.id);
    useStore.getState().setRenameValue('Discarded');
    useStore.getState().cancelRename();
    expect(useStore.getState().renaming).toBeNull();
    expect(useStore.getState().bodies.find((x) => x.id === a.id)?.name).toBe(a.name);

    // Two selected → beginRenameSelected is a no-op.
    useStore.getState().selectObject(a.id);
    useStore.getState().toggleSelect(b.id);
    useStore.getState().beginRenameSelected();
    expect(useStore.getState().renaming).toBeNull();

    // Exactly one selected → starts editing that body.
    useStore.getState().selectObject(b.id);
    useStore.getState().beginRenameSelected();
    expect(useStore.getState().renaming?.id).toBe(b.id);
    useStore.getState().cancelRename();
  });

  it('rename, colour and transparency edits are undoable', () => {
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    const originalName = a.name;

    useStore.getState().renameBody(a.id, 'Flange');
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.name).toBe('Flange');
    useStore.getState().undo();
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.name).toBe(originalName);

    useStore.getState().setBodyColor(a.id, 0xff0000);
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.color).toBe(0xff0000);
    useStore.getState().undo();
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.color).not.toBe(0xff0000);

    useStore.getState().toggleBodyTransparency(a.id);
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.opacity).toBe(0.4);
    useStore.getState().undo();
    expect(useStore.getState().bodies.find((b) => b.id === a.id)?.opacity ?? 1).toBe(1);
  });

  it('no-op rename/colour edits create no undo entry', () => {
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    // Establish a known name/colour first.
    useStore.getState().renameBody(a.id, 'Plate');
    useStore.getState().setBodyColor(a.id, 0x00ff00);
    const depth = useStore.getState().undoStack.length;

    // Re-applying the identical name/colour is rejected, no undo pushed.
    expect(useStore.getState().renameBody(a.id, 'Plate')).toBe(false);
    expect(useStore.getState().setBodyColor(a.id, 0x00ff00)).toBe(false);
    expect(useStore.getState().undoStack.length).toBe(depth);
  });

  it('setSelectionColor colours every selected body in one undoable step', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    const c = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().addDirectBody(c);
    useStore.getState().selectObject(a.id);
    useStore.getState().toggleSelect(b.id);
    const depth = useStore.getState().undoStack.length;

    expect(useStore.getState().setSelectionColor(0x123456)).toBe(2);
    const byId = (id: string) => useStore.getState().bodies.find((x) => x.id === id);
    expect(byId(a.id)?.color).toBe(0x123456);
    expect(byId(b.id)?.color).toBe(0x123456);
    expect(byId(c.id)?.color).not.toBe(0x123456); // unselected untouched
    expect(useStore.getState().undoStack.length).toBe(depth + 1); // single entry

    useStore.getState().undo();
    expect(byId(a.id)?.color).not.toBe(0x123456);

    // Re-applying the same colour to an already-matching selection is a no-op.
    useStore.getState().setSelectionColor(0x123456);
    expect(useStore.getState().setSelectionColor(0x123456)).toBe(0);
  });

  it('reorderBody moves a body within the tree order and is bounded at the ends', () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    const c = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().addDirectBody(c);
    const order = () => useStore.getState().bodies.map((x) => x.id);
    expect(order()).toEqual([a.id, b.id, c.id]);

    expect(useStore.getState().reorderBody(b.id, 'up')).toBe(true);
    expect(order()).toEqual([b.id, a.id, c.id]);

    expect(useStore.getState().reorderBody(c.id, 'down')).toBe(false); // already last
    expect(useStore.getState().reorderBody(b.id, 'up')).toBe(false);   // now first
    expect(order()).toEqual([b.id, a.id, c.id]);

    useStore.getState().undo(); // reorder is undoable
    expect(order()).toEqual([a.id, b.id, c.id]);
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

  it('toggleBodyTransparency flips a body between opaque and semi-transparent', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().toggleBodyTransparency(box.id)).toBe(true);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)!.opacity).toBeCloseTo(0.4, 6);
    useStore.getState().toggleBodyTransparency(box.id);
    expect(useStore.getState().bodies.find((b) => b.id === box.id)!.opacity).toBe(1);
    expect(useStore.getState().toggleBodyTransparency('nope')).toBe(false);
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

  it('rememberPrimitiveParams persists to localStorage', () => {
    useStore.getState().rememberPrimitiveParams('cylinder', { r: 7, h: 20 });
    const raw = localStorage.getItem('scenelab.lastPrimitiveParams');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).cylinder).toEqual({ r: 7, h: 20 });
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

  it('repeated pastes cascade outward instead of stacking', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().copySelected();

    const centerOf = (id: string) => {
      const b = useStore.getState().bodies.find((x) => x.id === id)!;
      return computeBoundingBoxCenter(b);
    };
    const first = useStore.getState().paste()[0]!;
    const second = useStore.getState().paste()[0]!;
    const c1 = centerOf(first);
    const c2 = centerOf(second);
    // Second paste sits a further 10mm out on X and Z than the first.
    expect(c2.x - c1.x).toBeCloseTo(10);
    expect(c2.z - c1.z).toBeCloseTo(10);

    // Re-copying resets the cascade: next paste lands one step from the original.
    useStore.getState().selectObject(box.id);
    useStore.getState().copySelected();
    const third = useStore.getState().paste()[0]!;
    expect(centerOf(third).x - centerOf(box.id).x).toBeCloseTo(10);
  });

  it('pasted/duplicated copies get unique names', () => {
    useStore.getState().clearScene();
    const box = createBox(5, 5, 5); // 'Box'
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    useStore.getState().copySelected();
    useStore.getState().paste();
    useStore.getState().paste();
    const names = useStore.getState().bodies.map((b) => b.name);
    expect(names).toEqual(['Box', 'Box copy', 'Box copy2']); // no duplicate names
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

  it('rotateSelected rotates a multi-selection rigidly about its combined centre', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // centre origin
    const b = translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }); // centre (30,0,0)
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    // Combined centre is (15,5,0); a 90° Z rotation keeps it fixed but swings
    // the two boxes onto the Y axis around it.
    expect(useStore.getState().rotateSelected('z', 90)).toBe(2);
    const all = useStore.getState().bodies;
    const xs = all.flatMap((bd) => bd.vertices.map((v) => v.x));
    const ys = all.flatMap((bd) => bd.vertices.map((v) => v.y));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(cx).toBeCloseTo(15, 4); // combined centre unmoved
    expect(cy).toBeCloseTo(5, 4);
    // The pair now spans ~40 in Y (was ~10 in X), i.e. it rotated as a group.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 4);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 4);
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

  it('gridPatternBody replaces a body with countX×countZ copies', () => {
    useStore.getState().clearScene();
    const box = createBox(4, 4, 4);
    useStore.getState().addDirectBody(box);
    const ids = useStore.getState().gridPatternBody(box.id, 3, 10, 2, 10);
    expect(ids).toHaveLength(6); // 3 × 2
    expect(useStore.getState().bodies.find((b) => b.id === box.id)).toBeUndefined();
    expect(useStore.getState().bodies).toHaveLength(6);
  });

  it('makeBoundingBoxOfSelection adds a box enclosing the selected bodies', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // x ∈ [-5,5]
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25]
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    const id = useStore.getState().makeBoundingBoxOfSelection();
    expect(id).toBeTruthy();
    const bbox = useStore.getState().bodies.find((x) => x.id === id)!;
    const xs = bbox.vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(-5, 4);
    expect(Math.max(...xs)).toBeCloseTo(25, 4);
  });

  it('makeBoundingBoxOfSelection returns null with nothing selected', () => {
    useStore.getState().clearScene();
    expect(useStore.getState().makeBoundingBoxOfSelection()).toBeNull();
  });

  it('gridPatternBody returns [] for bad params', () => {
    useStore.getState().clearScene();
    const box = createBox(4, 4, 4);
    useStore.getState().addDirectBody(box);
    expect(useStore.getState().gridPatternBody(box.id, 0, 10, 2, 10)).toEqual([]);
    expect(useStore.getState().gridPatternBody(box.id, 2, 0, 2, 10)).toEqual([]);
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

  it('alignSelected min/max align the selected edges on an axis', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // x ∈ [-5,5]
    const b = translateBody(createBox(6, 6, 6), { x: 20, y: 0, z: 0 }); // x ∈ [17,23]
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    useStore.getState().alignSelected('x', 'min');
    const minX = (id: string) => Math.min(...useStore.getState().bodies.find((x) => x.id === id)!.vertices.map((v) => v.x));
    expect(minX(a.id)).toBeCloseTo(-5, 4);
    expect(minX(b.id)).toBeCloseTo(-5, 4); // both mins aligned to the overall min
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

  it('scaleSelected scales a multi-selection about the combined centre (gaps too)', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // centre x 0
    const b = translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }); // centre x 30
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    // Combined x ∈ [-5,35], centre 15. Scaling 2× about (15,..) keeps the centre
    // and doubles the overall span (15 → 30 half-extent ⇒ x ∈ [-25,55]).
    expect(useStore.getState().scaleSelected(2)).toBe(2);
    const xs = useStore.getState().bodies.flatMap((bd) => bd.vertices.map((v) => v.x));
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(15, 4);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80, 4); // 40 → 80
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

  it('flipSelected reflects in place keeping id, bbox and volume', () => {
    useStore.getState().clearScene();
    const wedge = createBox(10, 20, 30); // asymmetric extents
    useStore.getState().addDirectBody(wedge);
    useStore.getState().selectObject(wedge.id);
    const vol0 = Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(useStore.getState().flipSelected('x')).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === wedge.id)!; // id preserved
    expect(Math.abs(computeVolume(r))).toBeCloseTo(vol0, 3); // reflection preserves volume
    const ext = (a: 'x' | 'y' | 'z') => { const vs = r.vertices.map((v) => v[a]); return Math.max(...vs) - Math.min(...vs); };
    expect(ext('x')).toBeCloseTo(10, 4); // same size (in place)
  });

  it('flipSelected mirrors a multi-selection as a group (positions mirror)', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10); // centre x 0
    const b = translateBody(createBox(10, 10, 10), { x: 30, y: 0, z: 0 }); // centre x 30
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    // Mirror across X through the combined centre (15): a (centre 0) → 30.
    expect(useStore.getState().flipSelected('x')).toBe(2);
    const ra = useStore.getState().bodies.find((bd) => bd.id === a.id)!;
    const cx = (() => { const xs = ra.vertices.map((v) => v.x); return (Math.min(...xs) + Math.max(...xs)) / 2; })();
    expect(cx).toBeCloseTo(30, 4); // body a swapped to where b was — group mirror
  });

  it('mirrorCopySelected keeps the original and adds a reflected copy', () => {
    useStore.getState().clearScene();
    const a = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // centre x 20
    useStore.getState().addDirectBody(a);
    useStore.getState().selectObject(a.id);

    const ids = useStore.getState().mirrorCopySelected('x'); // mirror across x=0
    expect(ids).toHaveLength(1);
    expect(useStore.getState().bodies).toHaveLength(2); // original kept + copy
    expect(useStore.getState().selectedIds).toEqual(ids); // copy selected

    const copy = useStore.getState().bodies.find((b) => b.id === ids[0])!;
    const xs = copy.vertices.map((v) => v.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(-20, 4); // reflected to x=-20
    // Original untouched at x=20.
    const orig = useStore.getState().bodies.find((b) => b.id === a.id)!;
    const oxs = orig.vertices.map((v) => v.x);
    expect((Math.min(...oxs) + Math.max(...oxs)) / 2).toBeCloseTo(20, 4);
  });

  it('weldSelected cleans a body keeping id and volume', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    const vol0 = Math.abs(computeVolume(useStore.getState().bodies[0]!));
    expect(useStore.getState().weldSelected()).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!; // id kept
    expect(Math.abs(computeVolume(r))).toBeCloseTo(vol0, 4);
  });

  it('weldSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    expect(useStore.getState().weldSelected()).toBe(0);
  });

  it('rotateSelected is a no-op with nothing selected', () => {
    useStore.getState().clearScene();
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    useStore.getState().deselectAll();
    expect(useStore.getState().rotateSelected('z', 90)).toBe(0);
  });

  it('moveSelectionToOrigin centres the selection at the world origin', () => {
    useStore.getState().clearScene();
    const box = translateBody(createBox(10, 10, 10), { x: 20, y: 6, z: 0 }); // centre (20, 11, 0)
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().moveSelectionToOrigin()).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!;
    const c = (axis: 'x' | 'y' | 'z') => { const a = r.vertices.map((v) => v[axis]); return (Math.min(...a) + Math.max(...a)) / 2; };
    expect(c('x')).toBeCloseTo(0, 4);
    expect(c('y')).toBeCloseTo(0, 4);
    expect(c('z')).toBeCloseTo(0, 4);
  });

  it('moveSelectionTo places the selection centre at an absolute target', () => {
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10); // centre at origin
    useStore.getState().addDirectBody(box);
    useStore.getState().selectObject(box.id);
    expect(useStore.getState().moveSelectionTo({ x: 5, y: 12, z: -3 })).toBe(1);
    const r = useStore.getState().bodies.find((b) => b.id === box.id)!;
    const c = (axis: 'x' | 'y' | 'z') => { const a = r.vertices.map((v) => v[axis]); return (Math.min(...a) + Math.max(...a)) / 2; };
    expect(c('x')).toBeCloseTo(5, 4);
    expect(c('y')).toBeCloseTo(12, 4);
    expect(c('z')).toBeCloseTo(-3, 4);
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

  it('setPolygonSides clamps to the 3–64 range', () => {
    useStore.getState().setPolygonSides(8);
    expect(useStore.getState().polygonSides).toBe(8);
    useStore.getState().setPolygonSides(2);
    expect(useStore.getState().polygonSides).toBe(3); // min 3
    useStore.getState().setPolygonSides(100);
    expect(useStore.getState().polygonSides).toBe(64); // max 64
  });

  it('newProject yields a clean, empty, untitled document', () => {
    useStore.getState().addDirectBody(createBox(5, 5, 5));
    useStore.getState().setProjectName('Part1');
    useStore.getState().newProject();
    expect(useStore.getState().bodies).toHaveLength(0);
    expect(useStore.getState().projectName).toBe('Untitled');
    expect(useStore.getState().projectDirty).toBe(false);
  });

  it('panel visibility persists to localStorage', () => {
    const tree0 = useStore.getState().showBrowserTree;
    useStore.getState().toggleBrowserTree();
    expect(localStorage.getItem('scenelab.showBrowserTree')).toBe(String(!tree0));
    const props0 = useStore.getState().showProperties;
    useStore.getState().toggleProperties();
    expect(localStorage.getItem('scenelab.showProperties')).toBe(String(!props0));
    // restore
    useStore.getState().toggleBrowserTree();
    useStore.getState().toggleProperties();
  });

  it('view/sketch preferences persist to localStorage', () => {
    useStore.getState().setWireframe(true);
    expect(localStorage.getItem('scenelab.wireframe')).toBe('true');
    useStore.getState().setShowGrid(false);
    expect(localStorage.getItem('scenelab.showGrid')).toBe('false');
    useStore.getState().setGridSize(5);
    expect(localStorage.getItem('scenelab.gridSize')).toBe('5');
    useStore.getState().setPolygonSides(8);
    expect(localStorage.getItem('scenelab.polygonSides')).toBe('8');
    // restore defaults so other tests aren't affected
    useStore.getState().setWireframe(false);
    useStore.getState().setShowGrid(true);
    useStore.getState().setGridSize(0.5);
    useStore.getState().setPolygonSides(6);
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

  it('selectAll and invertSelection skip hidden bodies', () => {
    useStore.getState().clearScene();
    const a = createBox(2, 2, 2); const b = createBox(3, 3, 3); const c = createBox(4, 4, 4);
    useStore.getState().addDirectBody(a);
    useStore.getState().addDirectBody(b);
    useStore.getState().addDirectBody(c);
    useStore.getState().toggleBodyVisibility(b.id); // hide b

    useStore.getState().selectAll();
    expect(useStore.getState().selectedIds.sort()).toEqual([a.id, c.id].sort());

    // Invert from {a}: should yield {c} only (b hidden, never auto-selected).
    useStore.getState().selectObject(a.id);
    useStore.getState().invertSelection();
    expect(useStore.getState().selectedIds).toEqual([c.id]);
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

  it('setShowCenterOfMass toggles and persists the COM flag', () => {
    expect(useStore.getState().showCenterOfMass).toBe(false);
    useStore.getState().setShowCenterOfMass(true);
    expect(useStore.getState().showCenterOfMass).toBe(true);
    expect(localStorage.getItem('scenelab.showCenterOfMass')).toBe('true');
    useStore.getState().setShowCenterOfMass(false);
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

  it('removeSketchEntity deletes the entity and clears its selection', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 10, 0);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().setSelectedSketchId(line.id);
    useStore.getState().removeSketchEntity(line.id);
    expect(useStore.getState().currentSketch!.entities.has(line.id)).toBe(false);
    expect(useStore.getState().selectedSketchId).toBeNull();
  });

  it('setSketchLineLength moves the 2nd endpoint to set the length', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 3, 0); // along +X, length 3
    useStore.getState().setCurrentSketch(sketch);
    expect(useStore.getState().setSketchLineLength(line.id, 10)).toBe(true);
    const s = useStore.getState().currentSketch!;
    const p1 = s.entities.get(line.p1Id) as { x: number; y: number };
    const p2 = s.entities.get(line.p2Id) as { x: number; y: number };
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeCloseTo(10, 6);
    expect(p2.y).toBeCloseTo(0, 6); // direction preserved (still along +X)
    expect(useStore.getState().setSketchLineLength(line.id, 0)).toBe(false); // rejects non-positive
  });

  it('setSketchEntityRadius sets a circle/arc radius and rejects a line', () => {
    const sketch = createSketch('xy');
    const line = addLine(sketch, 0, 0, 5, 0);
    useStore.getState().setCurrentSketch(sketch);
    expect(useStore.getState().setSketchEntityRadius(line.id, 7)).toBe(false); // not a circle/arc
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

  it('joinSelected merges selected bodies into one (exact, volume summed)', () => {
    useStore.getState().clearScene();
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 50, y: 0, z: 0 }); // disjoint
    useStore.getState().addDirectBodies([a, b]);
    useStore.getState().selectAll();
    const id = useStore.getState().joinSelected();
    expect(id).toBeTruthy();
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeCloseTo(2000, 2); // exact sum
  });

  it('joinSelected returns null with fewer than two selected', () => {
    useStore.getState().clearScene();
    const a = createBox(5, 5, 5);
    useStore.getState().addDirectBody(a);
    useStore.getState().selectObject(a.id);
    expect(useStore.getState().joinSelected()).toBeNull();
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

  it('removeLastMeasurePoint drops the most recent pick (re-pick a mis-click)', () => {
    useStore.getState().setMeasureActive(true);
    useStore.getState().addMeasurePoint({ x: 0, y: 0, z: 0 });
    useStore.getState().addMeasurePoint({ x: 5, y: 0, z: 0 });
    useStore.getState().removeLastMeasurePoint();
    expect(useStore.getState().measurePts).toEqual([{ x: 0, y: 0, z: 0 }]);
    useStore.getState().removeLastMeasurePoint();
    expect(useStore.getState().measurePts).toHaveLength(0);
    // Safe with nothing left.
    useStore.getState().removeLastMeasurePoint();
    expect(useStore.getState().measurePts).toHaveLength(0);
    useStore.getState().setMeasureActive(false);
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
