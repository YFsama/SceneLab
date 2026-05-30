import { create } from 'zustand';
import type { Sketch } from '../lib/sketch/types';
import { addLine, addRectangle, addCircle, addArc, addConstraint } from '../lib/sketch/engine';
import type { Feature } from '../lib/features/types';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createRevolveFeature } from '../lib/features/tree';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, deserializeDirectBodies } from '../lib/io';
import type { SolidBody, PlaneDefinition } from '../lib/geometry/types';
import { standardPlanes, planeFromFace, offsetPlane, midplaneBetweenFaces } from '../lib/geometry/referenceGeometry';
import { splitByPlane } from '../lib/geometry/boolean';

const AUTOSAVE_KEY = 'scenelab.autosave';
import {
  createBox,
  createCylinder,
  createSphere,
  createCone,
  createTorus,
  createWedge,
  createPrism,
  createTube,
  createCoil,
} from '../lib/geometry/brep';

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'wedge' | 'prism' | 'tube' | 'coil';

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
  addSketchLine: (x1: number, y1: number, x2: number, y2: number) => string;
  addSketchRect: (x1: number, y1: number, x2: number, y2: number) => string;
  addSketchCircle: (cx: number, cy: number, radius: number) => string;
  addSketchArc: (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => string;
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
  /** Create a default-sized primitive of `kind`, add it, and return its id. */
  addPrimitive: (kind: PrimitiveKind) => string;
  replaceBody: (oldId: string, newBody: SolidBody) => void;
  removeDirectBody: (id: string) => void;
  /** Delete all currently-selected direct bodies; returns how many were removed. */
  deleteSelected: () => number;
  /** Undo/redo history for scene-body edits (create/transform/delete). */
  undoStack: SolidBody[][];
  redoStack: SolidBody[][];
  /** Revert the last scene-body change; returns true if something was undone. */
  undo: () => boolean;
  /** Re-apply the last undone change; returns true if something was redone. */
  redo: () => boolean;
  clearScene: () => void;
  loadProject: (features: Feature[], name?: string, directBodies?: SolidBody[]) => void;

  // Reference geometry — datum planes (SolidWorks Front/Top/Right + custom).
  planes: PlaneDefinition[];
  /** Add a datum plane to the scene; returns its id. */
  addPlane: (plane: PlaneDefinition) => string;
  /** Seed the three standard datum planes if none exist; returns how many were added. */
  ensureStandardPlanes: () => number;
  /** Datum plane coincident with a body face (offset along its normal); null if the face is missing. */
  addPlaneFromFace: (bodyId: string, faceId: string, offset?: number) => string | null;
  /** Datum plane parallel to an existing plane, offset along its normal; null if the source plane is missing. */
  addOffsetPlane: (planeId: string, distance: number) => string | null;
  /** Mid-plane between two parallel faces of a body; null if faces are missing or not parallel. */
  addMidplane: (bodyId: string, faceIdA: string, faceIdB: string) => string | null;
  removePlane: (id: string) => void;
  /** Split a body by a datum plane into its two halves; returns the new body ids (empty if it failed). */
  splitBodyByPlane: (bodyId: string, planeId: string) => string[];

  // Extrude dialog
  showExtrudeDialog: boolean;
  setShowExtrudeDialog: (v: boolean) => void;
  showRevolveDialog: boolean;
  setShowRevolveDialog: (v: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
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
  /** Serialize the project to localStorage if dirty; returns true if it saved. */
  autosave: () => boolean;
  /** Restore the last autosaved project; returns true if one was loaded. */
  restoreAutosave: () => boolean;
  /** Whether an autosave snapshot exists to restore. */
  hasAutosave: () => boolean;
}

export const useStore = create<AppState>((set, get) => {
  // Rebuild the render list from the feature tree (minus hidden bodies) plus
  // any direct bodies, keeping objectIds in sync. Called after every change
  // that affects geometry.
  const persist = (key: string, value: string) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  };
  const stored = (key: string): string | null =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;

  const recombine = () => {
    const { featureTree, directBodies } = get();
    const bodies = [...featureTree.getLatestBodies(), ...directBodies];
    set({ bodies, objectIds: bodies.map((b) => b.id) });
  };

  // Snapshot the current direct bodies onto the undo stack before a mutation,
  // clearing the redo stack (a new edit invalidates the redo branch). Capped so
  // history can't grow without bound.
  const pushUndo = () => {
    set((s) => ({ undoStack: [...s.undoStack, s.directBodies].slice(-50), redoStack: [] }));
  };

  return {
  theme: (stored('scenelab.theme') as ThemeMode) ?? 'dark',
  locale: (stored('scenelab.locale') as Locale) ?? 'en',
  setTheme: (theme) => {
    set({ theme });
    persist('scenelab.theme', theme);
  },
  setLocale: (locale) => {
    set({ locale });
    persist('scenelab.locale', locale);
  },

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
    if (!sketch) return '';
    const e = addLine(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
  },

  addSketchRect: (x1, y1, x2, y2) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    const e = addRectangle(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    // A rectangle is decomposed into lines; return the first edge's id.
    return e.lines[0]?.id ?? '';
  },

  addSketchCircle: (cx, cy, radius) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    const e = addCircle(sketch, cx, cy, radius);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
  },

  addSketchArc: (cx, cy, radius, startAngle, endAngle) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    const e = addArc(sketch, cx, cy, radius, startAngle, endAngle);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
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
    pushUndo();
    set((s) => ({ directBodies: [...s.directBodies, body], projectDirty: true }));
    recombine();
  },
  addPrimitive: (kind) => {
    // Sensible default dimensions (mm) so a single click/call yields a usable part.
    const body = ((): SolidBody => {
      switch (kind) {
        case 'box': return createBox(20, 20, 20);
        case 'cylinder': return createCylinder(10, 20);
        case 'sphere': return createSphere(10);
        case 'cone': return createCone(10, 0, 20);
        case 'torus': return createTorus(10, 3);
        case 'wedge': return createWedge(20, 20, 20);
        case 'prism': return createPrism(6, 10, 20);
        case 'tube': return createTube(10, 6, 20);
        case 'coil': return createCoil(10, 2, 6, 3);
      }
    })();
    get().addDirectBody(body);
    return body.id;
  },
  addDirectBodies: (newBodies) => {
    pushUndo();
    set((s) => ({ directBodies: [...s.directBodies, ...newBodies], projectDirty: true }));
    recombine();
  },
  replaceBody: (oldId, newBody) => {
    pushUndo();
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
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.filter((b) => b.id !== id),
      // Drop any stale selection of the removed body and mark the edit, like
      // every other mutation, so unsaved-changes tracking stays consistent.
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
      projectDirty: true,
    }));
    recombine();
  },
  deleteSelected: () => {
    const { selectedIds, directBodies } = get();
    if (selectedIds.length === 0) return 0;
    const selected = new Set(selectedIds);
    const remaining = directBodies.filter((b) => !selected.has(b.id));
    const removed = directBodies.length - remaining.length;
    if (removed === 0) return 0; // only feature-tree bodies selected — not deletable here
    pushUndo();
    set((s) => ({
      directBodies: remaining,
      selectedIds: s.selectedIds.filter((id) => !selected.has(id)),
      projectDirty: true,
    }));
    recombine();
    return removed;
  },
  undoStack: [],
  redoStack: [],
  undo: () => {
    const { undoStack, directBodies } = get();
    if (undoStack.length === 0) return false;
    const prev = undoStack[undoStack.length - 1]!;
    set((s) => ({
      directBodies: prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, directBodies],
      selectedIds: [],
      projectDirty: true,
    }));
    recombine();
    return true;
  },
  redo: () => {
    const { redoStack, directBodies } = get();
    if (redoStack.length === 0) return false;
    const next = redoStack[redoStack.length - 1]!;
    set((s) => ({
      directBodies: next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, directBodies],
      selectedIds: [],
      projectDirty: true,
    }));
    recombine();
    return true;
  },
  clearScene: () => {
    set({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      planes: [],
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
      projectDirty: true,
    });
  },
  loadProject: (features, name, directBodies = []) => {
    const tree = new FeatureTree();
    for (const f of features) tree.addFeature(f);
    tree.recompute();
    set({
      featureTree: tree,
      directBodies,
      selectedIds: [],
      planes: [],
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
      projectName: name ?? get().projectName,
      projectDirty: false,
    });
    recombine();
  },

  planes: [],
  addPlane: (plane) => {
    set((s) => ({ planes: [...s.planes, plane], projectDirty: true }));
    return plane.id;
  },
  ensureStandardPlanes: () => {
    if (get().planes.length > 0) return 0;
    const std = standardPlanes();
    set({ planes: std, projectDirty: true });
    return std.length;
  },
  addPlaneFromFace: (bodyId, faceId, offset = 0) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body) return null;
    const plane = planeFromFace(body, faceId, offset);
    if (!plane) return null;
    return get().addPlane(plane);
  },
  addOffsetPlane: (planeId, distance) => {
    const src = get().planes.find((p) => p.id === planeId);
    if (!src) return null;
    return get().addPlane(offsetPlane(src, distance));
  },
  addMidplane: (bodyId, faceIdA, faceIdB) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body) return null;
    const plane = midplaneBetweenFaces(body, faceIdA, faceIdB);
    if (!plane) return null;
    return get().addPlane(plane);
  },
  removePlane: (id) => set((s) => ({ planes: s.planes.filter((p) => p.id !== id), projectDirty: true })),
  splitBodyByPlane: (bodyId, planeId) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    const plane = get().planes.find((p) => p.id === planeId);
    if (!body || !plane) return [];
    const { positive, negative } = splitByPlane(body, plane);
    const halves = [positive, negative].filter((h): h is NonNullable<typeof h> => h !== null);
    if (halves.length === 0) return [];
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => b.id !== bodyId), ...halves],
      selectedIds: [],
      projectDirty: true,
    }));
    recombine();
    return halves.map((h) => h.id);
  },

  showExtrudeDialog: false,
  setShowExtrudeDialog: (showExtrudeDialog) => set({ showExtrudeDialog }),
  showRevolveDialog: false,
  setShowRevolveDialog: (showRevolveDialog) => set({ showRevolveDialog }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),

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
      showRevolveDialog: false,
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

  autosave: () => {
    if (typeof localStorage === 'undefined') return false;
    const { projectDirty, projectName, featureTree, directBodies } = get();
    if (!projectDirty) return false;
    try {
      const project = serializeProject(projectName, featureTree.features, [], directBodies);
      localStorage.setItem(AUTOSAVE_KEY, saveToFile(project));
      return true;
    } catch {
      return false;
    }
  },
  restoreAutosave: () => {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    try {
      const project = loadFromFile(raw);
      get().loadProject(deserializeFeatures(project), project.name, deserializeDirectBodies(project));
      return true;
    } catch {
      return false;
    }
  },
  hasAutosave: () => typeof localStorage !== 'undefined' && localStorage.getItem(AUTOSAVE_KEY) !== null,
  };
});
