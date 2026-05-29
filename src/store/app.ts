import { create } from 'zustand';
import type { Sketch } from '../lib/sketch/types';
import { addLine, addRectangle, addCircle, addArc, addConstraint } from '../lib/sketch/engine';
import type { Feature } from '../lib/features/types';
import { FeatureTree, createSketchFeature, createExtrudeFeature } from '../lib/features/tree';
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
  recomputeTree: () => void;
  bodies: SolidBody[];

  // Extrude dialog
  showExtrudeDialog: boolean;
  setShowExtrudeDialog: (v: boolean) => void;
  performExtrude: (distance: number, symmetric: boolean) => void;

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

export const useStore = create<AppState>((set, get) => ({
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
  addFeature: (feature) => {
    const tree = get().featureTree;
    tree.addFeature(feature);
    tree.recompute();
    set({
      featureTree: tree,
      bodies: tree.getLatestBodies(),
      objectIds: tree.getLatestBodies().map((b) => b.id),
      projectDirty: true,
    });
  },
  removeFeature: (id) => {
    const tree = get().featureTree;
    tree.removeFeature(id);
    tree.recompute();
    const latestBodies = tree.getLatestBodies();
    set({
      featureTree: tree,
      bodies: latestBodies,
      objectIds: latestBodies.map((b) => b.id),
      projectDirty: true,
    });
  },
  recomputeTree: () => {
    const tree = get().featureTree;
    tree.recompute();
    const latestBodies = tree.getLatestBodies();
    set({
      bodies: latestBodies,
      objectIds: latestBodies.map((b) => b.id),
    });
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

    const latestBodies = tree.getLatestBodies();
    set({
      featureTree: tree,
      bodies: latestBodies,
      objectIds: latestBodies.map((b) => b.id),
      sketchActive: false,
      currentSketch: null,
      workspace: 'model',
      showExtrudeDialog: false,
      projectDirty: true,
    });
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
}));
