import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree, createExtrudeFeature, createSketchFeature } from '../lib/features/tree';
import { createBox, computeVolume } from '../lib/geometry';
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
});
