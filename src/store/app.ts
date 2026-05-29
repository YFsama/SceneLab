import { create } from 'zustand';
import type { Sketch } from '../lib/sketch/types';
import { addLine, addRectangle, addCircle, addArc, addConstraint } from '../lib/sketch/engine';
import type { Feature } from '../lib/features/types';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createRevolveFeature } from '../lib/features/tree';
import type { SolidBody } from '../lib/geometry/types';

export type ThemeMode = 'dark' | 'light' | 'high-contrast';
export type Locale = 'en' | 'zh';
export type WorkspaceMode = 'sketch' | 'model' | 'assembly' | 'drawing' | 'cam';
export type SketchTool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'constraint';
export type ViewDirection = 'top' | 'front' | 'right' | 'iso';
export type SketchPlaneId = 'xy' | 'xz' | 'yz';

interface AppState {
  // Theme & locale
  theme: ThemeMode;
  locale: Locale;
  setTheme: (t: ThemeMode) => void;
  setLocale: (l: Locale) => void;

  // Workspace
  workspace: WorkspaceMode;
  setWorkspace: (w: WorkspaceMode) => void;

  // Sketch
  sketchTool: SketchTool;
  setSketchTool: (t: SketchTool) => void;
  sketchActive: boolean;
  setSketchActive: (a: boolean) => void;
  currentSketch: Sketch | null;
  setCurrentSketch: (s: Sketch | null) => void;
  sketchPlaneId: SketchPlaneId;
  setSketchPlaneId: (p: SketchPlaneId) => void;

  // Sketch drawing
  drawStart: { x: number; y: number } | null;
  setDrawStart: (p: { x: number; y: number } | null) => void;
  addSketchLine: (x1: number, y1: number, x2: number, y2: number) => void;
  addSketchRect: (x1: number, y1: number, x2: number, y2: number) => void;
  addSketchCircle: (cx: number, cy: number, radius: number) => void;
  addSketchArc: (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => void;
  addSketchConstraint: (type: import('../lib/sketch/types').ConstraintType, entityIds: string[], value?: number) => void;

  // Feature tree
  featureTree: FeatureTree;
  addFeature: (feature: Feature) => void;
  removeFeature: (id: string) => void;
  updateFeature: (id: string, mutator: (f: Feature) => Feature) => void;
  recomputeTree: () => void;
  /** Combined render list: feature-tree bodies + direct bodies. */
  bodies: SolidBody[];
  /** Bodies created/edited outside the feature tree (AI primitives, arrays, …). */
  directBodies: SolidBody[];
  addDirectBody: (body: SolidBody) => void;
  addDirectBodies: (bodies: SolidBody[]) => void;
  replaceBody: (oldId: string, newBody: SolidBody) => void;
  removeDirectBody: (id: string) => void;

  // Extrude dialog
  showExtrudeDialog: boolean;
  setShowExtrudeDialog: (v: boolean) => void;
  performExtrude: (distance: number, symmetric: boolean) => void;
  performRevolve: (angle: number) => void;

  // Viewport
  viewDirection: ViewDirection;
  setViewDirection: (d: ViewDirection) => void;

  // Scene objects
  objectIds: string[];
  selectedIds: string[];
  addObject: (id: string) => void;
  selectObject: (id: string) => void;
  deselectAll: () => void;

  // Panels
  showBrowserTree: boolean;
  showProperties: boolean;
  toggleBrowserTree: () => void;
  toggleProperties: () => void;

  // Project
  projectName: string;
  setProjectName: (n: string) => void;
  projectDirty: boolean;
  setProjectDirty: (d: boolean) => void;
}

export const useStore = create<AppState>((set, get) => {
  // Rebuild the render list from the feature tree (minus hidden bodies) plus
  // any direct bodies, keeping objectIds in sync. Called after every change
  // that affects geometry.
  const recombine = () => {
    const { featureTree, directBodies } = get();
    const bodies = [...featureTree.getLatestBodies(), ...directBodies];
    set({ bodies, objectIds: bodies.map((b) => b.id) });
  };

  return {
  theme: 'dark',
  locale: 'en',
  setTheme: (theme) => set({ theme }),
  setLocale: (locale) => set({ locale }),

  workspace: 'model',
  setWorkspace: (workspace) => set({ workspace }),

  sketchTool: 'select',
  setSketchTool: (sketchTool) => set({ sketchTool }),
  sketchActive: false,
  setSketchActive: (sketchActive) => set({ sketchActive }),
  currentSketch: null,
  setCurrentSketch: (currentSketch) => set({ currentSketch }),
  sketchPlaneId: 'xy',
  setSketchPlaneId: (sketchPlaneId) => set({ sketchPlaneId }),

  drawStart: null,
  setDrawStart: (drawStart) => set({ drawStart }),

  addSketchLine: (x1, y1, x2, y2) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    addLine(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  addSketchRect: (x1, y1, x2, y2) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    addRectangle(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  addSketchCircle: (cx, cy, radius) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    addCircle(sketch, cx, cy, radius);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  addSketchArc: (cx, cy, radius, startAngle, endAngle) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    addArc(sketch, cx, cy, radius, startAngle, endAngle);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  addSketchConstraint: (type, entityIds, value) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    addConstraint(sketch, type, entityIds, value);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  featureTree: new FeatureTree(),
  bodies: [],
  directBodies: [],
  addFeature: (feature) => {
    const tree = get().featureTree;
    tree.addFeature(feature);
    tree.recompute();
    set({ featureTree: tree, projectDirty: true });
    recombine();
  },
  removeFeature: (id) => {
    const tree = get().featureTree;
    tree.removeFeature(id);
    tree.recompute();
    set({ featureTree: tree, projectDirty: true });
    recombine();
  },
  updateFeature: (id, mutator) => {
    const tree = get().featureTree;
    tree.updateFeature(id, mutator);
    tree.recompute();
    set({ featureTree: tree, projectDirty: true });
    recombine();
  },
  recomputeTree: () => {
    get().featureTree.recompute();
    recombine();
  },

  addDirectBody: (body) => {
    set((s) => ({ directBodies: [...s.directBodies, body], projectDirty: true }));
    recombine();
  },
  addDirectBodies: (newBodies) => {
    set((s) => ({ directBodies: [...s.directBodies, ...newBodies], projectDirty: true }));
    recombine();
  },
  replaceBody: (oldId, newBody) => {
    const { directBodies } = get();
    if (directBodies.some((b) => b.id === oldId)) {
      // Stable case: editing a direct body replaces it in place.
      set({ directBodies: directBodies.map((b) => (b.id === oldId ? newBody : b)), projectDirty: true });
    } else {
      // Editing a (transient) feature-tree body: keep the edit as a direct body.
      // A recompute regenerates tree bodies with fresh ids, so we cannot stably
      // hide the original here — the proper path for tree bodies is a feature.
      set({ directBodies: [...directBodies, newBody], projectDirty: true });
    }
    recombine();
  },
  removeDirectBody: (id) => {
    set((s) => ({ directBodies: s.directBodies.filter((b) => b.id !== id) }));
    recombine();
  },

  showExtrudeDialog: false,
  setShowExtrudeDialog: (showExtrudeDialog) => set({ showExtrudeDialog }),

  performExtrude: (distance, symmetric) => {
    const sketch = get().currentSketch;
    if (!sketch) return;

    // Create features
    const sketchFeat = createSketchFeature(sketch);
    const extrudeFeat = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance, symmetric },
      [sketchFeat.id],
    );

    // Batch all updates into a single set() call
    const tree = get().featureTree;
    tree.addFeature(sketchFeat);
    tree.addFeature(extrudeFeat);
    tree.recompute();

    set({
      featureTree: tree,
      sketchActive: false,
      currentSketch: null,
      workspace: 'model',
      showExtrudeDialog: false,
      projectDirty: true,
    });
    recombine();
  },

  performRevolve: (angle) => {
    const sketch = get().currentSketch;
    if (!sketch) return;

    const sketchFeat = createSketchFeature(sketch);
    const revolveFeat = createRevolveFeature(angle, [sketchFeat.id]);

    const tree = get().featureTree;
    tree.addFeature(sketchFeat);
    tree.addFeature(revolveFeat);
    tree.recompute();

    set({
      featureTree: tree,
      sketchActive: false,
      currentSketch: null,
      workspace: 'model',
      projectDirty: true,
    });
    recombine();
  },

  viewDirection: 'iso',
  setViewDirection: (viewDirection) => set({ viewDirection }),

  objectIds: [],
  selectedIds: [],
  addObject: (id) => set((s) => ({ objectIds: [...s.objectIds, id] })),
  selectObject: (id) => set({ selectedIds: [id] }),
  deselectAll: () => set({ selectedIds: [] }),

  showBrowserTree: true,
  showProperties: true,
  toggleBrowserTree: () => set((s) => ({ showBrowserTree: !s.showBrowserTree })),
  toggleProperties: () => set((s) => ({ showProperties: !s.showProperties })),

  projectName: 'Untitled',
  setProjectName: (projectName) => set({ projectName }),
  projectDirty: false,
  setProjectDirty: (projectDirty) => set({ projectDirty }),
  };
});
