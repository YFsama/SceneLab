import { create } from 'zustand';
import type { Sketch } from '../lib/sketch/types';
import { addLine, addRectangle, addCircle, addArc, addPolygon, addConstraint, removeEntity, pointIdsOf, cloneSketch, detectRectangle, resizeRectangle, filletSketchCorner as filletCorner, type DetectedRectangle } from '../lib/sketch/engine';
import type { Feature } from '../lib/features/types';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createRevolveFeature, createSweepFeature, createLoftFeature, createFilletFeature, createChamferFeature, createShellFeature, createLinearArrayFeature, createCircularArrayFeature, createMirrorFeature } from '../lib/features/tree';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, deserializeDirectBodies, deserializeReferenceGeometry, type SerializedReferenceGeometry } from '../lib/io';
import type { SolidBody, PlaneDefinition, Vec3 } from '../lib/geometry/types';
import { standardPlanes, planeFromFace, offsetPlane, midplaneBetweenFaces, axisFromPlanes, axisFromPoints, makePoint, midpoint, pointAtAxisPlaneIntersection, makeCoordinateSystem, type AxisDefinition, type PointDefinition, type CoordinateSystemDefinition, type AnnotationDefinition } from '../lib/geometry/referenceGeometry';
import { splitByPlane, asyncBooleanOp, asyncHollowBody, type BooleanOp } from '../lib/geometry/boolean';
import { applyCircularArray, applyLinearArray, applyGridArray, applyMirror, applyFillet, applyChamfer, applyShell, placeBodyInFrame, resizeBody, translateBody, rotateBody, scaleBody, scaleBodyXYZ, mergeBodies, weldVertices } from '../lib/geometry/operations';
import { computeBoundingBoxCenter } from '../lib/geometry/brep';
import { isTauri, callNative } from '../lib/runtime';

const AUTOSAVE_KEY = 'scenelab.autosave';

/**
 * Make `name` unique against `existing` by appending the smallest free number
 * (Box → Box2 → Box3 …) — like SolidWorks auto-numbering features so multiple
 * inserts of the same primitive are distinguishable in the tree. An
 * already-unique name is returned unchanged.
 */
export function uniqueBodyName(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  let n = 2;
  while (existing.includes(`${name}${n}`)) n++;
  return `${name}${n}`;
}

/** Give each body a name unique against `existing` and the others in the batch. */
function withUniqueNames<T extends { name: string }>(bodies: T[], existing: string[]): T[] {
  const taken = [...existing];
  return bodies.map((b) => {
    const name = uniqueBodyName(b.name, taken);
    taken.push(name);
    return name === b.name ? b : { ...b, name };
  });
}
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
  createBoundingBoxBody,
} from '../lib/geometry/brep';

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'wedge' | 'prism' | 'tube' | 'coil';

export type ThemeMode = 'dark' | 'light' | 'high-contrast';
export type Locale = 'en' | 'zh';
export type WorkspaceMode = 'sketch' | 'model' | 'drawing' | 'cam';
export type SketchTool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'polyline' | 'constraint';
export type ViewDirection = 'top' | 'front' | 'right' | 'iso' | 'back' | 'bottom' | 'left';
export type ProjectionMode = 'perspective' | 'orthographic';
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
  /** Leave sketch mode cleanly: stop drawing, reset the tool, return to the model workspace. */
  exitSketch: () => void;
  currentSketch: Sketch | null;
  setCurrentSketch: (s: Sketch | null) => void;
  /** Sketch-scoped undo/redo history (separate from the body undo stack). */
  sketchUndoStack: Sketch[];
  sketchRedoStack: Sketch[];
  sketchUndo: () => boolean;
  sketchRedo: () => boolean;
  sketchPlaneId: SketchPlaneId;
  setSketchPlaneId: (p: SketchPlaneId) => void;
  /** Grid/snap step in mm for sketch drawing. */
  gridSize: number;
  setGridSize: (mm: number) => void;
  /** Number of sides for the polygon sketch tool. */
  polygonSides: number;
  setPolygonSides: (n: number) => void;

  // Sketch drawing
  drawStart: { x: number; y: number } | null;
  setDrawStart: (p: { x: number; y: number } | null) => void;
  /** Last committed point in a polyline chain (null when not chaining). */
  polylineLast: { x: number; y: number } | null;
  setPolylineLast: (p: { x: number; y: number } | null) => void;
  addSketchLine: (x1: number, y1: number, x2: number, y2: number) => string;
  addSketchRect: (x1: number, y1: number, x2: number, y2: number) => string;
  addSketchCircle: (cx: number, cy: number, radius: number) => string;
  addSketchArc: (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => string;
  /** Add a regular polygon (sides line segments) centred at (cx,cy). */
  addSketchPolygon: (cx: number, cy: number, radius: number, sides: number) => void;
  addSketchConstraint: (type: import('../lib/sketch/types').ConstraintType, entityIds: string[], value?: number) => void;
  /** Currently-selected sketch entity (for highlight/deletion); null if none. */
  selectedSketchId: string | null;
  setSelectedSketchId: (id: string | null) => void;
  /** All currently-selected sketch entities (Ctrl/Shift+click multi-select, used for multi-entity constraints). */
  selectedSketchIds: string[];
  /** Toggle an entity in the multi-selection; it becomes the primary selection. */
  toggleSketchSelection: (id: string) => void;
  /** Remove a sketch entity from the current sketch. */
  removeSketchEntity: (id: string) => void;
  /** Set a sketch line's length by moving its 2nd endpoint along the line; false if not a line. */
  setSketchLineLength: (id: string, length: number) => boolean;
  /** Set a sketch circle/arc's radius; false if the entity isn't a circle or arc. */
  setSketchEntityRadius: (id: string, radius: number) => boolean;
  /** Set a sketch line's angle (deg from +X) by rotating its 2nd endpoint about the 1st. */
  setSketchLineAngle: (id: string, deg: number) => boolean;
  /** Translate a sketch entity's points by (dx, dy); false if it has no movable points. */
  nudgeSketchEntity: (id: string, dx: number, dy: number) => boolean;
  /** Toggle the construction flag on a sketch entity (excluded from extrude/revolve profiles). */
  toggleSketchConstruction: (id: string) => void;
  /** 2D corner fillet between two lines: trim to the tangent points + arc. */
  filletSketchCorner: (lineAId: string, lineBId: string, radius: number) => boolean;
  /** Detect if a sketch line is part of a rectangle pattern. */
  detectSketchRectangle: (lineId: string) => DetectedRectangle | null;
  /** Resize a detected rectangle (keeping first corner fixed). */
  resizeSketchRectangle: (lineId: string, newWidth: number, newHeight: number) => void;

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
  /** Resize a body to exact X/Y/Z extents (mm), keeping it selected; false if missing or invalid. */
  resizeBodyTo: (bodyId: string, target: Vec3) => boolean;
  /** Rename a (direct) body; returns false if the id isn't a direct body or the name is blank. */
  renameBody: (id: string, name: string) => boolean;
  /** In-progress tree rename ({ id, draft value }); null when not renaming. */
  renaming: { id: string; value: string } | null;
  beginRename: (id: string) => void;
  /** Start renaming the single selected body (F2); no-op unless exactly one is selected. */
  beginRenameSelected: () => void;
  setRenameValue: (value: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  /** Set a (direct) body's display colour (0xRRGGBB); returns false if the id isn't a direct body. */
  setBodyColor: (id: string, color: number) => boolean;
  /** Set a (direct) body's material key (mass/density); false if unchanged or not a direct body. */
  setBodyMaterial: (id: string, material: string) => boolean;
  /** Set the colour of every selected direct body in one undoable step; returns how many changed. */
  setSelectionColor: (color: number) => number;
  /** Set the material of every selected direct body in one undoable step; returns how many changed. */
  setSelectionMaterial: (material: string) => number;
  /** Move a direct body one slot earlier/later in the tree order; false at the ends. */
  reorderBody: (id: string, direction: 'up' | 'down') => boolean;
  /** Toggle a (direct) body between opaque and semi-transparent; returns false if missing. */
  toggleBodyTransparency: (id: string) => boolean;
  /** Set a (direct) body's opacity (0.05–1) in one undoable step; false if unchanged/missing. */
  setBodyOpacity: (id: string, opacity: number) => boolean;
  /** Ids of bodies hidden from the viewport (still listed in the tree). */
  hiddenIds: string[];
  /** Show/hide a body in the viewport. */
  toggleBodyVisibility: (id: string) => void;
  /** Hide every body except the selection (SolidWorks Isolate); no-op if nothing selected. */
  isolateSelected: () => void;
  hideSelected: () => void;
  /** Unhide all bodies. */
  showAllBodies: () => void;
  removeDirectBody: (id: string) => void;
  /** Delete all currently-selected direct bodies; returns how many were removed. */
  deleteSelected: () => number;
  /** Duplicate the selected direct bodies (offset copies, keeping colour); selects and returns the new ids. */
  duplicateSelected: () => string[];
  /** Translate the selected direct bodies by an offset in place (keeps ids); returns how many moved. */
  nudgeSelected: (dx: number, dy: number, dz: number) => number;
  /** Move the selection so its combined bounding-box centre sits at the world origin; returns count. */
  moveSelectionToOrigin: () => number;
  /** Move the selection so its bounding-box centre sits at `target`; returns moved count. */
  moveSelectionTo: (target: Vec3) => number;
  /** Rotate the selected direct bodies about their own centre (keeps ids); returns how many rotated. */
  rotateSelected: (axis: 'x' | 'y' | 'z', degrees: number) => number;
  /** Uniformly scale the selected direct bodies about their own centre (keeps ids); returns how many scaled. */
  scaleSelected: (factor: number) => number;
  scaleSelectedXYZ: (fx: number, fy: number, fz: number) => number;
  /** Reflect the selected direct bodies in place about their own centre plane (keeps ids); returns count. */
  flipSelected: (axis: 'x' | 'y' | 'z') => number;
  /** Mirror the selection across the world datum plane (axis-normal), keeping the
   * originals and adding the reflected copies; returns the new ids. */
  mirrorCopySelected: (axis: 'x' | 'y' | 'z') => string[];
  /** Weld near-coincident vertices of the selected direct bodies (mesh cleanup, keeps ids); returns count. */
  weldSelected: () => number;
  /** Add a box enclosing the selected bodies' combined bounding box; returns its id or null. */
  makeBoundingBoxOfSelection: (margin?: number) => string | null;
  /** Align selected direct bodies along an axis by min/center/max (keeps ids); returns how many moved. */
  alignSelected: (axis: 'x' | 'y' | 'z', mode: 'min' | 'center' | 'max') => number;
  /** Evenly space selected direct bodies along an axis (by centre, ends fixed); needs >=3. Returns count. */
  distributeSelected: (axis: 'x' | 'y' | 'z') => number;
  /** Drop each selected direct body onto the build plate (its min Y to 0); returns how many moved. */
  dropSelectedToFloor: () => number;
  /** Body + mode awaiting the pattern dialog (null = closed). */
  pendingPattern: { bodyId: string; mode: 'linear' | 'circular' | 'grid' } | null;
  setPendingPattern: (p: { bodyId: string; mode: 'linear' | 'circular' | 'grid' } | null) => void;
  /** Whether the precise-move (ΔX/ΔY/ΔZ) dialog is open. */
  moveDialogOpen: boolean;
  setMoveDialogOpen: (v: boolean) => void;
  /** Whether the precise-rotate (axis + angle) dialog is open. */
  rotateDialogOpen: boolean;
  setRotateDialogOpen: (v: boolean) => void;
  /** Whether the scale-by-factor dialog is open. */
  scaleDialogOpen: boolean;
  setScaleDialogOpen: (v: boolean) => void;
  /** Body awaiting the hollow (shell) dialog (null = closed). */
  hollowDialogBody: string | null;
  setHollowDialogBody: (bodyId: string | null) => void;
  /** Hollow a body into a shell of the given wall thickness, replacing it; null if it failed. */
  hollowBodyById: (bodyId: string, wallThickness: number) => Promise<string | null>;
  /** Linear-pattern a body along an axis, replacing it with the copies; returns the new ids. */
  linearPatternBody: (bodyId: string, axis: 'x' | 'y' | 'z', count: number, spacing: number) => string[];
  /** Circular-pattern a body around the world axis through the origin; returns the new ids. */
  circularPatternBody: (bodyId: string, axis: 'x' | 'y' | 'z', count: number) => string[];
  /** 2D grid-pattern a body on the ground plane (X × Z), replacing it; returns the new ids. */
  gridPatternBody: (bodyId: string, countX: number, spacingX: number, countZ: number, spacingZ: number) => string[];
  /** Clipboard of copied bodies. */
  clipboard: SolidBody[];
  /** Number of pastes since the last copy, so repeated pastes cascade. */
  pasteCount: number;
  /** Copy the selected direct bodies to the clipboard; returns how many were copied. */
  copySelected: () => number;
  /** Copy the selection to the clipboard then delete it (undoable); returns how many. */
  cutSelected: () => number;
  /** Paste the clipboard as offset copies, select them; returns the new ids. */
  paste: () => string[];
  /** Undo/redo history for scene-body edits (create/transform/delete). */
  undoStack: { directBodies: SolidBody[]; hiddenIds: string[] }[];
  redoStack: { directBodies: SolidBody[]; hiddenIds: string[] }[];
  /** Revert the last scene-body change; returns true if something was undone. */
  undo: () => boolean;
  /** Re-apply the last undone change; returns true if something was redone. */
  redo: () => boolean;
  clearScene: () => void;
  /** Start a fresh, clean, untitled document (empties everything). */
  newProject: () => void;
  loadProject: (features: Feature[], name?: string, directBodies?: SolidBody[], referenceGeometry?: SerializedReferenceGeometry) => void;

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

  // Reference geometry — datum axes.
  axes: AxisDefinition[];
  /** Add a datum axis to the scene; returns its id. */
  addAxis: (axis: AxisDefinition) => string;
  /** Datum axis at the intersection of two datum planes; null if missing or parallel. */
  addAxisFromPlanes: (planeIdA: string, planeIdB: string) => string | null;
  /** Datum axis through two points; null if the points coincide. */
  addAxisFromPoints: (p1: Vec3, p2: Vec3) => string | null;
  removeAxis: (id: string) => void;
  /** Circular-pattern a body around a stored datum axis; returns the new body ids ([] on failure). */
  circularPatternAboutAxis: (bodyId: string, axisId: string, count: number) => string[];

  // Reference geometry — datum points.
  points: PointDefinition[];
  /** Add a datum point to the scene; returns its id. */
  addPoint: (position: Vec3, name?: string) => string;
  /** Datum point at the midpoint of two points; returns its id. */
  addMidpoint: (p1: Vec3, p2: Vec3) => string;
  /** Datum point where a datum axis pierces a datum plane; null if missing or parallel. */
  addPointAtAxisPlane: (axisId: string, planeId: string) => string | null;
  removePoint: (id: string) => void;

  // Reference geometry — coordinate systems.
  coordSystems: CoordinateSystemDefinition[];
  /** Add a coordinate system (origin + primary/secondary directions); null if the directions are parallel. */
  addCoordinateSystem: (origin: Vec3, primary: Vec3, secondary: Vec3, name?: string) => string | null;
  removeCoordinateSystem: (id: string) => void;

  // Persistent measurement annotations.
  annotations: AnnotationDefinition[];
  addAnnotation: (a: AnnotationDefinition) => void;
  removeAnnotation: (id: string) => void;
  /** Place a body into a coordinate system's frame (rigid transform), replacing it; null if missing. */
  placeBodyInCoordinateSystem: (bodyId: string, csId: string) => string | null;
  /** Split a body by a datum plane into its two halves; returns the new body ids (empty if it failed). */
  splitBodyByPlane: (bodyId: string, planeId: string) => string[];
  /** Boolean-combine the first two selected direct bodies (a op b), replacing them; null if it failed. */
  combineSelected: (op: BooleanOp) => Promise<string | null>;
  /** Merge the selected direct bodies into one mesh (no boolean — exact, for disjoint parts); null if <2. */
  joinSelected: () => string | null;

  // Extrude dialog
  showExtrudeDialog: boolean;
  setShowExtrudeDialog: (v: boolean) => void;
  showRevolveDialog: boolean;
  setShowRevolveDialog: (v: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
  /** Whether the keyboard-shortcuts help overlay is open. */
  showShortcuts: boolean;
  setShowShortcuts: (v: boolean) => void;
  /** Render bodies as wireframe instead of shaded. */
  wireframe: boolean;
  setWireframe: (v: boolean) => void;
  /** Whether the ground grid is shown. */
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
  /** Whether to mark the centre of mass of selected bodies. */
  showCenterOfMass: boolean;
  setShowCenterOfMass: (v: boolean) => void;
  /** Primitive kind awaiting a size dialog before insertion (null = no dialog open). */
  pendingPrimitive: PrimitiveKind | null;
  setPendingPrimitive: (k: PrimitiveKind | null) => void;
  /** Last command for Enter-to-repeat (e.g. last primitive kind inserted). */
  lastCommand: { type: 'primitive'; kind: PrimitiveKind } | null;
  repeatLastCommand: () => void;
  /** Last dimensions used per primitive kind, so the insert dialog reuses them. */
  lastPrimitiveParams: Partial<Record<PrimitiveKind, Record<string, number>>>;
  rememberPrimitiveParams: (kind: PrimitiveKind, params: Record<string, number>) => void;
  /** Measure tool: when on, clicking points in the viewport measures distance. */
  measureActive: boolean;
  setMeasureActive: (v: boolean) => void;
  /** Points picked by the measure tool (0–3); a fourth pick restarts. */
  measurePts: Vec3[];
  addMeasurePoint: (p: Vec3) => void;
  /** Drop the most recent measure point (Backspace), to re-pick a mis-click. */
  removeLastMeasurePoint: () => void;
  performExtrude: (distance: number, symmetric: boolean) => void;
  performRevolve: (angle: number) => void;
  /**
   * Sweep the current sketch along a straight path (its extrude direction) with
   * an accumulated twist, producing a parametric sweep feature — a twisted
   * column that a plain extrude can't make.
   */
  performSweep: (distance: number, twistDegrees: number) => void;

  // Modify features (Fusion-style: parametric on tree bodies, direct edit with
  // undo on AI/imported bodies). Each returns false when nothing is selected.
  applyFilletFeature: (radius: number) => boolean;
  applyChamferFeature: (distance: number) => boolean;
  applyShellFeature: (thickness: number) => boolean;
  /** Linear array along a world axis. */
  applyLinearArrayFeature: (count: number, spacing: number, axis: 'x' | 'y' | 'z') => boolean;
  /** Circular array about the world Z axis through the body's bounding-box centre. */
  applyCircularArrayFeature: (count: number) => boolean;
  /** Mirror across a world plane through the body's bounding-box centre. */
  applyMirrorFeature: (plane: 'xy' | 'xz' | 'yz', keepOriginal: boolean) => boolean;
  /**
   * Loft between two or more existing sketch features (Fusion loft sections):
   * adds a loft feature parenting those sketches, in the given order. False
   * when fewer than two of the ids resolve to sketch features.
   */
  performLoftFromSketches: (sketchFeatureIds: string[]) => boolean;

  // Viewport
  viewDirection: ViewDirection;
  setViewDirection: (d: ViewDirection) => void;
  projection: ProjectionMode;
  setProjection: (p: ProjectionMode) => void;
  toggleProjection: () => void;

  // Scene objects
  objectIds: string[];
  selectedIds: string[];
  selectedFaceIds: string[];
  setSelectedFaceIds: (ids: string[]) => void;
  /** CAD edge sub-selection (Alt+click) — scopes fillet/chamfer features. */
  selectedEdgeIds: string[];
  setSelectedEdgeIds: (ids: string[]) => void;
  addObject: (id: string) => void;
  selectObject: (id: string) => void;
  /** Set the selection to exactly the given ids (box-select, etc.). */
  setSelectedIds: (ids: string[]) => void;
  /** Toggle a body in/out of the current selection (Ctrl/⌘-click multi-select). */
  toggleSelect: (id: string) => void;
  /** Select every body in the scene (Ctrl+A). */
  selectAll: () => void;
  deselectAll: () => void;
  /** Body currently under the cursor (viewport or tree), for shared pre-highlight. */
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
  invertSelection: () => void;
  selectRange: (fromId: string, toId: string) => void;

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
    set((s) => ({ undoStack: [...s.undoStack, { directBodies: s.directBodies, hiddenIds: s.hiddenIds }].slice(-50), redoStack: [] }));
  };
  // Separate history for sketch edits — Ctrl+Z while sketching undoes the sketch.
  const pushSketchUndo = () => {
    const s = get().currentSketch;
    if (s) set((st) => ({ sketchUndoStack: [...st.sketchUndoStack, cloneSketch(s)].slice(-50), sketchRedoStack: [] }));
  };

  /** The first selected body, or undefined. */
  const selectedBody = (): SolidBody | undefined => {
    const s = get();
    const id = s.selectedIds[0];
    return id ? s.bodies.find((b) => b.id === id) : undefined;
  };
  /**
   * Edge ids from the Alt+click sub-selection that live on the selected body —
   * fillet/chamfer scope to these when any are picked (SolidWorks edge
   * fillets). Returns [] (= every edge) when nothing edge-scoped is selected.
   */
  const scopedEdgeIdsFor = (body: SolidBody): string[] => {
    const sel = get().selectedEdgeIds;
    if (sel.length === 0) return [];
    const ids = body.edges.filter((e) => sel.includes(e.id)).map((e) => e.id);
    return ids.length > 0 ? ids : [];
  };
  const scopedEdgeIds = (): string[] => {
    const body = selectedBody();
    return body ? scopedEdgeIdsFor(body) : [];
  };
  const axisDirection = (axis: 'x' | 'y' | 'z'): Vec3 =>
    axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const planeNormal = (plane: 'xy' | 'xz' | 'yz'): Vec3 =>
    plane === 'xy' ? { x: 0, y: 0, z: 1 } : plane === 'xz' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  /**
   * Run a modify feature on the current selection: parametric (a child feature
   * the tree replays on recompute) when the body came from the tree, otherwise
   * an undoable direct edit. `replaceDirect` false keeps the original direct
   * body and adds the results alongside it (mirror with keepOriginal).
   */
  const applyModifyFeature = (
    buildFeature: (parentIds: string[]) => Feature,
    directOp: (body: SolidBody) => SolidBody | SolidBody[],
    replaceDirect = true,
  ): boolean => {
    const body = selectedBody();
    if (!body) return false;
    const tree = get().featureTree;
    const parentId = tree.findFeatureIdForBody(body.id);
    if (parentId) {
      tree.addFeature(buildFeature([parentId]));
      tree.recompute();
      set({ featureTree: tree, projectDirty: true });
      recombine();
      return true;
    }
    pushUndo();
    const out = directOp(body);
    const results = Array.isArray(out) ? out : [out];
    set((s) => ({
      directBodies: replaceDirect
        ? s.directBodies.flatMap((b) => (b.id === body.id ? results : [b]))
        : [...s.directBodies, ...results],
    }));
    recombine();
    return true;
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
  exitSketch: () => set({ sketchActive: false, sketchTool: 'select', drawStart: null, polylineLast: null, selectedSketchId: null, selectedSketchIds: [], workspace: 'model' }),
  currentSketch: null,
  // Starting/exiting a sketch begins a fresh edit history.
  setCurrentSketch: (currentSketch) => set({ currentSketch, sketchUndoStack: [], sketchRedoStack: [] }),
  sketchUndoStack: [],
  sketchRedoStack: [],
  sketchUndo: () => {
    const { sketchUndoStack, currentSketch } = get();
    if (sketchUndoStack.length === 0 || !currentSketch) return false;
    const prev = sketchUndoStack[sketchUndoStack.length - 1]!;
    set((s) => ({
      currentSketch: prev,
      sketchUndoStack: s.sketchUndoStack.slice(0, -1),
      sketchRedoStack: [...s.sketchRedoStack, cloneSketch(currentSketch)],
      selectedSketchId: null,
      selectedSketchIds: [],
      projectDirty: true,
    }));
    return true;
  },
  sketchRedo: () => {
    const { sketchRedoStack, currentSketch } = get();
    if (sketchRedoStack.length === 0 || !currentSketch) return false;
    const next = sketchRedoStack[sketchRedoStack.length - 1]!;
    set((s) => ({
      currentSketch: next,
      sketchRedoStack: s.sketchRedoStack.slice(0, -1),
      sketchUndoStack: [...s.sketchUndoStack, cloneSketch(currentSketch)],
      selectedSketchId: null,
      selectedSketchIds: [],
      projectDirty: true,
    }));
    return true;
  },
  sketchPlaneId: 'xy',
  setSketchPlaneId: (sketchPlaneId) => set({ sketchPlaneId }),
  gridSize: Number(stored('scenelab.gridSize')) || 0.5,
  setGridSize: (gridSize) => { const v = gridSize > 0 ? gridSize : 0.5; set({ gridSize: v }); persist('scenelab.gridSize', String(v)); },
  polygonSides: Number(stored('scenelab.polygonSides')) || 6,
  setPolygonSides: (n) => { const v = Math.max(3, Math.min(64, Math.floor(n) || 3)); set({ polygonSides: v }); persist('scenelab.polygonSides', String(v)); },

  drawStart: null,
  setDrawStart: (drawStart) => set({ drawStart }),
  polylineLast: null,
  setPolylineLast: (polylineLast) => set({ polylineLast }),

  addSketchLine: (x1, y1, x2, y2) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    pushSketchUndo();
    const e = addLine(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
  },

  addSketchRect: (x1, y1, x2, y2) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    pushSketchUndo();
    const e = addRectangle(sketch, x1, y1, x2, y2);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    // A rectangle is decomposed into lines; return the first edge's id.
    return e.lines[0]?.id ?? '';
  },

  addSketchCircle: (cx, cy, radius) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    pushSketchUndo();
    const e = addCircle(sketch, cx, cy, radius);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
  },

  addSketchArc: (cx, cy, radius, startAngle, endAngle) => {
    const sketch = get().currentSketch;
    if (!sketch) return '';
    pushSketchUndo();
    const e = addArc(sketch, cx, cy, radius, startAngle, endAngle);
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return e.id;
  },
  addSketchPolygon: (cx, cy, radius, sides) => {
    const sketch = get().currentSketch;
    if (!sketch || !(radius > 0)) return;
    pushSketchUndo();
    addPolygon(sketch, cx, cy, radius, sides);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },

  addSketchConstraint: (type, entityIds, value) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    pushSketchUndo();
    addConstraint(sketch, type, entityIds, value);
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },
  selectedSketchId: null,
  selectedSketchIds: [],
  setSelectedSketchId: (selectedSketchId) =>
    set({ selectedSketchId, selectedSketchIds: selectedSketchId ? [selectedSketchId] : [] }),
  toggleSketchSelection: (id) =>
    set((s) => {
      const has = s.selectedSketchIds.includes(id);
      const selectedSketchIds = has
        ? s.selectedSketchIds.filter((x) => x !== id)
        : [...s.selectedSketchIds, id];
      return { selectedSketchIds, selectedSketchId: has ? null : id };
    }),
  removeSketchEntity: (id) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    pushSketchUndo();
    removeEntity(sketch, id);
    set((s) => ({
      currentSketch: { ...sketch },
      selectedSketchId: s.selectedSketchId === id ? null : s.selectedSketchId,
      selectedSketchIds: s.selectedSketchIds.filter((x) => x !== id),
      projectDirty: true,
    }));
  },
  setSketchLineLength: (id, length) => {
    const sketch = get().currentSketch;
    if (!sketch || !(length > 0)) return false;
    const e = sketch.entities.get(id);
    if (!e || e.type !== 'line') return false;
    const p1 = sketch.entities.get(e.p1Id);
    const p2 = sketch.entities.get(e.p2Id);
    if (p1?.type !== 'point' || p2?.type !== 'point') return false;
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    pushSketchUndo();
    p2.x = p1.x + dx * length; // move the endpoint along the line so |p1→p2| = length
    p2.y = p1.y + dy * length;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  setSketchEntityRadius: (id, radius) => {
    const sketch = get().currentSketch;
    if (!sketch || !(radius > 0)) return false;
    const e = sketch.entities.get(id);
    if (!e || (e.type !== 'circle' && e.type !== 'arc')) return false;
    pushSketchUndo();
    e.radius = radius;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  setSketchLineAngle: (id, deg) => {
    const sketch = get().currentSketch;
    if (!sketch) return false;
    const e = sketch.entities.get(id);
    if (!e || e.type !== 'line') return false;
    const p1 = sketch.entities.get(e.p1Id);
    const p2 = sketch.entities.get(e.p2Id);
    if (p1?.type !== 'point' || p2?.type !== 'point') return false;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 1e-9) return false; // no direction to set an angle on
    const rad = (deg * Math.PI) / 180;
    pushSketchUndo();
    p2.x = p1.x + Math.cos(rad) * len; // rotate the endpoint about p1, keeping length
    p2.y = p1.y + Math.sin(rad) * len;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  nudgeSketchEntity: (id, dx, dy) => {
    const sketch = get().currentSketch;
    if (!sketch) return false;
    const e = sketch.entities.get(id);
    if (!e) return false;
    pushSketchUndo();
    let moved = false;
    for (const pid of pointIdsOf(e)) {
      const p = sketch.entities.get(pid);
      if (p?.type === 'point') { p.x += dx; p.y += dy; moved = true; }
    }
    if (!moved) return false;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  toggleSketchConstruction: (id) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    const e = sketch.entities.get(id);
    if (!e) return;
    pushSketchUndo();
    (e as { construction?: boolean }).construction = !e.construction;
    set({ currentSketch: { ...sketch }, projectDirty: true });
  },
  filletSketchCorner: (lineAId, lineBId, radius) => {
    const sketch = get().currentSketch;
    if (!sketch || !(radius > 0)) return false;
    pushSketchUndo();
    const ok = filletCorner(sketch, lineAId, lineBId, radius);
    if (!ok) return false;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  detectSketchRectangle: (lineId) => {
    const sketch = get().currentSketch;
    if (!sketch) return null;
    return detectRectangle(sketch, lineId);
  },
  resizeSketchRectangle: (lineId, newWidth, newHeight) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    const rect = detectRectangle(sketch, lineId);
    if (!rect) return;
    pushSketchUndo();
    resizeRectangle(sketch, rect, newWidth, newHeight);
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
    set((s) => {
      const name = uniqueBodyName(body.name, s.directBodies.map((b) => b.name));
      const b = name === body.name ? body : { ...body, name };
      return { directBodies: [...s.directBodies, b], projectDirty: true };
    });
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
    set((s) => ({ directBodies: [...s.directBodies, ...withUniqueNames(newBodies, s.directBodies.map((b) => b.name))], projectDirty: true }));
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
  resizeBodyTo: (bodyId, target) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body) return false;
    let resized: SolidBody;
    try {
      resized = resizeBody(body, target);
    } catch {
      return false;
    }
    get().replaceBody(bodyId, resized);
    // Keep the selection on the resized body so the properties panel follows it.
    set((s) => ({ selectedIds: s.selectedIds.map((sid) => (sid === bodyId ? resized.id : sid)) }));
    return true;
  },
  renameBody: (id, name) => {
    const trimmed = name.trim();
    const { directBodies } = get();
    const target = directBodies.find((b) => b.id === id);
    if (!trimmed || !target || target.name === trimmed) return false;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === id ? { ...b, name: trimmed } : b)), projectDirty: true });
    recombine();
    return true;
  },
  renaming: null,
  beginRename: (id) => {
    const body = get().bodies.find((b) => b.id === id);
    if (body) set({ renaming: { id, value: body.name } });
  },
  beginRenameSelected: () => {
    const { selectedIds, bodies } = get();
    if (selectedIds.length !== 1) return;
    const id = selectedIds[0]!;
    const body = bodies.find((b) => b.id === id);
    if (body) set({ renaming: { id, value: body.name } });
  },
  setRenameValue: (value) => set((s) => (s.renaming ? { renaming: { ...s.renaming, value } } : {})),
  commitRename: () => {
    const { renaming } = get();
    if (renaming) get().renameBody(renaming.id, renaming.value);
    set({ renaming: null });
  },
  cancelRename: () => set({ renaming: null }),
  setBodyColor: (id, color) => {
    const { directBodies } = get();
    const target = directBodies.find((b) => b.id === id);
    if (!target || target.color === color) return false;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === id ? { ...b, color } : b)), projectDirty: true });
    recombine();
    return true;
  },
  setBodyMaterial: (id, material) => {
    const { directBodies } = get();
    const target = directBodies.find((b) => b.id === id);
    if (!target || (target.material ?? 'steel') === material) return false;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === id ? { ...b, material } : b)), projectDirty: true });
    recombine();
    return true;
  },
  reorderBody: (id, direction) => {
    const { directBodies } = get();
    const i = directBodies.findIndex((b) => b.id === id);
    if (i === -1) return false;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= directBodies.length) return false;
    pushUndo();
    const next = [...directBodies];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ directBodies: next, projectDirty: true });
    recombine();
    return true;
  },
  setSelectionColor: (color) => {
    const { directBodies, selectedIds } = get();
    const sel = new Set(selectedIds);
    const targets = directBodies.filter((b) => sel.has(b.id) && b.color !== color);
    if (targets.length === 0) return 0;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (sel.has(b.id) ? { ...b, color } : b)), projectDirty: true });
    recombine();
    return targets.length;
  },
  setSelectionMaterial: (material) => {
    const { directBodies, selectedIds } = get();
    const sel = new Set(selectedIds);
    const targets = directBodies.filter((b) => sel.has(b.id) && (b.material ?? 'steel') !== material);
    if (targets.length === 0) return 0;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (sel.has(b.id) ? { ...b, material } : b)), projectDirty: true });
    recombine();
    return targets.length;
  },
  toggleBodyTransparency: (id) => {
    const { directBodies } = get();
    const body = directBodies.find((b) => b.id === id);
    if (!body) return false;
    const next = (body.opacity ?? 1) < 1 ? 1 : 0.4;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === id ? { ...b, opacity: next } : b)), projectDirty: true });
    recombine();
    return true;
  },
  setBodyOpacity: (id, opacity) => {
    const { directBodies } = get();
    const body = directBodies.find((b) => b.id === id);
    const clamped = Math.max(0.05, Math.min(1, opacity));
    if (!body || (body.opacity ?? 1) === clamped) return false;
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === id ? { ...b, opacity: clamped } : b)), projectDirty: true });
    recombine();
    return true;
  },
  hiddenIds: [],
  // Visibility changes are undoable (hiddenIds is part of the undo snapshot).
  toggleBodyVisibility: (id) => {
    pushUndo();
    set((s) => ({
      hiddenIds: s.hiddenIds.includes(id) ? s.hiddenIds.filter((h) => h !== id) : [...s.hiddenIds, id],
    }));
  },
  isolateSelected: () => {
    if (get().selectedIds.length === 0) return;
    pushUndo();
    set((s) => ({ hiddenIds: s.bodies.map((b) => b.id).filter((id) => !s.selectedIds.includes(id)) }));
  },
  hideSelected: () => {
    const { selectedIds, hiddenIds } = get();
    if (selectedIds.every((id) => hiddenIds.includes(id))) return; // nothing new to hide
    pushUndo();
    set((s) => {
      const add = s.selectedIds.filter((id) => !s.hiddenIds.includes(id));
      // Hidden bodies drop out of the selection (SolidWorks Tab-hide behaviour).
      return { hiddenIds: [...s.hiddenIds, ...add], selectedIds: [] };
    });
  },
  showAllBodies: () => {
    if (get().hiddenIds.length === 0) return;
    pushUndo();
    set({ hiddenIds: [] });
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
  duplicateSelected: () => {
    const { selectedIds, directBodies } = get();
    const selected = new Set(selectedIds);
    const toCopy = directBodies.filter((b) => selected.has(b.id));
    if (toCopy.length === 0) return []; // nothing duplicable (only tree bodies selected)
    const copies = toCopy.map((b) => ({ ...translateBody(b, { x: 5, y: 0, z: 5 }, `${b.name} copy`), color: b.color }));
    pushUndo();
    set((s) => {
      const named = withUniqueNames(copies, s.directBodies.map((b) => b.name));
      return { directBodies: [...s.directBodies, ...named], selectedIds: named.map((c) => c.id), projectDirty: true };
    });
    recombine();
    return copies.map((c) => c.id);
  },
  nudgeSelected: (dx, dy, dz) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const n = directBodies.filter((b) => sel.has(b.id)).length;
    if (n === 0) return 0; // nothing direct selected
    const move = (v: Vec3): Vec3 => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz });
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) =>
        sel.has(b.id)
          ? {
              ...b,
              vertices: b.vertices.map(move),
              faces: b.faces.map((f) => ({ ...f, vertices: f.vertices.map(move) })),
              edges: b.edges.map((e) => ({ ...e, start: move(e.start), end: move(e.end) })),
            }
          : b,
      ),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  moveSelectionTo: (target) => {
    const { selectedIds, bodies } = get();
    const sel = bodies.filter((b) => selectedIds.includes(b.id));
    if (sel.length === 0) return 0;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of sel) for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
    const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    return get().nudgeSelected(target.x - center.x, target.y - center.y, target.z - center.z);
  },
  moveSelectionToOrigin: () => get().moveSelectionTo({ x: 0, y: 0, z: 0 }),
  rotateSelected: (axis, degrees) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const selBodies = directBodies.filter((b) => sel.has(b.id));
    const n = selBodies.length;
    if (n === 0) return 0;
    const angle = (degrees * Math.PI) / 180;
    const dir: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    // Rotate the whole selection rigidly about its combined centre (identical to
    // each body's centre for a single selection) — SolidWorks group rotation.
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of selBodies) for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
    const origin = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        if (!sel.has(b.id)) return b;
        return { ...rotateBody(b, { origin, direction: dir }, angle), id: b.id, color: b.color };
      }),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  flipSelected: (axis) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const selBodies = directBodies.filter((b) => sel.has(b.id));
    const n = selBodies.length;
    if (n === 0) return 0;
    const normal: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    // Mirror across a plane through the selection's combined centre (its own
    // centre for a single body) so a multi-selection mirrors as a group — the
    // arrangement flips, not just each body in place — like SolidWorks.
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of selBodies) for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
    const origin = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        if (!sel.has(b.id)) return b;
        return { ...applyMirror(b, { origin, normal }), id: b.id, color: b.color };
      }),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  mirrorCopySelected: (axis) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const selBodies = directBodies.filter((b) => sel.has(b.id));
    if (selBodies.length === 0) return [];
    // Mirror across the world datum plane (origin, axis-normal) and keep both the
    // original and the reflected copy — SolidWorks "Mirror" about a plane.
    const normal: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const copies = selBodies.map((b) => ({ ...applyMirror(b, { origin: { x: 0, y: 0, z: 0 }, normal }), color: b.color }));
    pushUndo();
    set((s) => {
      const named = withUniqueNames(copies, s.directBodies.map((b) => b.name));
      return { directBodies: [...s.directBodies, ...named], selectedIds: named.map((c) => c.id), projectDirty: true };
    });
    recombine();
    return copies.map((c) => c.id);
  },
  weldSelected: () => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const n = directBodies.filter((b) => sel.has(b.id)).length;
    if (n === 0) return 0;
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => (sel.has(b.id) ? { ...weldVertices(b), id: b.id, color: b.color } : b)),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  alignSelected: (axis, mode) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const targets = directBodies.filter((b) => sel.has(b.id));
    if (targets.length < 2) return 0; // need at least two bodies to align
    const range = (b: SolidBody) => {
      let lo = Infinity, hi = -Infinity;
      for (const v of b.vertices) { lo = Math.min(lo, v[axis]); hi = Math.max(hi, v[axis]); }
      return { lo, hi };
    };
    const ranges = new Map(targets.map((b) => [b.id, range(b)]));
    const allLo = Math.min(...[...ranges.values()].map((r) => r.lo));
    const allHi = Math.max(...[...ranges.values()].map((r) => r.hi));
    const target = mode === 'min' ? allLo : mode === 'max' ? allHi : (allLo + allHi) / 2;
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        const r = ranges.get(b.id);
        if (!r) return b;
        const current = mode === 'min' ? r.lo : mode === 'max' ? r.hi : (r.lo + r.hi) / 2;
        const d = target - current;
        if (Math.abs(d) < 1e-12) return b;
        const move = (v: Vec3): Vec3 => ({ ...v, [axis]: v[axis] + d });
        return {
          ...b,
          vertices: b.vertices.map(move),
          faces: b.faces.map((f) => ({ ...f, vertices: f.vertices.map(move) })),
          edges: b.edges.map((e) => ({ ...e, start: move(e.start), end: move(e.end) })),
        };
      }),
      projectDirty: true,
    }));
    recombine();
    return targets.length;
  },
  distributeSelected: (axis) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const targets = directBodies.filter((b) => sel.has(b.id));
    if (targets.length < 3) return 0; // ends + at least one middle body
    const centerOf = (b: SolidBody) => {
      let lo = Infinity, hi = -Infinity;
      for (const v of b.vertices) { lo = Math.min(lo, v[axis]); hi = Math.max(hi, v[axis]); }
      return (lo + hi) / 2;
    };
    const sorted = targets.map((b) => ({ b, c: centerOf(b) })).sort((p, q) => p.c - q.c);
    const first = sorted[0]!.c;
    const last = sorted[sorted.length - 1]!.c;
    const span = last - first;
    const deltas = new Map<string, number>();
    for (let i = 1; i < sorted.length - 1; i++) {
      const targetC = first + (span * i) / (sorted.length - 1);
      deltas.set(sorted[i]!.b.id, targetC - sorted[i]!.c);
    }
    if (deltas.size === 0) return 0;
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        const d = deltas.get(b.id);
        if (d === undefined || Math.abs(d) < 1e-12) return b;
        const move = (v: Vec3): Vec3 => ({ ...v, [axis]: v[axis] + d });
        return {
          ...b,
          vertices: b.vertices.map(move),
          faces: b.faces.map((f) => ({ ...f, vertices: f.vertices.map(move) })),
          edges: b.edges.map((e) => ({ ...e, start: move(e.start), end: move(e.end) })),
        };
      }),
      projectDirty: true,
    }));
    recombine();
    return targets.length;
  },
  dropSelectedToFloor: () => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const targets = directBodies.filter((b) => sel.has(b.id));
    if (targets.length === 0) return 0;
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        if (!sel.has(b.id)) return b;
        let minY = Infinity;
        for (const v of b.vertices) minY = Math.min(minY, v.y);
        if (Math.abs(minY) < 1e-12) return b; // already on the plate
        const move = (v: Vec3): Vec3 => ({ ...v, y: v.y - minY });
        return {
          ...b,
          vertices: b.vertices.map(move),
          faces: b.faces.map((f) => ({ ...f, vertices: f.vertices.map(move) })),
          edges: b.edges.map((e) => ({ ...e, start: move(e.start), end: move(e.end) })),
        };
      }),
      projectDirty: true,
    }));
    recombine();
    return targets.length;
  },
  pendingPattern: null,
  setPendingPattern: (pendingPattern) => set({ pendingPattern }),
  moveDialogOpen: false,
  setMoveDialogOpen: (moveDialogOpen) => set({ moveDialogOpen }),
  rotateDialogOpen: false,
  setRotateDialogOpen: (rotateDialogOpen) => set({ rotateDialogOpen }),
  scaleDialogOpen: false,
  setScaleDialogOpen: (scaleDialogOpen) => set({ scaleDialogOpen }),
  hollowDialogBody: null,
  setHollowDialogBody: (hollowDialogBody) => set({ hollowDialogBody }),
  hollowBodyById: async (bodyId, wallThickness) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body || !(wallThickness > 0)) return null;
    // Voxel hollowing takes seconds — it runs in the geometry worker.
    let result: SolidBody | null;
    try {
      result = await asyncHollowBody(body, wallThickness);
    } catch {
      return null;
    }
    if (!result) return null;
    result.color = body.color;
    get().replaceBody(bodyId, result);
    set((s) => ({ selectedIds: s.selectedIds.map((sid) => (sid === bodyId ? result!.id : sid)) }));
    return result.id;
  },
  linearPatternBody: (bodyId, axis, count, spacing) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body || !(count >= 1) || !(spacing > 0)) return [];
    const dir: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const copies = applyLinearArray(body, dir, Math.floor(count), spacing).map((c) => ({ ...c, color: body.color }));
    if (copies.length === 0) return [];
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => b.id !== bodyId), ...copies],
      selectedIds: copies.map((c) => c.id),
      projectDirty: true,
    }));
    recombine();
    return copies.map((c) => c.id);
  },
  circularPatternBody: (bodyId, axis, count) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body || !(count >= 1)) return [];
    const dir: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const copies = applyCircularArray(body, { origin: { x: 0, y: 0, z: 0 }, direction: dir }, Math.floor(count)).map((c) => ({ ...c, color: body.color }));
    if (copies.length === 0) return [];
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => b.id !== bodyId), ...copies],
      selectedIds: copies.map((c) => c.id),
      projectDirty: true,
    }));
    recombine();
    return copies.map((c) => c.id);
  },
  gridPatternBody: (bodyId, countX, spacingX, countZ, spacingZ) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body || !(countX >= 1) || !(countZ >= 1) || !(spacingX > 0) || !(spacingZ > 0)) return [];
    const copies = applyGridArray(
      body,
      { x: 1, y: 0, z: 0 }, Math.floor(countX), spacingX,
      { x: 0, y: 0, z: 1 }, Math.floor(countZ), spacingZ,
    ).map((c) => ({ ...c, color: body.color }));
    if (copies.length === 0) return [];
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => b.id !== bodyId), ...copies],
      selectedIds: copies.map((c) => c.id),
      projectDirty: true,
    }));
    recombine();
    return copies.map((c) => c.id);
  },
  makeBoundingBoxOfSelection: (margin = 0) => {
    const { selectedIds, bodies } = get();
    const sel = bodies.filter((b) => selectedIds.includes(b.id));
    if (sel.length === 0) return null;
    let box: SolidBody;
    try {
      box = createBoundingBoxBody(sel.length === 1 ? sel[0]! : mergeBodies(sel), margin);
    } catch {
      return null;
    }
    box.name = 'Bounding box';
    get().addDirectBody(box);
    get().selectObject(box.id);
    return box.id;
  },
  scaleSelected: (factor) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const selBodies = directBodies.filter((b) => sel.has(b.id));
    const n = selBodies.length;
    if (n === 0 || !(factor > 0)) return 0;
    // Scale about the selection's combined centre (its own centre for a single
    // body) so a multi-selection scales as a group — gaps included — like SW.
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of selBodies) for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
    const origin = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        if (!sel.has(b.id)) return b;
        return { ...scaleBody(b, factor, origin), id: b.id, color: b.color };
      }),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  scaleSelectedXYZ: (fx, fy, fz) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const selBodies = directBodies.filter((b) => sel.has(b.id));
    const n = selBodies.length;
    if (n === 0) return 0;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of selBodies) for (const v of b.vertices) {
      min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
    }
    const origin = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    pushUndo();
    set((s) => ({
      directBodies: s.directBodies.map((b) => {
        if (!sel.has(b.id)) return b;
        return { ...scaleBodyXYZ(b, fx, fy, fz, origin), id: b.id, color: b.color };
      }),
      projectDirty: true,
    }));
    recombine();
    return n;
  },
  clipboard: [],
  pasteCount: 0,
  copySelected: () => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const copied = directBodies.filter((b) => sel.has(b.id));
    // Reset the cascade so the first paste lands one step from the originals.
    set({ clipboard: copied, pasteCount: 0 });
    return copied.length;
  },
  cutSelected: () => {
    const n = get().copySelected();
    if (n > 0) get().deleteSelected(); // delete pushes undo, so cut is reversible
    return n;
  },
  paste: () => {
    const { clipboard, pasteCount } = get();
    if (clipboard.length === 0) return [];
    // Each successive paste steps further out so copies don't stack on top.
    const k = pasteCount + 1;
    const offset = { x: 10 * k, y: 0, z: 10 * k };
    const copies = clipboard.map((b) => ({ ...translateBody(b, offset, `${b.name} copy`), color: b.color }));
    pushUndo();
    set((s) => {
      const named = withUniqueNames(copies, s.directBodies.map((b) => b.name));
      return { directBodies: [...s.directBodies, ...named], selectedIds: named.map((c) => c.id), pasteCount: k, projectDirty: true };
    });
    recombine();
    return copies.map((c) => c.id);
  },
  undoStack: [],
  redoStack: [],
  undo: () => {
    const { undoStack, directBodies, hiddenIds } = get();
    if (undoStack.length === 0) return false;
    const prev = undoStack[undoStack.length - 1]!;
    set((s) => ({
      directBodies: prev.directBodies,
      hiddenIds: prev.hiddenIds,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, { directBodies, hiddenIds }],
      selectedIds: [],
      projectDirty: true,
    }));
    recombine();
    return true;
  },
  redo: () => {
    const { redoStack, directBodies, hiddenIds } = get();
    if (redoStack.length === 0) return false;
    const next = redoStack[redoStack.length - 1]!;
    set((s) => ({
      directBodies: next.directBodies,
      hiddenIds: next.hiddenIds,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, { directBodies, hiddenIds }],
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
      hiddenIds: [],
      clipboard: [],
      pasteCount: 0,
      renaming: null,
      planes: [],
      axes: [],
      points: [],
      coordSystems: [],
      annotations: [],
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
      projectDirty: true,
    });
  },
  newProject: () => {
    get().clearScene();
    set({ projectName: 'Untitled', projectDirty: false, workspace: 'model', selectedSketchId: null, selectedSketchIds: [] });
  },
  loadProject: (features, name, directBodies = [], referenceGeometry) => {
    const tree = new FeatureTree();
    for (const f of features) tree.addFeature(f);
    tree.recompute();
    set({
      featureTree: tree,
      directBodies,
      selectedIds: [],
      hiddenIds: [],
      clipboard: [],
      pasteCount: 0,
      renaming: null,
      planes: referenceGeometry?.planes ?? [],
      axes: referenceGeometry?.axes ?? [],
      points: referenceGeometry?.points ?? [],
      coordSystems: referenceGeometry?.coordSystems ?? [],
      annotations: referenceGeometry?.annotations ?? [],
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

  axes: [],
  addAxis: (axis) => {
    set((s) => ({ axes: [...s.axes, axis], projectDirty: true }));
    return axis.id;
  },
  addAxisFromPlanes: (planeIdA, planeIdB) => {
    const a = get().planes.find((p) => p.id === planeIdA);
    const b = get().planes.find((p) => p.id === planeIdB);
    if (!a || !b) return null;
    const axis = axisFromPlanes(a, b);
    if (!axis) return null;
    return get().addAxis(axis);
  },
  addAxisFromPoints: (p1, p2) => {
    const axis = axisFromPoints(p1, p2);
    if (!axis) return null;
    return get().addAxis(axis);
  },
  removeAxis: (id) => set((s) => ({ axes: s.axes.filter((a) => a.id !== id), projectDirty: true })),
  circularPatternAboutAxis: (bodyId, axisId, count) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    const axis = get().axes.find((a) => a.id === axisId);
    if (!body || !axis || !(count > 0)) return [];
    const copies = applyCircularArray(body, { origin: axis.origin, direction: axis.direction }, Math.floor(count));
    if (copies.length === 0) return [];
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => b.id !== bodyId), ...copies],
      selectedIds: [],
      projectDirty: true,
    }));
    recombine();
    return copies.map((c) => c.id);
  },

  points: [],
  addPoint: (position, name) => {
    const p = makePoint(position, name);
    set((s) => ({ points: [...s.points, p], projectDirty: true }));
    return p.id;
  },
  addMidpoint: (p1, p2) => {
    const p = midpoint(p1, p2);
    set((s) => ({ points: [...s.points, p], projectDirty: true }));
    return p.id;
  },
  addPointAtAxisPlane: (axisId, planeId) => {
    const axis = get().axes.find((a) => a.id === axisId);
    const plane = get().planes.find((p) => p.id === planeId);
    if (!axis || !plane) return null;
    const p = pointAtAxisPlaneIntersection(axis, plane);
    if (!p) return null;
    set((s) => ({ points: [...s.points, p], projectDirty: true }));
    return p.id;
  },
  removePoint: (id) => set((s) => ({ points: s.points.filter((p) => p.id !== id), projectDirty: true })),

  coordSystems: [],
  addCoordinateSystem: (origin, primary, secondary, name) => {
    let cs: CoordinateSystemDefinition;
    try {
      cs = makeCoordinateSystem(origin, primary, secondary, name);
    } catch {
      return null;
    }
    set((s) => ({ coordSystems: [...s.coordSystems, cs], projectDirty: true }));
    return cs.id;
  },
  removeCoordinateSystem: (id) => set((s) => ({ coordSystems: s.coordSystems.filter((c) => c.id !== id), projectDirty: true })),

  annotations: [],
  addAnnotation: (a) => set((s) => ({ annotations: [...s.annotations, a], projectDirty: true })),
  removeAnnotation: (id) => set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id), projectDirty: true })),
  placeBodyInCoordinateSystem: (bodyId, csId) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    const cs = get().coordSystems.find((c) => c.id === csId);
    if (!body || !cs) return null;
    const placed = placeBodyInFrame(body, cs);
    get().replaceBody(bodyId, placed);
    return placed.id;
  },

  combineSelected: async (op) => {
    const { selectedIds, directBodies } = get();
    // Operate on the first two selected direct bodies, in selection order
    // (difference is a − b).
    const sel = selectedIds
      .map((id) => directBodies.find((b) => b.id === id))
      .filter((b): b is SolidBody => !!b);
    if (sel.length < 2) return null;
    const [a, b] = sel as [SolidBody, SolidBody];
    // Exact when Manifold is warm (main thread, ms); voxel sampling otherwise
    // runs in the geometry worker so the viewport keeps responding.
    const result = await asyncBooleanOp(a, b, op);
    if (!result) return null;
    result.color = a.color;
    result.name = `${a.name} ${op === 'union' ? '+' : op === 'difference' ? '−' : '∩'} ${b.name}`;
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((x) => x.id !== a.id && x.id !== b.id), result],
      selectedIds: [result.id],
      projectDirty: true,
    }));
    recombine();
    return result.id;
  },
  joinSelected: () => {
    const { selectedIds, directBodies } = get();
    const sel = directBodies.filter((b) => selectedIds.includes(b.id));
    if (sel.length < 2) return null;
    const merged = mergeBodies(sel);
    merged.color = sel[0]!.color;
    merged.name = `${sel[0]!.name} (joined)`;
    const ids = new Set(sel.map((b) => b.id));
    pushUndo();
    set((s) => ({
      directBodies: [...s.directBodies.filter((b) => !ids.has(b.id)), merged],
      selectedIds: [merged.id],
      projectDirty: true,
    }));
    recombine();
    return merged.id;
  },
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
  showShortcuts: false,
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  wireframe: stored('scenelab.wireframe') === 'true',
  setWireframe: (wireframe) => { set({ wireframe }); persist('scenelab.wireframe', String(wireframe)); },
  showGrid: stored('scenelab.showGrid') !== 'false',
  setShowGrid: (showGrid) => { set({ showGrid }); persist('scenelab.showGrid', String(showGrid)); },
  showCenterOfMass: stored('scenelab.showCenterOfMass') === 'true',
  setShowCenterOfMass: (showCenterOfMass) => { set({ showCenterOfMass }); persist('scenelab.showCenterOfMass', String(showCenterOfMass)); },
  pendingPrimitive: null,
  setPendingPrimitive: (pendingPrimitive) => set({
    pendingPrimitive,
    ...(pendingPrimitive ? { lastCommand: { type: 'primitive' as const, kind: pendingPrimitive } } : {}),
  }),
  lastCommand: null,
  repeatLastCommand: () => {
    const cmd = get().lastCommand;
    if (cmd?.type === 'primitive') set({ pendingPrimitive: cmd.kind });
  },
  // Persisted so your preferred primitive dimensions carry over between sessions.
  lastPrimitiveParams: (() => {
    try { return JSON.parse(stored('scenelab.lastPrimitiveParams') || '{}'); } catch { return {}; }
  })(),
  rememberPrimitiveParams: (kind, params) =>
    set((s) => {
      const next = { ...s.lastPrimitiveParams, [kind]: params };
      persist('scenelab.lastPrimitiveParams', JSON.stringify(next));
      return { lastPrimitiveParams: next };
    }),
  measureActive: false,
  setMeasureActive: (measureActive) => set({ measureActive, measurePts: [] }),
  measurePts: [],
  addMeasurePoint: (p) => set((s) => ({ measurePts: s.measurePts.length >= 3 ? [p] : [...s.measurePts, p] })),
  removeLastMeasurePoint: () => set((s) => ({ measurePts: s.measurePts.slice(0, -1) })),

  performExtrude: (distance, symmetric) => {
    const sketch = get().currentSketch;
    if (!sketch) return;
    // The dialog clamps to ≥0.1 mm; enforce the same floor for AI/programmatic
    // callers so a degenerate distance can't enter the tree as a failing feature.
    if (!(distance > 0)) return;

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

  performSweep: (distance, twistDegrees) => {
    const sketch = get().currentSketch;
    if (!sketch || !(distance > 0)) return;

    // Subdivide the straight path so the twist is applied gradually. One big
    // step per end can map a symmetric profile's corner set onto itself,
    // collapsing the side quads (degenerate faces, wrong signed volume).
    const twist = (twistDegrees * Math.PI) / 180;
    const steps = Math.max(2, Math.ceil(Math.abs(twist) / (Math.PI / 8)));
    const path = Array.from({ length: steps + 1 }, (_, i) => ({
      x: 0,
      y: (distance * i) / steps,
      z: 0,
    }));

    const sketchFeat = createSketchFeature(sketch);
    const sweepFeat = createSweepFeature({ path, twist }, [sketchFeat.id]);

    const tree = get().featureTree;
    tree.addFeature(sketchFeat);
    tree.addFeature(sweepFeat);
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

  // Modify features: when the selected body was produced by a feature, add a
  // parametric child feature (Fusion timeline style — recompute replays it);
  // otherwise edit the direct body in place, undoable like other direct edits.
  // Fillet/chamfer scope to the Alt+click edge sub-selection when present
  // (empty selection = every edge, whole-body treatment).
  applyFilletFeature: (radius) =>
    applyModifyFeature(
      (parentIds) => createFilletFeature(scopedEdgeIds(), radius, parentIds),
      (body) => applyFillet(body, scopedEdgeIdsFor(body), radius),
    ),

  applyChamferFeature: (distance) =>
    applyModifyFeature(
      (parentIds) => createChamferFeature(scopedEdgeIds(), distance, parentIds),
      (body) => applyChamfer(body, scopedEdgeIdsFor(body), distance),
    ),

  applyShellFeature: (thickness) =>
    applyModifyFeature(
      (parentIds) => createShellFeature([], thickness, parentIds),
      (body) => applyShell(body, [], thickness),
    ),

  applyLinearArrayFeature: (count, spacing, axis) =>
    applyModifyFeature(
      (parentIds) =>
        createLinearArrayFeature(axisDirection(axis), count, spacing, parentIds),
      (body) => applyLinearArray(body, axisDirection(axis), count, spacing),
    ),

  applyCircularArrayFeature: (count) =>
    applyModifyFeature(
      (parentIds) => {
        const body = selectedBody();
        const origin = body ? computeBoundingBoxCenter(body) : { x: 0, y: 0, z: 0 };
        return createCircularArrayFeature({ origin, direction: { x: 0, y: 0, z: 1 } }, count, parentIds);
      },
      (body) => applyCircularArray(body, { origin: computeBoundingBoxCenter(body), direction: { x: 0, y: 0, z: 1 } }, count),
    ),

  applyMirrorFeature: (plane, keepOriginal) =>
    applyModifyFeature(
      (parentIds) => {
        const body = selectedBody();
        const origin = body ? computeBoundingBoxCenter(body) : { x: 0, y: 0, z: 0 };
        return createMirrorFeature({ origin, normal: planeNormal(plane) }, parentIds, keepOriginal);
      },
      (body) => applyMirror(body, { origin: computeBoundingBoxCenter(body), normal: planeNormal(plane) }),
      // Keeping the original means the mirrored copy is added alongside it.
      !keepOriginal,
    ),

  performLoftFromSketches: (sketchFeatureIds) => {
    const tree = get().featureTree;
    const parents = sketchFeatureIds
      .map((id) => tree.getFeature(id))
      .filter((f): f is Extract<Feature, { type: 'sketch' }> => f?.type === 'sketch');
    if (parents.length < 2) return false;
    tree.addFeature(createLoftFeature({}, parents.map((p) => p.id)));
    tree.recompute();
    set({ featureTree: tree, projectDirty: true });
    recombine();
    return true;
  },

  viewDirection: 'iso',
  setViewDirection: (viewDirection) => set({ viewDirection }),
  projection: 'perspective',
  setProjection: (projection) => set({ projection }),
  toggleProjection: () => set((s) => ({ projection: s.projection === 'perspective' ? 'orthographic' : 'perspective' })),

  objectIds: [],
  selectedIds: [],
  selectedFaceIds: [],
  setSelectedFaceIds: (ids) => set({ selectedFaceIds: ids }),
  selectedEdgeIds: [],
  setSelectedEdgeIds: (selectedEdgeIds) => set({ selectedEdgeIds }),
  addObject: (id) => set((s) => ({ objectIds: [...s.objectIds, id] })),
  selectObject: (id) => set({ selectedIds: [id], selectedFaceIds: [], selectedEdgeIds: [] }),
  setSelectedIds: (ids) => set({ selectedIds: ids, selectedFaceIds: [], selectedEdgeIds: [] }),
  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((sid) => sid !== id)
        : [...s.selectedIds, id],
    })),
  // Select all *visible* bodies — hidden bodies stay out of the selection, as
  // in SolidWorks (Ctrl+A doesn't grab what you can't see).
  selectAll: () => set((s) => ({ selectedIds: s.bodies.filter((b) => !s.hiddenIds.includes(b.id)).map((b) => b.id) })),
  deselectAll: () => set({ selectedIds: [], selectedFaceIds: [], selectedEdgeIds: [] }),
  hoveredId: null,
  // Guarded so a mousemove over the same body doesn't churn subscribers.
  setHoveredId: (id) => { if (get().hoveredId !== id) set({ hoveredId: id }); },
  invertSelection: () =>
    set((s) => {
      const sel = new Set(s.selectedIds);
      // Invert among visible bodies only; hidden ones are never auto-selected.
      return { selectedIds: s.bodies.filter((b) => !s.hiddenIds.includes(b.id) && !sel.has(b.id)).map((b) => b.id) };
    }),
  selectRange: (fromId, toId) =>
    set((s) => {
      const ids = s.bodies.map((b) => b.id);
      const i = ids.indexOf(fromId);
      const j = ids.indexOf(toId);
      if (i === -1 || j === -1) return { selectedIds: [toId] };
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      return { selectedIds: ids.slice(lo, hi + 1) };
    }),

  showBrowserTree: stored('scenelab.showBrowserTree') !== 'false',
  showProperties: stored('scenelab.showProperties') !== 'false',
  toggleBrowserTree: () => set((s) => { const v = !s.showBrowserTree; persist('scenelab.showBrowserTree', String(v)); return { showBrowserTree: v }; }),
  toggleProperties: () => set((s) => { const v = !s.showProperties; persist('scenelab.showProperties', String(v)); return { showProperties: v }; }),

  projectName: 'Untitled',
  setProjectName: (projectName) => set({ projectName }),
  projectDirty: false,
  setProjectDirty: (projectDirty) => set({ projectDirty }),

  autosave: () => {
    if (typeof localStorage === 'undefined') return false;
    const { projectDirty, projectName, featureTree, directBodies, planes, axes, points, coordSystems, annotations } = get();
    if (!projectDirty) return false;
    try {
      const project = serializeProject(projectName, featureTree.features, [], directBodies, { planes, axes, points, coordSystems, annotations });
      const json = saveToFile(project);
      localStorage.setItem(AUTOSAVE_KEY, json);
      // Desktop belt-and-braces: a native crash-recovery snapshot beside the
      // webview storage (Rust prunes to the newest 20). Fire-and-forget — the
      // localStorage copy above is already the primary restore source.
      if (isTauri()) {
        void callNative('autosave_snapshot', { data: json }).catch(() => undefined);
      }
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
      get().loadProject(deserializeFeatures(project), project.name, deserializeDirectBodies(project), deserializeReferenceGeometry(project));
      return true;
    } catch {
      return false;
    }
  },
  hasAutosave: () => typeof localStorage !== 'undefined' && localStorage.getItem(AUTOSAVE_KEY) !== null,
  };
});
