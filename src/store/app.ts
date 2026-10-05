import { create } from 'zustand';
import type { Sketch } from '../lib/sketch/types';
import { addLine, addRectangle, addCircle, addArc, addPolygon, addConstraint, removeEntity, pointIdsOf, cloneSketch, detectRectangle, resizeRectangle, filletSketchCorner as filletCorner, offsetEntity, createSketch, solveSketch, type DetectedRectangle } from '../lib/sketch/engine';
import { offsetSketchProfile } from '../lib/sketch/offset';
import { mirrorSketchEntities } from '../lib/sketch/mirror';
import { planeNormal as sketchPlaneNormal } from '../lib/sketch/frames';
import { trimSketchEntityAt, extendSketchEntityTo } from '../lib/sketch/trim';
import type { Feature } from '../lib/features/types';
import { FeatureTree, createSketchFeature, createExtrudeFeature, createRevolveFeature, createSweepFeature, createLoftFeature, createFilletFeature, createChamferFeature, createShellFeature, createHoleFeature, createScaleFeature, createLinearArrayFeature, createCircularArrayFeature, createMirrorFeature, drillHoleInBody, topFaceHolePlacement, extrudeSketchBody, cutBodyWithCutter } from '../lib/features/tree';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, deserializeDirectBodies, deserializeReferenceGeometry, deserializeDrawing, deserializeCam, type SerializedReferenceGeometry, type SerializedDrawing } from '../lib/io';
import { generateOperationToolpath, defaultCamSetup, getTool, estimateMachiningTime } from '../lib/cam';
import type { CAMSetup, CAMOperation } from '../lib/cam';
import type { CAMParameters, Toolpath } from '../lib/cam';
import type { SolidBody, PlaneDefinition, Vec3 } from '../lib/geometry/types';
import type { MeasureFacePick, MeasureMode } from '../lib/geometry/measure';
import { standardPlanes, planeFromFace, offsetPlane, midplaneBetweenFaces, axisFromPlanes, axisFromPoints, makePoint, midpoint, pointAtAxisPlaneIntersection, makeCoordinateSystem, type AxisDefinition, type PointDefinition, type CoordinateSystemDefinition, type AnnotationDefinition } from '../lib/geometry/referenceGeometry';
import { splitByPlane, asyncBooleanOp, asyncHollowBody, type BooleanOp } from '../lib/geometry/boolean';
import { applyCircularArray, applyLinearArray, applyGridArray, applyMirror, applyFillet, applyChamfer, applyShell, placeBodyInFrame, resizeBody, resizeBodyAxis, translateBody, rotateBody, scaleBody, scaleBodyXYZ, mergeBodies, weldVertices, maxFilletRadius, maxChamferDistance } from '../lib/geometry/operations';
import { computeBoundingBoxCenter } from '../lib/geometry/brep';
import { findLibraryPart } from '../lib/library/parts';
import { isTauri, callNative } from '../lib/runtime';
import { translations } from '../lib/i18n';
import { showToast } from '../lib/toast';
import type { DrawingDetail, DrawingNote, DrawingSectionAxis } from '../lib/io/drawingNotes';
import { defaultDrawingViewPlacements, sanitizeDrawingViewPlacements, type DrawingViewPlacement } from '../lib/io/studio3d';

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

// --- CAM setup (cam workspace) -------------------------------------------------
// The CAM job lives in the store like the drawing sheet: pure data + a derived
// toolpath cache. Ids follow the drawingNotes counter pattern (camop_1, camop_2…).

let nextCamOpId = 1;

/** Session-unique CAM operation id (camop_1, camop_2, …). */
export function makeCamOpId(): string {
  return `camop_${nextCamOpId++}`;
}

/** Bump the counter past every camop_N already present (after loadProject) so
 * freshly added operations can never collide with restored ones. */
function seedCamOpCounter(ops: CAMOperation[]): void {
  for (const op of ops) {
    const m = /^camop_(\d+)$/.exec(op.id);
    if (m) nextCamOpId = Math.max(nextCamOpId, Number(m[1]) + 1);
  }
}

/**
 * Cached generation result for one CAM operation: the full Toolpath (points
 * are SCENE coordinates, y = height — rendered verbatim; the whole object is
 * what the G-code exporter consumes) plus the machining-time estimate.
 */
export interface CamToolpathCache {
  toolpath: Toolpath;
  /** estimateMachiningTime(toolpath), minutes. */
  timeMin: number;
}

/**
 * "Deep-ish" patch for updateCamOperation: top-level fields replace, params
 * merge key-by-key, holes replace wholesale.
 */
export type CamOperationPatch = Partial<Omit<CAMOperation, 'id' | 'params' | 'holes'>> & {
  params?: Partial<CAMParameters>;
  holes?: CAMOperation['holes'];
};

/**
 * A CAM operation carrying the stable-identity binding the store attaches
 * (F3). `bodyFeatureId` is the id of the feature-tree feature whose result
 * produced `bodyId` when the op was added/last retargeted. Tree recompute
 * rotates result-body ids on every upstream parametric edit (evaluators mint
 * fresh body ids), so the exact-id match dies with the first edit and the op
 * would dangle forever; the binding lets resolution fall back to "the current
 * body of that feature" and repoint the op.
 *
 * It lives ON the operation object — not in a side table — so undo/redo
 * snapshots (HistorySnapshot keeps camSetup by reference) and any camSetup
 * serialization carry it automatically. Structural extension of CAMOperation
 * (lib/cam is read-only here); the field is optional and invisible to the
 * CAM layer, which never reads it.
 */
type BoundCamOperation = CAMOperation & { bodyFeatureId?: string };

/** The stable-identity binding of an op, if the store captured one. */
const camOpFeatureId = (op: CAMOperation): string | undefined =>
  (op as BoundCamOperation).bodyFeatureId;
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
export type SketchTool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'polyline' | 'constraint' | 'trim' | 'extend';
export type ViewDirection = 'top' | 'front' | 'right' | 'iso' | 'back' | 'bottom' | 'left';
export type ProjectionMode = 'perspective' | 'orthographic';
export type SketchPlaneId = 'xy' | 'xz' | 'yz';

/** One undo/redo history entry: scene, feature tree, drawing sheet AND the
 * sketch session (F15: undo after an extrude returns to the sketch, exactly as
 * it was — entities, plane and workspace). */
interface HistorySnapshot {
  directBodies: SolidBody[];
  hiddenIds: string[];
  features: Feature[];
  drawingSectionAxis: DrawingSectionAxis;
  drawingDetails: DrawingDetail[];
  drawingNotes: DrawingNote[];
  /** Per-view sheet placements (B6+B8) — restored with the rest of the sheet. */
  drawingViewPlacements: DrawingViewPlacement[];
  /** CAM setup + the derived toolpath cache (restored together so undo of an
   * op edit also rewinds its generated toolpath to the pre-edit generation). */
  camSetup: CAMSetup;
  camToolpaths: Record<string, CamToolpathCache>;
  /** Deep clone — sketch entities are mutated in place while sketching, so a
   * bare reference would not freeze the snapshot's state. */
  currentSketch: Sketch | null;
  /** Sketch-session history captured at snapshot time. Entries are clones
   * (pushSketchUndo clones before pushing and stacks are only ever replaced,
   * never mutated in place), so reference-capturing the arrays is safe.
   * Restored with the sketch — otherwise a model-undo into an older sketch
   * keeps the NEWER session's stacks and Ctrl+Z inside the restored sketch
   * would "undo" forward to entities that no longer belong to it. */
  sketchUndoStack: Sketch[];
  sketchRedoStack: Sketch[];
  sketchActive: boolean;
  workspace: WorkspaceMode;
  sketchPlaneId: SketchPlaneId;
}

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
  /**
   * Edit a driving sketch dimension (a 'distance' or 'radius' constraint with a
   * value) on the current sketch, re-solving the sketch so dependent geometry
   * follows. Returns false (nothing changed, no undo entry) for an unknown id,
   * a non-dimensional constraint, or a non-positive/invalid value.
   */
  updateSketchConstraintValue: (id: string, value: number) => boolean;
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
  /** Resize a sketch line to an exact length, scaling about its midpoint (Fusion); false if not a line / invalid. */
  resizeSketchLine: (id: string, length: number) => boolean;
  /** Set a sketch circle/arc's radius, keeping its centre; false if not round / invalid. */
  resizeSketchCircle: (id: string, radius: number) => boolean;
  /** Offset (equidistant copy) a line/circle/arc by a signed distance; returns the new entity id, or null. */
  offsetSketchEntity: (id: string, distance: number) => string | null;
  /**
   * Fusion-style sketch Offset of the current selection (first multi-select id
   * or the primary one): a mitered copy of a closed line loop, or a grown /
   * shrunk circle, arc or rectangle. Positive = outward/larger. Selects the new
   * entities; false (nothing changed) when there is no offsetable selection or
   * the copy would collapse.
   */
  offsetSelectedSketch: (distance: number) => boolean;
  /**
   * Fusion-style sketch Mirror: reflect the current multi-selection (the
   * entities to mirror) about the given line entity (`mirrorLineId` is the
   * axis, picked in the viewport — the line itself is skipped by the engine
   * when it is part of the selection). The copies are ADDED and become the
   * selection; one Ctrl+Z step. False (nothing changed) when there is no
   * sketch or selection, or the engine refuses (missing/degenerate axis,
   * nothing mirrorable).
   */
  mirrorSelectedSketch: (mirrorLineId: string) => boolean;
  /**
   * Fusion-style sketch Trim of the current selection (first multi-select id
   * or the primary one) at `cutPoint`: remove the piece of the entity the
   * point lies on — bounded by crossings with other lines, and the whole
   * entity when nothing crosses it (a crossed circle becomes the
   * complementary arc). False (nothing changed) when the selection isn't
   * trimmable; the trimmed entity drops out of the selection.
   */
  trimSketchAt: (cutPoint: { x: number; y: number }) => boolean;
  /**
   * Fusion-style sketch Extend of the current selection toward `toward`: move
   * the line endpoint nearest the click (or sweep an arc's nearer end) out to
   * the first crossing with another line. False when there is nothing to
   * extend to (nothing changes).
   */
  extendSketchTo: (toward: { x: number; y: number }) => boolean;
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
  /** Bumped on every feature-tree mutation. The tree object mutates in place
   * (same reference), so components rendering the tree subscribe to this. */
  featureVersion: number;
  addFeature: (feature: Feature) => void;
  removeFeature: (id: string) => void;
  /**
   * Edit a feature in place via a pure mutator and recompute. Fillet/chamfer
   * radius/distance edits run through the same maxFilletRadius/maxChamferDistance
   * gate as the apply actions: an oversize (or no-treatable-edges) edit is
   * refused — false, nothing mutated, no undo entry, limit toast shown.
   */
  updateFeature: (id: string, mutator: (f: Feature) => Feature) => boolean;
  /**
   * Reorder a feature in the timeline (Fusion drag-reorder). Dependency order
   * is enforced; returns false and pushes no undo entry for an illegal or
   * no-op move.
   */
  moveFeature: (id: string, toIndex: number) => boolean;
  recomputeTree: () => void;
  /** Combined render list: feature-tree bodies + direct bodies. */
  bodies: SolidBody[];
  /** Bodies created/edited outside the feature tree (AI primitives, arrays, …). */
  directBodies: SolidBody[];
  addDirectBody: (body: SolidBody) => void;
  addDirectBodies: (bodies: SolidBody[]) => void;
  /** Create a default-sized primitive of `kind`, add it, and return its id. */
  addPrimitive: (kind: PrimitiveKind) => string;
  /** Replace a direct body in place (undoable). Returns false — with no
   * mutation and no undo entry — when the id belongs to a feature-tree body
   * (edit its feature instead) or doesn't exist. */
  replaceBody: (oldId: string, newBody: SolidBody) => boolean;
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
  /** Silent in-place translate of the selected direct bodies (no undo entry). */
  translateSelectionLive: (dx: number, dy: number, dz: number) => number;
  /**
   * Viewport drag-move of the selection (Fusion-style preview transform):
   * `beginSelectionDrag` arms the drag; `dragSelectionBy` accumulates deltas
   * into `dragOffset` WITHOUT touching body geometry — the viewport shows the
   * motion as a mesh transform, so no per-frame mesh/BVH rebuilds;
   * `endSelectionDrag` bakes the accumulated offset into the bodies as ONE
   * undoable translate (a press without motion leaves no history entry);
   * `cancelSelectionDrag` (Esc) just drops the preview.
   */
  bodyDragging: boolean;
  /** Whether the current drag actually moved anything (a no-move press is a click). */
  dragMovedThisDrag: boolean;
  /** Accumulated preview offset of the active drag (null when not dragging). */
  dragOffset: Vec3 | null;
  beginSelectionDrag: () => void;
  dragSelectionBy: (dx: number, dy: number, dz: number) => number;
  endSelectionDrag: () => void;
  cancelSelectionDrag: () => void;
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
  /** Paste the clipboard at the originals' exact positions (SolidWorks Ctrl+Shift+V); returns the new ids. */
  pasteInPlace: () => string[];
  /**
   * Undo/redo history. Snapshots cover direct bodies, visibility AND the
   * feature list — sketch/extrude/fillet/… tree edits are first-class undoable
   * changes, like Fusion/SolidWorks timelines. Feature objects are treated as
   * immutable once in the tree (edits replace them via updateFeature), so a
   * shallow array copy is a complete snapshot.
   */
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  /** Revert the last change (scene, feature tree, or drawing sheet); returns true if something was undone. */
  undo: () => boolean;
  /** Re-apply the last undone change; returns true if something was redone. */
  redo: () => boolean;
  clearScene: () => void;
  /**
   * Replace the WHOLE scene with pre-arranged bodies ("arrange on plate") as
   * ONE undoable step: the snapshot pushed first captures the pre-arrange
   * bodies + feature tree, so undo restores them. Mirrors clearScene's
   * tree/reset semantics EXCEPT the undo/redo history and project state
   * (name, dirty flag) survive — this is an edit, not a new document.
   */
  arrangeScene: (bodies: SolidBody[]) => void;
  /** Start a fresh, clean, untitled document (empties everything). */
  newProject: () => void;
  loadProject: (features: Feature[], name?: string, directBodies?: SolidBody[], referenceGeometry?: SerializedReferenceGeometry, drawing?: SerializedDrawing, cam?: CAMSetup) => void;

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

  // Drawing sheet state (drawing workspace): section-view axis, detail-view
  // definitions and text notes — serialized with the project and covered by
  // the undo/redo history like every other edit.
  drawingSectionAxis: DrawingSectionAxis;
  setDrawingSectionAxis: (axis: DrawingSectionAxis) => void;
  drawingDetails: DrawingDetail[];
  addDrawingDetail: (d: DrawingDetail) => void;
  removeDrawingDetail: (id: string) => void;
  drawingNotes: DrawingNote[];
  addDrawingNote: (n: DrawingNote) => void;
  updateDrawingNote: (id: string, text: string) => void;
  removeDrawingNote: (id: string) => void;
  /**
   * Stored per-view placements of the 2×2 base views (B6+B8): drag offsets,
   * visibility and per-view scale overrides — undoable, serialized with the
   * project (SerializedDrawing.viewPlacements). Detail views keep their own
   * state (drawingDetails); they follow their base view's placement at
   * render time and hide with it.
   */
  drawingViewPlacements: DrawingViewPlacement[];
  /** Patch one placement by id (identity fields id/viewKey are immutable). */
  updateDrawingViewPlacement: (id: string, patch: Partial<Omit<DrawingViewPlacement, 'id' | 'viewKey'>>) => void;
  /** Restore the default placements (all views visible, centred, auto-fit). */
  resetDrawingViewPlacements: () => void;

  // CAM setup state (cam workspace): stock + ordered operations, covered by
  // undo/redo and serialized with the project (see deserializeCam). The
  // toolpath cache is DERIVED — never serialized, rebuilt by
  // regenerateCamToolpaths / on load; regenerate itself is not undoable.
  camSetup: CAMSetup;
  /** op id → generated toolpath + time estimate (enabled, resolvable ops only). */
  camToolpaths: Record<string, CamToolpathCache>;
  /** Add an operation (id assigned: camop_N); returns the id. Also generates
   * and caches its toolpath when body + tool resolve. */
  addCamOperation: (op: Omit<CAMOperation, 'id'>) => string;
  removeCamOperation: (id: string) => void;
  /** Patch an operation (top-level fields replace, params merge) and refresh
   * its cached toolpath. */
  updateCamOperation: (id: string, patch: CamOperationPatch) => void;
  setCamStock: (stock: CAMSetup['stock']) => void;
  /** Recompute the toolpath cache for every enabled op with a resolvable body
   * and tool. Pure recompute of derived data — no undo entry, no dirty flag. */
  regenerateCamToolpaths: () => void;

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
  /**
   * Generic numeric input dialog (the in-app window.prompt replacement).
   * Context menus open it from event handlers; onApply runs after close.
   */
  numericPrompt: {
    titleKey: string;
    labelKey: string;
    initial: number | string;
    min?: number;
    step?: number;
    onApply: (value: number) => void;
  } | null;
  openNumericPrompt: (p: NonNullable<AppState['numericPrompt']>) => void;
  closeNumericPrompt: () => void;
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
  /** Soft shadow under bodies on the ground plane (Fusion/SolidWorks viewport look). */
  groundShadows: boolean;
  setGroundShadows: (v: boolean) => void;
  /**
   * Live section analysis (Fusion-style): clip everything in the 3D view with
   * a plane `offset` mm along `axis` from the origin (flip = keep the other
   * half). Viewport-only — geometry itself is never modified.
   */
  sectionAnalysis: { active: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean };
  setSectionAnalysis: (patch: Partial<{ active: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean }>) => void;
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
  /** Measure tool: when on, clicks in the viewport feed the active measure mode. */
  measureActive: boolean;
  setMeasureActive: (v: boolean) => void;
  /**
   * AI vision region capture ("circle a face"): when active, the next left-drag
   * in the viewport defines a rectangle (normalized 0..1 of the viewport) that
   * crops the screenshot attached to the next AI message. One-shot — cleared
   * when the drag completes.
   */
  visionSelectActive: boolean;
  setVisionSelectActive: (v: boolean) => void;
  /** Captured crop region (normalized), or null for the full viewport. */
  visionRegion: { x: number; y: number; w: number; h: number } | null;
  setVisionRegion: (r: { x: number; y: number; w: number; h: number } | null) => void;
  /** Points picked by the measure tool (0–3); a fourth pick restarts. */
  measurePts: Vec3[];
  addMeasurePoint: (p: Vec3) => void;
  /** Drop the most recent measure point (Backspace), to re-pick a mis-click. */
  removeLastMeasurePoint: () => void;
  /** Active measure mode: distance (2+ picks), angle (3 picks: vertex + two rays), area (one face pick). */
  measureMode: MeasureMode;
  /** Switch the measure mode; resets any in-progress picks. */
  setMeasureMode: (mode: MeasureMode) => void;
  /** Face targeted by the area mode: ids of the body and its picked face. */
  measureFacePick: MeasureFacePick | null;
  /** Set (or clear with null) the face measured in area mode. */
  setMeasureFacePick: (pick: MeasureFacePick | null) => void;
  /** Extrude the current sketch into a parametric feature. Returns false —
   * leaving the sketch session, tree and history untouched — when there is no
   * sketch, the distance is invalid, the profile can't produce a solid
   * (a toast explains why), or `op` is 'cut' with no body selected as the
   * target. `op` 'cut' subtracts the extruded profile from the selected
   * body: parametrically when the tree produced it, otherwise as an
   * undoable direct edit (the applyModifyFeature dual-path philosophy). */
  performExtrude: (distance: number, symmetric: boolean, op?: 'join' | 'cut') => boolean;
  /** Revolve the current sketch into a parametric feature. Same failure
   * semantics as performExtrude. */
  performRevolve: (angle: number) => boolean;
  /**
   * Sweep the current sketch along a straight path (its extrude direction) with
   * an accumulated twist, producing a parametric sweep feature — a twisted
   * column that a plain extrude can't make. Same failure semantics as
   * performExtrude.
   */
  performSweep: (distance: number, twistDegrees: number) => boolean;

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
   * Drill a hole (Fusion HOLE) in the given body: tree bodies get a parametric
   * hole feature on the timeline, direct bodies an undoable direct edit.
   * Drills from `center` (default: the body's top-face centroid) along
   * `direction` — the clicked face's INWARD normal, normalized — or straight
   * down (−Y) when omitted. `depth` null = through-all. False when the body
   * is missing, the parameters are invalid (diameter/depth must exceed 0.1
   * mm) or `direction` is a zero vector.
   */
  applyHoleToBody: (bodyId: string, diameter: number, depth: number | null, center?: Vec3, direction?: Vec3) => boolean;
  /**
   * Editable drawing dimension write-back: resize the given body so its extent
   * along the world axis equals `value` mm. Tree bodies get (or update) a
   * driving scale feature; direct bodies are resized in place. False when the
   * body no longer exists or the value is invalid.
   */
  setDimensionTarget: (driver: { bodyId: string; axis: 'x' | 'y' | 'z' }, value: number) => boolean;
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

  // Parts library (beginner quick-insert gallery, TinkerCAD-style)
  showPartsLibrary: boolean;
  togglePartsLibrary: () => void;
  /** Most recently inserted part ids, most recent first (persisted). */
  recentPartIds: string[];
  /** Build a library part and insert it at a staggered plate position; returns the body id, or null for an unknown part. */
  insertLibraryPart: (partId: string) => string | null;

  // Onboarding (welcome card + getting-started checklist)
  /** Completed onboarding step ids ('insert' | 'move' | 'ai' | 'save'), persisted. */
  onboardingSteps: string[];
  markOnboardingStep: (step: string) => void;
  /** Welcome card permanently dismissed (persisted). */
  welcomeDismissed: boolean;
  dismissWelcome: () => void;
  /** Bring the welcome card back (command palette). */
  showWelcome: () => void;
  /** Welcome card hidden for this session only (X button). */
  welcomeSessionHidden: boolean;
  hideWelcomeForSession: () => void;

  // Project
  projectName: string;
  setProjectName: (n: string) => void;
  projectDirty: boolean;
  setProjectDirty: (d: boolean) => void;
  /** Fingerprint of the last saved/loaded baseline (null = never baselined). */
  savedFingerprint: string | null;
  /** Mark the CURRENT state as the saved baseline (called after explicit
   * saves and project loads) — undo/redo compare against it for the dot. */
  captureSavedFingerprint: () => void;
  /** Serialize the project to localStorage if dirty; returns true if it saved. */
  autosave: () => boolean;
  /** Restore the last autosaved project; returns true if one was loaded. */
  restoreAutosave: () => boolean;
  /** Whether an autosave snapshot exists to restore. */
  hasAutosave: () => boolean;
  /**
   * Crash-recovery probe (boot-time): what the RestoreBanner offers — the
   * stored autosave's project name, save time and age in minutes (null fields
   * when the stored JSON doesn't carry them; null probe = nothing to offer).
   * The app PROBES and offers recovery; it never silently auto-restores.
   */
  autosaveProbe: { name: string | null; savedAt: number | null; ageMinutes: number | null } | null;
  /** Read the stored autosave's name + timestamp into `autosaveProbe` (boot). */
  probeAutosave: () => void;
  /** Hide the restore banner for this session (the stored autosave is kept). */
  dismissAutosaveProbe: () => void;
  /** Delete the stored autosave (localStorage key) and hide the banner. */
  discardAutosave: () => void;
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
    set((s) => ({
      undoStack: [...s.undoStack, {
        directBodies: s.directBodies,
        hiddenIds: s.hiddenIds,
        features: [...s.featureTree.features],
        drawingSectionAxis: s.drawingSectionAxis,
        drawingDetails: s.drawingDetails,
        drawingNotes: s.drawingNotes,
        drawingViewPlacements: s.drawingViewPlacements,
        camSetup: s.camSetup,
        camToolpaths: s.camToolpaths,
        currentSketch: s.currentSketch ? cloneSketch(s.currentSketch) : null,
        sketchUndoStack: s.sketchUndoStack,
        sketchRedoStack: s.sketchRedoStack,
        sketchActive: s.sketchActive,
        workspace: s.workspace,
        sketchPlaneId: s.sketchPlaneId,
      }].slice(-50),
      redoStack: [],
    }));
  };
  /** Restore a snapshot: direct bodies, visibility, feature list, drawing sheet
   * and the sketch session (F15 — undo after an extrude lands back in it),
   * including that moment's sketch-session history (see HistorySnapshot). */
  const applyUndoSnapshot = (snap: HistorySnapshot) => {
    const tree = get().featureTree;
    tree.features.length = 0;
    tree.features.push(...snap.features);
    tree.recompute();
    set({
      featureTree: tree,
      directBodies: snap.directBodies,
      hiddenIds: snap.hiddenIds,
      drawingSectionAxis: snap.drawingSectionAxis,
      drawingDetails: snap.drawingDetails,
      drawingNotes: snap.drawingNotes,
      drawingViewPlacements: snap.drawingViewPlacements,
      camSetup: snap.camSetup,
      camToolpaths: snap.camToolpaths,
      currentSketch: snap.currentSketch,
      sketchUndoStack: snap.sketchUndoStack,
      sketchRedoStack: snap.sketchRedoStack,
      sketchActive: snap.sketchActive,
      workspace: snap.workspace,
      sketchPlaneId: snap.sketchPlaneId,
      // The tree mutates in place — the version bump is what makes undo/redo
      // repaint the timeline and the feature lists.
      featureVersion: get().featureVersion + 1,
    });
    recombine();
  };
  // Separate history for sketch edits — Ctrl+Z while sketching undoes the sketch.
  const pushSketchUndo = () => {
    const s = get().currentSketch;
    if (s) set((st) => ({ sketchUndoStack: [...st.sketchUndoStack, cloneSketch(s)].slice(-50), sketchRedoStack: [] }));
  };

  /**
   * The body a CAM op targets (F3 stable identity), resolved in two steps:
   * 1. exact `bodyId` in the render list (feature-tree bodies + direct
   *    bodies — the same list the CAM panel's body selector offers);
   * 2. when the exact id no longer exists, the CURRENT body of the feature
   *    whose result produced `bodyId` when the op was added (the
   *    `bodyFeatureId` binding). Tree recompute rotates result-body ids on
   *    every upstream parametric edit, so step 1 alone made every op on a
   *    tree body dangle forever after one edit; the feature id is stable
   *    across recomputes. Within the feature's result a body still carrying
   *    the op's original id wins (modify features keep the parent's id),
   *    else the feature's first body. Direct bodies never get a binding, so
   *    they keep today's exact-id-only path. Null = unresolvable.
   */
  const resolveCamOpBody = (op: CAMOperation): SolidBody | null => {
    const exact = get().bodies.find((b) => b.id === op.bodyId);
    if (exact) return exact;
    const featureId = camOpFeatureId(op);
    if (!featureId) return null;
    const result = get().featureTree.getResult(featureId);
    if (!result || result.bodies.length === 0) return null;
    return result.bodies.find((b) => b.id === op.bodyId) ?? result.bodies[0]!;
  };

  /** Generate + cache one operation's toolpath, or null when the op is
   * disabled or its body/tool cannot be resolved (via resolveCamOpBody — the
   * render list first, then the stable feature binding). A malformed op
   * degrades to "no cache", never a throw. */
  const resolveCamToolpath = (op: CAMOperation): CamToolpathCache | null => {
    if (!op.enabled) return null;
    const body = resolveCamOpBody(op);
    const tool = getTool(op.toolId);
    if (!body || !tool) return null;
    try {
      const toolpath = generateOperationToolpath(op, body, tool);
      return { toolpath, timeMin: estimateMachiningTime(toolpath) };
    } catch {
      return null;
    }
  };

  /** Rebuild the whole toolpath cache from the current setup (drops entries of
   * removed/unresolvable ops). */
  const recomputeCamToolpaths = (): Record<string, CamToolpathCache> => {
    const next: Record<string, CamToolpathCache> = {};
    for (const op of get().camSetup.operations) {
      const cache = resolveCamToolpath(op);
      if (cache) next[op.id] = cache;
    }
    return next;
  };

  /**
   * F3 cache repair: rewrite `op.bodyId` to the body its feature binding NOW
   * produces, for ops whose exact id no longer exists but whose feature path
   * resolves. This is repair of derived plumbing inside regenerate — which is
   * documented no-undo — NOT a user edit, so no undo entry is pushed and
   * projectDirty stays untouched; camSetup is replaced immutably, so history
   * snapshots keep their own (older, self-consistent) references. Ops without
   * a binding (direct-body targets) or with a dead feature are left as-is —
   * they honestly surface the panel's stale flag instead of silently
   * retargeting. Returns the operations array, same reference when nothing
   * repointed.
   */
  const repointCamOperationBodies = (): CAMOperation[] => {
    const ops = get().camSetup.operations;
    let changed = false;
    const next = ops.map((op): CAMOperation => {
      if (get().bodies.some((b) => b.id === op.bodyId)) return op; // still exact
      const resolved = resolveCamOpBody(op); // feature-binding fallback
      if (!resolved || resolved.id === op.bodyId) return op;
      changed = true;
      return { ...op, bodyId: resolved.id };
    });
    return changed ? next : ops;
  };

  /** Store-side translation lookup (the same keys useT() resolves in React).
   * The store layer has no hook context, so read the locale from state — the
   * established non-React pattern (lib/projectActions, lib/io/importFiles). */
  const toastText = (key: string, vars?: Record<string, string | number>): string => {
    const locale = get().locale;
    let text = translations[locale]?.[key] ?? translations.en?.[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
    }
    return text;
  };

  // --- projectFingerprint memo -------------------------------------------------
  // serializeProject on a large scene costs ~100 ms and builds a huge string,
  // and undo/redo + autosave ask for the fingerprint far more often than the
  // project actually changes (snapshots share body references by design). The
  // memo recomputes only when one of serializeProject's inputs changes
  // identity. The feature tree's `features` array is mutated IN PLACE (same
  // reference for the tree's whole life), so the reference alone is not
  // enough: length + the last feature object + featureVersion (bumped by every
  // tree-mutating action and by applyUndoSnapshot) together cover every
  // in-place content change — including performExtrude/Revolve/Sweep, which
  // add features without a version bump but always change the length.
  type FingerprintKeys = {
    projectName: string;
    directBodies: SolidBody[];
    featuresRef: Feature[];
    featureCount: number;
    lastFeature: Feature | undefined;
    featureVersion: number;
    planes: PlaneDefinition[];
    axes: AxisDefinition[];
    points: PointDefinition[];
    coordSystems: CoordinateSystemDefinition[];
    annotations: AnnotationDefinition[];
    drawingSectionAxis: DrawingSectionAxis;
    drawingDetails: DrawingDetail[];
    drawingNotes: DrawingNote[];
    drawingViewPlacements: DrawingViewPlacement[];
    camSetup: CAMSetup;
  };
  let fingerprintMemo: { keys: FingerprintKeys; value: string } | null = null;

  // Autosave bookkeeping (non-reactive — never rendered): the fingerprint of
  // the last SUCCESSFUL localStorage write, and whether the quota toast has
  // already been raised this session (failures repeat every tick; the warning
  // must not).
  let lastAutosaveFingerprint: string | null = null;
  let autosaveQuotaWarned = false;

  /** Stable fingerprint of the CURRENT project state (everything the file
   * format carries, timestamps excluded) — the baseline undo/redo compare
   * against for the dirty dot. Memoized on serializeProject's input
   * identities; see the memo block above for why the feature keys are more
   * than the array reference. */
  const projectFingerprint = (): string => {
    const s = get();
    const features = s.featureTree.features;
    const keys: FingerprintKeys = {
      projectName: s.projectName,
      directBodies: s.directBodies,
      featuresRef: features,
      featureCount: features.length,
      lastFeature: features.length > 0 ? features[features.length - 1] : undefined,
      featureVersion: s.featureVersion,
      planes: s.planes,
      axes: s.axes,
      points: s.points,
      coordSystems: s.coordSystems,
      annotations: s.annotations,
      drawingSectionAxis: s.drawingSectionAxis,
      drawingDetails: s.drawingDetails,
      drawingNotes: s.drawingNotes,
      drawingViewPlacements: s.drawingViewPlacements,
      camSetup: s.camSetup,
    };
    const prev = fingerprintMemo;
    if (
      prev &&
      prev.keys.projectName === keys.projectName &&
      prev.keys.directBodies === keys.directBodies &&
      prev.keys.featuresRef === keys.featuresRef &&
      prev.keys.featureCount === keys.featureCount &&
      prev.keys.lastFeature === keys.lastFeature &&
      prev.keys.featureVersion === keys.featureVersion &&
      prev.keys.planes === keys.planes &&
      prev.keys.axes === keys.axes &&
      prev.keys.points === keys.points &&
      prev.keys.coordSystems === keys.coordSystems &&
      prev.keys.annotations === keys.annotations &&
      prev.keys.drawingSectionAxis === keys.drawingSectionAxis &&
      prev.keys.drawingDetails === keys.drawingDetails &&
      prev.keys.drawingNotes === keys.drawingNotes &&
      prev.keys.drawingViewPlacements === keys.drawingViewPlacements &&
      prev.keys.camSetup === keys.camSetup
    ) {
      return prev.value;
    }
    const p = serializeProject(s.projectName, features, [], s.directBodies, {
      planes: s.planes, axes: s.axes, points: s.points, coordSystems: s.coordSystems, annotations: s.annotations,
    }, { sectionAxis: s.drawingSectionAxis, details: s.drawingDetails, notes: s.drawingNotes, viewPlacements: s.drawingViewPlacements }, s.camSetup);
    const value = JSON.stringify({ ...p, metadata: undefined });
    fingerprintMemo = { keys, value };
    return value;
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
  /**
   * Face ids from the Ctrl+click sub-selection that live on the selected body —
   * the shell feature's open faces. [] (no faces removed → solid inward offset)
   * when nothing face-scoped is selected.
   */
  const scopedFaceIdsFor = (body: SolidBody): string[] => {
    const sel = get().selectedFaceIds;
    if (sel.length === 0) return [];
    const ids = body.faces.filter((f) => sel.includes(f.id)).map((f) => f.id);
    return ids.length > 0 ? ids : [];
  };
  const scopedFaceIds = (): string[] => {
    const body = selectedBody();
    return body ? scopedFaceIdsFor(body) : [];
  };
  const axisDirection = (axis: 'x' | 'y' | 'z'): Vec3 =>
    axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const planeNormal = (plane: 'xy' | 'xz' | 'yz'): Vec3 =>
    plane === 'xy' ? { x: 0, y: 0, z: 1 } : plane === 'xz' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  /**
   * Direct-only mutation guard (W1/T6): a tree-produced body cannot be edited
   * as a direct body — the tree regenerates it on every recompute, so the old
   * code path (keep the edit as a new direct body) left an overlapping
   * duplicate in the scene. True (with a refusal toast) when `bodyId` resolves
   * to a tree body; false for direct bodies and unknown ids (callers handle
   * missing ids with their own silent failure path).
   */
  const refusedTreeBody = (bodyId: string): boolean => {
    const s = get();
    if (s.directBodies.some((b) => b.id === bodyId)) return false;
    if (!s.bodies.some((b) => b.id === bodyId)) return false;
    showToast(toastText('toast.treeBodyRefused'), 'warning');
    return true;
  };

  /**
   * Shared failure path for performExtrude/Revolve/Sweep: recompute swallowed
   * an evaluator error into FeatureResult.error, so roll the attempt back
   * ATOMICALLY — remove BOTH added features (keeping the sketch feature would
   * leave a duplicate sketch node on retry), drop the just-pushed undo
   * snapshot, restore the redo history pushUndo cleared (the attempt leaves
   * NO trace — an undone edit made just before the failed feature stays
   * redoable), keep the sketch session (workspace/dialog state untouched) and
   * tell the user why. `savedRedo` is the redoStack captured before pushUndo
   * (stacks are replaced, never mutated in place, so the reference is intact).
   */
  const rollbackFailedSketchFeature = (sketchFeatId: string, opFeatId: string, msg: string, toastKey: string, savedRedo: HistorySnapshot[]): void => {
    const tree = get().featureTree;
    tree.removeFeature(sketchFeatId);
    tree.removeFeature(opFeatId);
    tree.recompute();
    set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: savedRedo, featureVersion: s.featureVersion + 1 }));
    recombine();
    showToast(toastText(toastKey, { msg }), 'warning');
  };

  /**
   * First parent feature that produced a body — the SAME resolution the tree's
   * evaluators use (FeatureTree's private firstParentBody): parent ids in
   * order, first one whose result has a body. Read here outside evaluation,
   * from the last recompute's results, so a pre-check sees exactly the body
   * the evaluator would see for an unchanged upstream (recompute memoizes
   * parent results to those same objects).
   */
  const firstParentResultBody = (tree: FeatureTree, parentIds: string[]): SolidBody | undefined => {
    for (const id of parentIds) {
      const body = tree.getResult(id)?.bodies[0];
      if (body) return body;
    }
    return undefined;
  };

  /**
   * Pass-#28 size gate, extended to PARAM edits: updateFeature can change an
   * EXISTING fillet/chamfer feature's radius/distance (ParametersPanel, the AI
   * update_feature tool), which the apply-time guards never re-check — an
   * oversize edit could still mangle the body and report success. The honest
   * pre-check measures the next value against maxFilletRadius/maxChamferDistance
   * on the parent body with the feature's stored edge selection (the apply
   * paths' exact rule). Only edits that actually change the gated value
   * (radius/distance or the edge selection) are checked — a rename or
   * suppress-toggle of a legacy oversize feature must not be held hostage.
   * Refusal is atomic by construction: the caller has not pushed undo, mutated
   * or recomputed yet, so returning false leaves the tree untouched.
   */
  const filletChamferEditAllowed = (tree: FeatureTree, current: Feature, next: Feature): boolean => {
    if (next.type === 'fillet' && current.type === 'fillet') {
      if (next.params.radius === current.params.radius && next.params.edgeIds === current.params.edgeIds) return true;
      const parentBody = firstParentResultBody(tree, next.parentIds);
      // No parent body to measure against (erroring/suppressed upstream) — let
      // the recompute surface the evaluator's own error, exactly as before.
      if (!parentBody) return true;
      const limit = maxFilletRadius(parentBody, next.params.edgeIds);
      if (limit.max === null) {
        showToast(toastText('toast.filletNoEdges'), 'warning');
        return false;
      }
      if (next.params.radius > limit.max) {
        showToast(toastText('toast.filletOversize', { max: Math.round(limit.max * 100) / 100 }), 'warning');
        return false;
      }
      return true;
    }
    if (next.type === 'chamfer' && current.type === 'chamfer') {
      if (next.params.distance === current.params.distance && next.params.edgeIds === current.params.edgeIds) return true;
      const parentBody = firstParentResultBody(tree, next.parentIds);
      if (!parentBody) return true;
      const limit = maxChamferDistance(parentBody, next.params.edgeIds);
      if (limit.max === null) {
        showToast(toastText('toast.filletNoEdges'), 'warning');
        return false;
      }
      if (next.params.distance > limit.max) {
        showToast(toastText('toast.chamferOversize', { max: Math.round(limit.max * 100) / 100 }), 'warning');
        return false;
      }
      return true;
    }
    // Any other edit (including a type switch, whose new parents resolve like
    // the evaluator's) is not gated here.
    return true;
  };

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
      pushUndo();
      tree.addFeature(buildFeature([parentId]));
      tree.recompute();
      set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
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
      projectDirty: true,
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
  setWorkspace: (workspace) => {
    if (workspace === 'sketch') {
      // Entering the sketch workspace actually STARTS (or resumes) a sketch:
      // previously the toolbar/S-key path left `currentSketch` null and every
      // drawing tool silently no-op'd until a datum plane was clicked in the
      // viewport. A default-plane sketch makes the tools work immediately;
      // the viewport's plane-click flow still picks an explicit plane.
      const { sketchActive, currentSketch, sketchPlaneId } = get();
      if (!sketchActive || !currentSketch) {
        const planeId = currentSketch ? sketchPlaneId : (sketchPlaneId || 'xz');
        set({
          workspace,
          sketchActive: true,
          sketchPlaneId: planeId,
          // RESUMING the same sketch keeps its undo history; only a FRESH
          // sketch clears it — a new session must not inherit the previous
          // one's Ctrl+Z entries (setCurrentSketch's rule, honored here too
          // because this branch sets currentSketch via raw set).
          ...(currentSketch
            ? {}
            : { currentSketch: createSketch(planeId), sketchUndoStack: [], sketchRedoStack: [] }),
        });
        return;
      }
    }
    set({ workspace });
  },

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
  updateSketchConstraintValue: (id, value) => {
    const sketch = get().currentSketch;
    if (!sketch) return false;
    const c = sketch.constraints.get(id);
    // Only driving dimensions (distance/radius with a numeric value) are editable.
    if (!c || (c.type !== 'distance' && c.type !== 'radius') || typeof c.value !== 'number') return false;
    if (!(value > 0.01)) return false; // non-positive / NaN sizes are rejected
    pushSketchUndo();
    c.value = value;
    // Re-solve so dependent geometry follows the new dimension. The solver
    // reports the new point positions in its result map (radii it writes in
    // place) — write the points back into the entities (the viewport renders
    // them directly) and publish with the same currentSketch spread the other
    // sketch actions use.
    const solved = solveSketch(sketch);
    for (const [pid, p] of solved) {
      const e = sketch.entities.get(pid);
      if (e?.type === 'point') {
        e.x = p.x;
        e.y = p.y;
      }
    }
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
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
    if (!moved) {
      // Nothing moved — drop the now-pointless undo snapshot.
      set((s) => ({ sketchUndoStack: s.sketchUndoStack.slice(0, -1) }));
      return false;
    }
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  resizeSketchLine: (id, length) => {
    const sketch = get().currentSketch;
    if (!sketch || !(length > 0.01)) return false;
    const e = sketch.entities.get(id);
    if (e?.type !== 'line') return false;
    const p1 = sketch.entities.get(e.p1Id);
    const p2 = sketch.entities.get(e.p2Id);
    if (p1?.type !== 'point' || p2?.type !== 'point') return false;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return false;
    // Scale about the midpoint so the line grows both ways (Fusion behaviour).
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const ux = dx / len, uy = dy / len;
    pushSketchUndo();
    p1.x = mx - (ux * length) / 2; p1.y = my - (uy * length) / 2;
    p2.x = mx + (ux * length) / 2; p2.y = my + (uy * length) / 2;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  resizeSketchCircle: (id, radius) => {
    const sketch = get().currentSketch;
    if (!sketch || !(radius > 0.01)) return false;
    const e = sketch.entities.get(id);
    if (e?.type !== 'circle' && e?.type !== 'arc') return false;
    pushSketchUndo();
    e.radius = radius;
    set({ currentSketch: { ...sketch }, projectDirty: true });
    return true;
  },
  offsetSketchEntity: (id, distance) => {
    const sketch = get().currentSketch;
    if (!sketch) return null;
    pushSketchUndo();
    const newId = offsetEntity(sketch, id, distance);
    if (newId === null) {
      // Nothing was created — drop the now-pointless undo snapshot.
      set((s) => ({ sketchUndoStack: s.sketchUndoStack.slice(0, -1) }));
      return null;
    }
    set({ currentSketch: { ...sketch }, selectedSketchId: newId, projectDirty: true });
    return newId;
  },
  offsetSelectedSketch: (distance) => {
    const s = get();
    const sketch = s.currentSketch;
    if (!sketch) return false;
    // Same target resolution as the other sketch actions: first multi-select
    // id, falling back to the primary selection.
    const id = s.selectedSketchIds[0] ?? s.selectedSketchId;
    if (!id) return false;
    pushSketchUndo();
    const newIds = offsetSketchProfile(sketch, id, distance);
    if (newIds === null) {
      // Nothing was created — drop the now-pointless undo snapshot.
      set((st) => ({ sketchUndoStack: st.sketchUndoStack.slice(0, -1) }));
      return false;
    }
    set({
      currentSketch: { ...sketch },
      selectedSketchId: newIds[0] ?? null,
      selectedSketchIds: newIds,
      projectDirty: true,
    });
    return true;
  },
  mirrorSelectedSketch: (mirrorLineId) => {
    const s = get();
    const sketch = s.currentSketch;
    if (!sketch) return false;
    // Same target resolution as the other sketch actions: the multi-selection
    // (falling back to the primary one). The mirror LINE is the parameter —
    // the axis, not one of the mirrored entities.
    const ids = s.selectedSketchIds.length > 0
      ? [...s.selectedSketchIds]
      : s.selectedSketchId
        ? [s.selectedSketchId]
        : [];
    if (ids.length === 0) return false;
    pushSketchUndo();
    const newIds = mirrorSketchEntities(sketch, ids, mirrorLineId);
    if (newIds === null) {
      // Nothing was mirrored — drop the now-pointless undo snapshot.
      set((st) => ({ sketchUndoStack: st.sketchUndoStack.slice(0, -1) }));
      return false;
    }
    // The reflected copies become the selection.
    set({
      currentSketch: { ...sketch },
      selectedSketchId: newIds[0] ?? null,
      selectedSketchIds: newIds,
      projectDirty: true,
    });
    return true;
  },
  trimSketchAt: (cutPoint) => {
    const s = get();
    const sketch = s.currentSketch;
    if (!sketch) return false;
    // Same target resolution as the other sketch actions: first multi-select
    // id, falling back to the primary selection.
    const id = s.selectedSketchIds[0] ?? s.selectedSketchId;
    if (!id) return false;
    pushSketchUndo();
    if (!trimSketchEntityAt(sketch, id, cutPoint)) {
      // Nothing was trimmed — drop the now-pointless undo snapshot.
      set((st) => ({ sketchUndoStack: st.sketchUndoStack.slice(0, -1) }));
      return false;
    }
    // The trimmed entity was replaced (or deleted) — drop it from the selection.
    set((st) => ({
      currentSketch: { ...sketch },
      selectedSketchId: st.selectedSketchId === id ? null : st.selectedSketchId,
      selectedSketchIds: st.selectedSketchIds.filter((x) => x !== id),
      projectDirty: true,
    }));
    return true;
  },
  extendSketchTo: (toward) => {
    const s = get();
    const sketch = s.currentSketch;
    if (!sketch) return false;
    const id = s.selectedSketchIds[0] ?? s.selectedSketchId;
    if (!id) return false;
    pushSketchUndo();
    if (!extendSketchEntityTo(sketch, id, toward)) {
      // Nothing was extended — drop the now-pointless undo snapshot.
      set((st) => ({ sketchUndoStack: st.sketchUndoStack.slice(0, -1) }));
      return false;
    }
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
    if (!ok) {
      // Nothing was filleted — drop the now-pointless undo snapshot.
      set((s) => ({ sketchUndoStack: s.sketchUndoStack.slice(0, -1) }));
      return false;
    }
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
  featureVersion: 0,
  bodies: [],
  directBodies: [],
  addFeature: (feature) => {
    pushUndo();
    const tree = get().featureTree;
    tree.addFeature(feature);
    tree.recompute();
    set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
    recombine();
  },
  removeFeature: (id) => {
    pushUndo();
    const tree = get().featureTree;
    tree.removeFeature(id);
    tree.recompute();
    set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
    recombine();
  },
  updateFeature: (id, mutator) => {
    const tree = get().featureTree;
    const current = tree.getFeature(id);
    if (!current) return false;
    // Evaluate the (pure) mutator once up front so the fillet/chamfer size
    // gate can inspect the NEXT feature before anything is pushed or mutated;
    // the tree edit below then installs that exact object.
    const next = mutator(current);
    if (!filletChamferEditAllowed(tree, current, next)) return false;
    pushUndo();
    tree.updateFeature(id, () => next);
    tree.recompute();
    set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
    recombine();
    return true;
  },
  moveFeature: (id, toIndex) => {
    pushUndo();
    const tree = get().featureTree;
    if (!tree.moveFeature(id, toIndex)) {
      // Illegal or no-op drop — drop the snapshot we just pushed (same rule as
      // a click-without-motion in the viewport drag).
      set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
      return false;
    }
    tree.recompute();
    // The tree object mutates in place, so `featureTree: tree` alone never
    // notifies subscribers — the version counter is what makes reorder render.
    set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
    recombine();
    return true;
  },
  recomputeTree: () => {
    get().featureTree.recompute();
    set((s) => ({ featureVersion: s.featureVersion + 1 }));
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
    get().markOnboardingStep('insert');
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
    get().markOnboardingStep('insert');
  },
  replaceBody: (oldId, newBody) => {
    const { directBodies } = get();
    if (!directBodies.some((b) => b.id === oldId)) {
      // Fusion semantics: a tree-produced body cannot be replaced by a direct
      // edit — the tree would regenerate the original and the edit would sit
      // on top of it as an overlapping duplicate. Refuse (no mutation, no undo
      // entry); the proper path for tree bodies is editing their feature.
      // Unknown ids are refused silently (callers treat false as failure).
      if (get().bodies.some((b) => b.id === oldId)) {
        showToast(toastText('toast.treeBodyRefused'), 'warning');
      }
      return false;
    }
    pushUndo();
    set({ directBodies: directBodies.map((b) => (b.id === oldId ? newBody : b)), projectDirty: true });
    recombine();
    return true;
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
    // A tree body is refused by replaceBody (with its own toast) — report the
    // failure instead of pretending the resize happened.
    if (!get().replaceBody(bodyId, resized)) return false;
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
    // Unknown id (or a tree-produced body): nothing changes — skip the undo
    // snapshot so a failed delete can't consume a Ctrl+Z step or light the
    // dirty dot (the same no-op-pollution rule as the sketch actions).
    if (!get().directBodies.some((b) => b.id === id)) return;
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
  /** Silent in-place translate of the selected direct bodies (no undo entry);
   * shared by nudgeSelected and the viewport drag flow. */
  translateSelectionLive: (dx, dy, dz) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const n = directBodies.filter((b) => sel.has(b.id)).length;
    if (n === 0) return 0; // nothing direct selected
    const move = (v: Vec3): Vec3 => ({ x: v.x + dx, y: v.y + dy, z: v.z + dz });
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

  nudgeSelected: (dx, dy, dz) => {
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    if (!directBodies.some((b) => sel.has(b.id))) return 0;
    pushUndo();
    const n = get().translateSelectionLive(dx, dy, dz);
    if (n > 0) get().markOnboardingStep('move');
    return n;
  },

  bodyDragging: false,
  dragMovedThisDrag: false,
  dragOffset: null,
  beginSelectionDrag: () => {
    set({ bodyDragging: true, dragMovedThisDrag: false, dragOffset: null });
  },
  dragSelectionBy: (dx, dy, dz) => {
    if (!get().bodyDragging) return 0;
    const { selectedIds, directBodies } = get();
    const sel = new Set(selectedIds);
    const n = directBodies.filter((b) => sel.has(b.id)).length;
    if (n === 0) return 0; // nothing direct selected
    // Preview only: accumulate the offset; the viewport applies it as a mesh
    // transform. Geometry is baked once, on endSelectionDrag.
    const prev = get().dragOffset ?? { x: 0, y: 0, z: 0 };
    set({
      dragOffset: { x: prev.x + dx, y: prev.y + dy, z: prev.z + dz },
      dragMovedThisDrag: true,
    });
    return n;
  },
  endSelectionDrag: () => {
    const { bodyDragging, dragMovedThisDrag, dragOffset } = get();
    if (!bodyDragging) return;
    if (dragMovedThisDrag && dragOffset) {
      // Bake the preview into the bodies as a single undoable translate.
      pushUndo();
      get().translateSelectionLive(dragOffset.x, dragOffset.y, dragOffset.z);
      get().markOnboardingStep('move');
    }
    set({ bodyDragging: false, dragMovedThisDrag: false, dragOffset: null });
  },
  cancelSelectionDrag: () => {
    if (!get().bodyDragging) return;
    // The preview never touched geometry — dropping the offset restores the view.
    set({ bodyDragging: false, dragMovedThisDrag: false, dragOffset: null });
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
    // Tree bodies are refused by replaceBody (with its own toast) — report the
    // failure so the hollow dialog can show its own notice.
    if (!get().replaceBody(bodyId, result)) return null;
    set((s) => ({ selectedIds: s.selectedIds.map((sid) => (sid === bodyId ? result!.id : sid)) }));
    return result.id;
  },
  linearPatternBody: (bodyId, axis, count, spacing) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    if (!body || !(count >= 1) || !(spacing > 0)) return [];
    // Tree bodies refuse (toast): keeping the tree original + adding the copies
    // would duplicate the body in the scene — pattern it via a feature instead.
    if (refusedTreeBody(bodyId)) return [];
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
    if (refusedTreeBody(bodyId)) return []; // tree bodies: see linearPatternBody
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
    if (refusedTreeBody(bodyId)) return []; // tree bodies: see linearPatternBody
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
    const { selectedIds, directBodies, featureTree } = get();
    const sel = new Set(selectedIds);
    const copied = directBodies.filter((b) => sel.has(b.id));
    // F9: tree bodies copy too — baked into the clipboard as a deep snapshot
    // with a FRESH id at copy time (zero-offset translateBody, the
    // pasteInPlace deep-copy trick; color carried explicitly because
    // translateBody drops it). The pasted copy is therefore a plain direct
    // body: it never aliases the tree's result, survives later tree edits,
    // and is editable the way any imported body is. The name keeps the
    // original — paste appends ' copy' and withUniqueNames dedupes, exactly
    // like the direct-body flow. Bodies of suppressed/consumed features are
    // not in getLatestBodies, i.e. not selectable in the viewport, so the
    // latest output mirrors what the user picked. Previously a tree-body-only
    // selection copied NOTHING and Ctrl+V silently no-op'd.
    const baked = featureTree
      .getLatestBodies()
      .filter((b) => sel.has(b.id))
      .map((b) => ({ ...translateBody(b, { x: 0, y: 0, z: 0 }), color: b.color }));
    // Reset the cascade so the first paste lands one step from the originals.
    set({ clipboard: [...copied, ...baked], pasteCount: 0 });
    return copied.length + baked.length;
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
  pasteInPlace: () => {
    const { clipboard } = get();
    if (clipboard.length === 0) return [];
    // SolidWorks Ctrl+Shift+V: copies land at the originals' exact positions —
    // zero-offset translate gives the deep copy without moving anything.
    const copies = clipboard.map((b) => ({ ...translateBody(b, { x: 0, y: 0, z: 0 }, `${b.name} copy`), color: b.color }));
    pushUndo();
    set((s) => {
      const named = withUniqueNames(copies, s.directBodies.map((b) => b.name));
      return { directBodies: [...s.directBodies, ...named], selectedIds: named.map((c) => c.id), projectDirty: true };
    });
    recombine();
    return copies.map((c) => c.id);
  },
  undoStack: [],
  redoStack: [],
  undo: () => {
    const { undoStack, directBodies, hiddenIds, featureTree, drawingSectionAxis, drawingDetails, drawingNotes, drawingViewPlacements, camSetup, camToolpaths, currentSketch, sketchUndoStack, sketchRedoStack, sketchActive, workspace, sketchPlaneId } = get();
    if (undoStack.length === 0) return false;
    const prev = undoStack[undoStack.length - 1]!;
    // Capture the current state BEFORE restoring — applyUndoSnapshot clears
    // the (shared) feature array in place.
    const current: HistorySnapshot = {
      directBodies,
      hiddenIds,
      features: [...featureTree.features],
      drawingSectionAxis,
      drawingDetails,
      drawingNotes,
      drawingViewPlacements,
      camSetup,
      camToolpaths,
      currentSketch: currentSketch ? cloneSketch(currentSketch) : null,
      sketchUndoStack,
      sketchRedoStack,
      sketchActive,
      workspace,
      sketchPlaneId,
    };
    applyUndoSnapshot(prev);
    // Returning to EXACTLY the saved state clears the dirty dot (the
    // fingerprint comparison); without a baseline yet, any undo stays dirty.
    const saved = get().savedFingerprint;
    const clean = saved !== null && projectFingerprint() === saved;
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, current],
      selectedIds: [],
      selectedFaceIds: [],
      selectedEdgeIds: [],
      projectDirty: !clean,
    }));
    return true;
  },
  redo: () => {
    const { redoStack, directBodies, hiddenIds, featureTree, drawingSectionAxis, drawingDetails, drawingNotes, drawingViewPlacements, camSetup, camToolpaths, currentSketch, sketchUndoStack, sketchRedoStack, sketchActive, workspace, sketchPlaneId } = get();
    if (redoStack.length === 0) return false;
    const next = redoStack[redoStack.length - 1]!;
    const current: HistorySnapshot = {
      directBodies,
      hiddenIds,
      features: [...featureTree.features],
      drawingSectionAxis,
      drawingDetails,
      drawingNotes,
      drawingViewPlacements,
      camSetup,
      camToolpaths,
      currentSketch: currentSketch ? cloneSketch(currentSketch) : null,
      sketchUndoStack,
      sketchRedoStack,
      sketchActive,
      workspace,
      sketchPlaneId,
    };
    applyUndoSnapshot(next);
    const saved = get().savedFingerprint;
    const clean = saved !== null && projectFingerprint() === saved;
    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, current],
      selectedIds: [],
      selectedFaceIds: [],
      selectedEdgeIds: [],
      projectDirty: !clean,
    }));
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
      drawingSectionAxis: 'off',
      drawingDetails: [],
      drawingNotes: [],
      drawingViewPlacements: defaultDrawingViewPlacements(),
      camSetup: defaultCamSetup(),
      camToolpaths: {},
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
      projectDirty: true,
    });
  },
  arrangeScene: (bodies) => {
    // One undoable step: push BEFORE replacing, so undo restores the
    // pre-arrange scene including the feature tree (the snapshot carries
    // directBodies + features + drawing state).
    pushUndo();
    set((s) => ({
      // The arranged bodies are fresh copies from arrangeOnPlate — store them
      // as-is; the feature tree is folded away into them.
      featureTree: new FeatureTree(),
      directBodies: bodies,
      selectedIds: bodies.map((b) => b.id),
      hiddenIds: [],
      clipboard: [],
      pasteCount: 0,
      renaming: null,
      planes: [],
      axes: [],
      points: [],
      coordSystems: [],
      annotations: [],
      drawingSectionAxis: 'off',
      drawingDetails: [],
      drawingNotes: [],
      drawingViewPlacements: defaultDrawingViewPlacements(),
      camSetup: defaultCamSetup(),
      camToolpaths: {},
      currentSketch: null,
      sketchActive: false,
      projectDirty: true,
      // Unlike clearScene, undoStack/redoStack and the project name survive —
      // undo must be able to take the scene back to before the arrange.
      featureVersion: s.featureVersion + 1,
    }));
    recombine();
  },
  newProject: () => {
    get().clearScene();
    set({ projectName: 'Untitled', projectDirty: false, workspace: 'model', selectedSketchId: null, selectedSketchIds: [] });
    set({ savedFingerprint: projectFingerprint() }); // fresh baseline — clean until edited
  },
  loadProject: (features, name, directBodies = [], referenceGeometry, drawing, cam) => {
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
      drawingSectionAxis: drawing?.sectionAxis ?? 'off',
      drawingDetails: drawing?.details ?? [],
      drawingNotes: drawing?.notes ?? [],
      // Defensive: always the four standard views, junk filtered (B6+B8).
      drawingViewPlacements: sanitizeDrawingViewPlacements(drawing?.viewPlacements),
      camSetup: cam ?? defaultCamSetup(),
      undoStack: [],
      redoStack: [],
      currentSketch: null,
      sketchActive: false,
      projectName: name ?? get().projectName,
      projectDirty: false,
    });
    recombine();
    // The toolpath cache is derived, never serialized — regenerate it now that
    // the loaded bodies exist, and seed the op-id counter past any restored
    // camop_N ids so newly added operations cannot collide with them.
    seedCamOpCounter(get().camSetup.operations);
    set({ camToolpaths: recomputeCamToolpaths() });
    set({ savedFingerprint: projectFingerprint() }); // the loaded file is the baseline
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
    if (refusedTreeBody(bodyId)) return []; // tree bodies: see linearPatternBody
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

  drawingSectionAxis: 'off',
  setDrawingSectionAxis: (axis) => {
    pushUndo();
    set({ drawingSectionAxis: axis, projectDirty: true });
  },
  drawingDetails: [],
  addDrawingDetail: (d) => {
    pushUndo();
    set((s) => ({ drawingDetails: [...s.drawingDetails, d], projectDirty: true }));
  },
  removeDrawingDetail: (id) => {
    pushUndo();
    set((s) => ({ drawingDetails: s.drawingDetails.filter((d) => d.id !== id), projectDirty: true }));
  },
  drawingNotes: [],
  addDrawingNote: (n) => {
    pushUndo();
    set((s) => ({ drawingNotes: [...s.drawingNotes, n], projectDirty: true }));
  },
  updateDrawingNote: (id, text) => {
    pushUndo();
    set((s) => ({ drawingNotes: s.drawingNotes.map((n) => (n.id === id ? { ...n, text } : n)), projectDirty: true }));
  },
  removeDrawingNote: (id) => {
    pushUndo();
    set((s) => ({ drawingNotes: s.drawingNotes.filter((n) => n.id !== id), projectDirty: true }));
  },
  drawingViewPlacements: defaultDrawingViewPlacements(),
  updateDrawingViewPlacement: (id, patch) => {
    // Unknown id → refuse without the no-op undo entry (the removeDirectBody
    // hygiene rule). One call = one undo entry: the canvas commits a whole
    // drag as a single patch on pointer-up.
    if (!get().drawingViewPlacements.some((p) => p.id === id)) return;
    pushUndo();
    set((s) => ({
      drawingViewPlacements: s.drawingViewPlacements.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      projectDirty: true,
    }));
  },
  resetDrawingViewPlacements: () => {
    pushUndo();
    set({ drawingViewPlacements: defaultDrawingViewPlacements(), projectDirty: true });
  },

  // --- CAM setup ---------------------------------------------------------------
  // Edit actions (add/remove/update/setStock) each push ONE undo entry and set
  // projectDirty; regenerateCamToolpaths is a pure recompute of derived data
  // and deliberately pushes neither.
  camSetup: defaultCamSetup(),
  camToolpaths: {},
  addCamOperation: (op) => {
    pushUndo();
    const id = makeCamOpId();
    // F3 stable identity: capture the producing feature when the target is a
    // tree body, so recompute's id rotation cannot orphan the op. Direct
    // bodies resolve no feature and keep the exact-id path only (the
    // direct-body guard matters: brep and operations mint independent
    // body_N counters, so ids can collide across the two worlds).
    const featureId = get().directBodies.some((b) => b.id === op.bodyId)
      ? undefined
      : get().featureTree.findFeatureIdForBody(op.bodyId);
    const newOp: BoundCamOperation = {
      ...op,
      id,
      ...(featureId ? { bodyFeatureId: featureId } : {}),
    };
    const cache = resolveCamToolpath(newOp);
    set((s) => ({
      camSetup: { ...s.camSetup, operations: [...s.camSetup.operations, newOp] },
      ...(cache ? { camToolpaths: { ...s.camToolpaths, [id]: cache } } : {}),
      projectDirty: true,
    }));
    return id;
  },
  removeCamOperation: (id) => {
    pushUndo();
    set((s) => {
      const camToolpaths = { ...s.camToolpaths };
      delete camToolpaths[id];
      return {
        camSetup: { ...s.camSetup, operations: s.camSetup.operations.filter((o) => o.id !== id) },
        camToolpaths,
        projectDirty: true,
      };
    });
  },
  updateCamOperation: (id, patch) => {
    // Unknown id → refuse without the no-op undo entry (the removeDirectBody
    // hygiene rule).
    if (!get().camSetup.operations.some((o) => o.id === id)) return;
    pushUndo();
    set((s) => {
      let updated: BoundCamOperation | null = null;
      const operations = s.camSetup.operations.map((o) => {
        if (o.id !== id) return o;
        // "Deep-ish" patch: top-level fields replace, params merge key-by-key.
        const merged: BoundCamOperation = { ...o, ...patch, params: { ...o.params, ...(patch.params ?? {}) } };
        // F3: retargeting the op rebinds the stable identity to the NEW
        // body's producer — a stale binding would resurrect the old tree body
        // after the new target dies, contradicting the retarget. An unchanged
        // bodyId keeps the binding the op already carries.
        if (patch.bodyId !== undefined && patch.bodyId !== o.bodyId) {
          merged.bodyFeatureId = s.directBodies.some((b) => b.id === patch.bodyId)
            ? undefined
            : s.featureTree.findFeatureIdForBody(patch.bodyId);
        }
        updated = merged;
        return merged;
      });
      if (!updated) return {}; // unknown id — nothing to change
      const cache = resolveCamToolpath(updated);
      const camToolpaths = { ...s.camToolpaths };
      if (cache) camToolpaths[id] = cache;
      else delete camToolpaths[id]; // disabled or unresolvable — no stale cache
      return { camSetup: { ...s.camSetup, operations }, camToolpaths, projectDirty: true };
    });
  },
  setCamStock: (stock) => {
    pushUndo();
    set((s) => ({ camSetup: { ...s.camSetup, stock }, projectDirty: true }));
  },
  regenerateCamToolpaths: () => {
    // F3 cache repair first: repoint ops whose exact body id was rotated away
    // by an upstream parametric edit to the current body of their bound
    // feature, so the recompute below (and the G-code export feeding off the
    // cache) sees them. No undo entry, no dirty flip — regenerate is derived
    // data, and the repoint is repair, not a user edit.
    const operations = repointCamOperationBodies();
    if (operations !== get().camSetup.operations) {
      set((s) => ({ camSetup: { ...s.camSetup, operations } }));
    }
    set({ camToolpaths: recomputeCamToolpaths() });
  },
  placeBodyInCoordinateSystem: (bodyId, csId) => {
    const body = get().bodies.find((b) => b.id === bodyId);
    const cs = get().coordSystems.find((c) => c.id === csId);
    if (!body || !cs) return null;
    const placed = placeBodyInFrame(body, cs);
    // Tree bodies are refused by replaceBody (with its own toast).
    if (!get().replaceBody(bodyId, placed)) return null;
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
    // runs in the geometry worker so the viewport keeps responding. A worker
    // crash surfaces as a rejected promise — turn it into a null so callers
    // can treat it like any other failed combine.
    let result: SolidBody | null;
    try {
      result = await asyncBooleanOp(a, b, op);
    } catch {
      return null;
    }
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
    if (refusedTreeBody(bodyId)) return []; // tree bodies: see linearPatternBody
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
  numericPrompt: null,
  openNumericPrompt: (numericPrompt) => set({ numericPrompt }),
  closeNumericPrompt: () => set({ numericPrompt: null }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  showShortcuts: false,
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  wireframe: stored('scenelab.wireframe') === 'true',
  setWireframe: (wireframe) => { set({ wireframe }); persist('scenelab.wireframe', String(wireframe)); },
  sectionAnalysis: { active: false, axis: 'z', offset: 0, flip: false },
  setSectionAnalysis: (patch) => set((s) => ({ sectionAnalysis: { ...s.sectionAnalysis, ...patch } })),
  showGrid: stored('scenelab.showGrid') !== 'false',
  setShowGrid: (showGrid) => { set({ showGrid }); persist('scenelab.showGrid', String(showGrid)); },
  groundShadows: stored('scenelab.groundShadows') !== 'false',
  setGroundShadows: (groundShadows) => { set({ groundShadows }); persist('scenelab.groundShadows', String(groundShadows)); },
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
  setMeasureActive: (measureActive) => set({ measureActive, measurePts: [], measureFacePick: null }),
  measurePts: [],
  addMeasurePoint: (p) => set((s) =>
    // Area mode measures a picked face (setMeasureFacePick); stray point
    // clicks in that mode are ignored rather than feeding the point array.
    s.measureMode === 'area' ? {} : { measurePts: s.measurePts.length >= 3 ? [p] : [...s.measurePts, p] },
  ),
  removeLastMeasurePoint: () => set((s) =>
    s.measureMode === 'area' ? { measureFacePick: null } : { measurePts: s.measurePts.slice(0, -1) },
  ),
  measureMode: 'distance',
  setMeasureMode: (measureMode) => set({ measureMode, measurePts: [], measureFacePick: null }),
  measureFacePick: null,
  setMeasureFacePick: (measureFacePick) => set({ measureFacePick }),

  visionSelectActive: false,
  setVisionSelectActive: (visionSelectActive) => set({ visionSelectActive }),
  visionRegion: null,
  setVisionRegion: (visionRegion) => set({ visionRegion }),

  performExtrude: (distance, symmetric, op = 'join') => {
    const sketch = get().currentSketch;
    if (!sketch) return false;
    // The dialog clamps to ≥0.1 mm; enforce the same floor for AI/programmatic
    // callers so a degenerate distance can't enter the tree as a failing feature.
    if (!(distance > 0)) return false;
    // A cut needs a target: the body SELECTED when the dialog opened (Fusion's
    // Operation: Cut). Refuse without one — the dialog shows feature.cutTargetHint
    // and disables Extrude; programmatic callers get a silent false like the
    // other validation guards.
    let cutTarget: { body: SolidBody; featureId?: string } | undefined;
    if (op === 'cut') {
      const body = selectedBody();
      if (!body) return false;
      cutTarget = { body, featureId: get().featureTree.findFeatureIdForBody(body.id) };
    }
    // pushUndo clears the redo branch; a FAILED attempt restores it below.
    const savedRedo = get().redoStack;
    pushUndo();

    const tree = get().featureTree;

    // Direct-body target (the applyModifyFeature dual-path philosophy): the
    // tree cannot consume a body it did not produce, so extrude the cutter
    // from the sketch and subtract it as ONE undoable direct edit. The sketch
    // feature stays on the timeline so the cutter's profile survives
    // parametrically; a failure rolls everything back and keeps the session.
    if (cutTarget && !cutTarget.featureId) {
      const sketchFeat = createSketchFeature(sketch);
      tree.addFeature(sketchFeat);
      tree.recompute();
      let cut: SolidBody;
      try {
        const cutter = extrudeSketchBody(
          sketch,
          { profile: [], direction: { x: 0, y: 1, z: 0 }, distance, symmetric },
        );
        cut = cutBodyWithCutter(cutTarget.body, cutter);
      } catch (e) {
        rollbackFailedSketchFeature(
          sketchFeat.id, sketchFeat.id, // only the sketch feature was added; the 2nd remove no-ops
          e instanceof Error ? e.message : String(e), 'toast.extrudeFailed', savedRedo,
        );
        return false;
      }
    set((s) => ({
      directBodies: s.directBodies.map((b) =>
        b.id === cutTarget!.body.id ? { ...cut, color: b.color } : b,
      ),
      featureTree: tree,
      featureVersion: s.featureVersion + 1,
      // The cut replaced the target — repoint the selection at the result so
      // a following Cut doesn't enable its button against a dead id.
      selectedIds: s.selectedIds.map((sid) => (sid === cutTarget!.body.id ? cut.id : sid)),
      selectedFaceIds: [],
      selectedEdgeIds: [],
      sketchActive: false,
      currentSketch: null,
      // Ending the sketch session: the NEXT session must not inherit this
      // one's Ctrl+Z entries (setCurrentSketch clears these; raw set must too).
      sketchUndoStack: [],
      sketchRedoStack: [],
      workspace: 'model',
      showExtrudeDialog: false,
      projectDirty: true,
    }));
    recombine();
    return true;
  }

    // Create features. A tree-target cut parents the extrude on BOTH the
    // sketch and the target's feature — the evaluator consumes the target.
    const sketchFeat = createSketchFeature(sketch);
    const extrudeFeat = createExtrudeFeature(
      {
        profile: [],
        direction: { x: 0, y: 1, z: 0 },
        distance,
        symmetric,
        // Join stays op-less: byte-identical features/serialization as before.
        ...(cutTarget ? { op: 'cut' as const } : {}),
      },
      cutTarget ? [sketchFeat.id, cutTarget.featureId!] : [sketchFeat.id],
    );

    // Batch all updates into a single set() call
    tree.addFeature(sketchFeat);
    tree.addFeature(extrudeFeat);
    tree.recompute();

    // An unusable profile (open lines, empty sketch, …) surfaces as an
    // evaluator error with zero bodies — fail WITHOUT destroying the sketch
    // session: roll the features + undo entry back and explain. A cut whose
    // cutter misses the target fails the same way ('cutter does not
    // intersect the target body').
    const result = tree.getResult(extrudeFeat.id);
    if (!result || result.error || result.bodies.length === 0) {
      rollbackFailedSketchFeature(sketchFeat.id, extrudeFeat.id, result?.error ?? 'the sketch has no closed profile', 'toast.extrudeFailed', savedRedo);
      return false;
    }

    set((s) => ({
      featureTree: tree,
      // A tree-target cut's result body replaced the consumed target — repoint
      // the selection so a following cut resolves a live body (combineSelected
      // precedent). Joins have no cutTarget and leave the selection alone.
      selectedIds: cutTarget
        ? s.selectedIds.map((sid) => (sid === cutTarget.body.id ? result.bodies[0]!.id : sid))
        : s.selectedIds,
      selectedFaceIds: [],
      selectedEdgeIds: [],
      sketchActive: false,
      currentSketch: null,
      // Ending the sketch session: the NEXT session must not inherit this
      // one's Ctrl+Z entries (setCurrentSketch clears these; raw set must too).
      sketchUndoStack: [],
      sketchRedoStack: [],
      workspace: 'model',
      showExtrudeDialog: false,
      projectDirty: true,
    }));
    recombine();
    return true;
  },

  performRevolve: (angle) => {
    const sketch = get().currentSketch;
    if (!sketch) return false;
    // pushUndo clears the redo branch; a FAILED attempt restores it below.
    const savedRedo = get().redoStack;
    pushUndo();

    const sketchFeat = createSketchFeature(sketch);
    const revolveFeat = createRevolveFeature(angle, [sketchFeat.id]);

    const tree = get().featureTree;
    tree.addFeature(sketchFeat);
    tree.addFeature(revolveFeat);
    tree.recompute();

    const result = tree.getResult(revolveFeat.id);
    if (!result || result.error || result.bodies.length === 0) {
      rollbackFailedSketchFeature(sketchFeat.id, revolveFeat.id, result?.error ?? 'the sketch has no closed profile', 'toast.revolveFailed', savedRedo);
      return false;
    }

    set({
      featureTree: tree,
      sketchActive: false,
      currentSketch: null,
      // Ending the sketch session: the NEXT session must not inherit this
      // one's Ctrl+Z entries (setCurrentSketch clears these; raw set must too).
      sketchUndoStack: [],
      sketchRedoStack: [],
      workspace: 'model',
      showRevolveDialog: false,
      projectDirty: true,
    });
    recombine();
    return true;
  },

  performSweep: (distance, twistDegrees) => {
    const sketch = get().currentSketch;
    if (!sketch || !(distance > 0)) return false;
    // pushUndo clears the redo branch; a FAILED attempt restores it below.
    const savedRedo = get().redoStack;
    pushUndo();

    // Subdivide the straight path so the twist is applied gradually. One big
    // step per end can map a symmetric profile's corner set onto itself,
    // collapsing the side quads (degenerate faces, wrong signed volume).
    // The path is world-space BY DESIGN (the evaluator never transforms it):
    // it runs along the sketch plane's normal, so the sweep extrudes
    // perpendicular to the drawn plane — the 'xz' ground default keeps the
    // legacy +Y direction bit-for-bit (planeNormal('xz') = {0,1,0}).
    const twist = (twistDegrees * Math.PI) / 180;
    const steps = Math.max(2, Math.ceil(Math.abs(twist) / (Math.PI / 8)));
    const dir = sketchPlaneNormal(sketch.planeId);
    const path = Array.from({ length: steps + 1 }, (_, i) => ({
      x: dir.x * ((distance * i) / steps),
      y: dir.y * ((distance * i) / steps),
      z: dir.z * ((distance * i) / steps),
    }));

    const sketchFeat = createSketchFeature(sketch);
    const sweepFeat = createSweepFeature({ path, twist }, [sketchFeat.id]);

    const tree = get().featureTree;
    tree.addFeature(sketchFeat);
    tree.addFeature(sweepFeat);
    tree.recompute();

    const result = tree.getResult(sweepFeat.id);
    if (!result || result.error || result.bodies.length === 0) {
      rollbackFailedSketchFeature(sketchFeat.id, sweepFeat.id, result?.error ?? 'the sketch has no closed profile', 'toast.sweepFailed', savedRedo);
      return false;
    }

    set({
      featureTree: tree,
      sketchActive: false,
      currentSketch: null,
      // Ending the sketch session: the NEXT session must not inherit this
      // one's Ctrl+Z entries (setCurrentSketch clears these; raw set must too).
      sketchUndoStack: [],
      sketchRedoStack: [],
      workspace: 'model',
      projectDirty: true,
    });
    recombine();
    return true;
  },

  // Modify features: when the selected body was produced by a feature, add a
  // parametric child feature (Fusion timeline style — recompute replays it);
  // parametric child feature (Fusion timeline style — recompute replays it);
  // otherwise edit the direct body in place, undoable like other direct edits.
  // Fillet/chamfer scope to the Alt+click edge sub-selection when present
  // (empty selection = every edge, whole-body treatment) and are REFUSED with
  // the oversize toast when the value exceeds the geometric limit for those
  // edges (applyFillet would otherwise mangle the body and report success);
  // when NO selected edge is treatable the limit is null and the refusal uses
  // the filletNoEdges toast instead of a meaningless "max 0 mm".
  applyFilletFeature: (radius) => {
    const body = selectedBody();
    if (body) {
      const limit = maxFilletRadius(body, scopedEdgeIdsFor(body));
      if (limit.max === null) {
        showToast(toastText('toast.filletNoEdges'), 'warning');
        return false;
      }
      if (radius > limit.max) {
        showToast(toastText('toast.filletOversize', { max: Math.round(limit.max * 100) / 100 }), 'warning');
        return false;
      }
    }
    return applyModifyFeature(
      (parentIds) => createFilletFeature(scopedEdgeIds(), radius, parentIds),
      (body) => applyFillet(body, scopedEdgeIdsFor(body), radius),
    );
  },

  applyChamferFeature: (distance) => {
    const body = selectedBody();
    if (body) {
      const limit = maxChamferDistance(body, scopedEdgeIdsFor(body));
      if (limit.max === null) {
        // Same all-edges-skipped case as the fillet guard above.
        showToast(toastText('toast.filletNoEdges'), 'warning');
        return false;
      }
      if (distance > limit.max) {
        showToast(toastText('toast.chamferOversize', { max: Math.round(limit.max * 100) / 100 }), 'warning');
        return false;
      }
    }
    return applyModifyFeature(
      (parentIds) => createChamferFeature(scopedEdgeIds(), distance, parentIds),
      (body) => applyChamfer(body, scopedEdgeIdsFor(body), distance),
    );
  },

  applyShellFeature: (thickness) =>
    applyModifyFeature(
      (parentIds) => createShellFeature(scopedFaceIds(), thickness, parentIds),
      (body) => applyShell(body, scopedFaceIdsFor(body), thickness),
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

  // Hole drills from an explicit centre (or the body's top-face centroid)
  // along an explicit direction (the clicked face's INWARD normal) or, by
  // default, straight down (−Y) — the same default placement the AI
  // create_hole tool uses.
  applyHoleToBody: (bodyId, diameter, depth, center, direction) => {
    if (!Number.isFinite(diameter) || diameter <= 0.1) return false;
    if (depth !== null && (!Number.isFinite(depth) || depth <= 0.1)) return false;
    const s = get();
    const body = s.bodies.find((b) => b.id === bodyId);
    if (!body) return false;
    const start = center ?? topFaceHolePlacement(body).center;
    // An explicit direction is normalized once here so the tree feature's
    // params and the direct drill share the exact same axis; a zero vector
    // has no direction to drill along — refuse it.
    let dir: Vec3 = { x: 0, y: -1, z: 0 };
    if (direction) {
      const len = Math.hypot(direction.x, direction.y, direction.z);
      if (len < 1e-10) return false;
      dir = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
    }

    const tree = s.featureTree;
    const parentId = tree.findFeatureIdForBody(bodyId);
    if (parentId) {
      // pushUndo clears the redo branch; a FAILED attempt restores it below.
      const savedRedo = get().redoStack;
      pushUndo();
      const holeFeat = createHoleFeature({ center: start, direction: dir, diameter, depth }, [parentId]);
      tree.addFeature(holeFeat);
      tree.recompute();
      // A hole that does not reach the body surfaces as an evaluator error
      // with zero bodies ('hole does not reach the body') — roll the feature
      // and the undo entry back atomically (the performExtrude pattern) and
      // explain, instead of reporting success with an undrilled body.
      const result = tree.getResult(holeFeat.id);
      if (!result || result.error || result.bodies.length === 0) {
        rollbackFailedSketchFeature(
          holeFeat.id, holeFeat.id, // only the hole feature was added; the 2nd remove no-ops
          result?.error ?? 'the hole did not reach the body', 'toast.holeMissed', savedRedo,
        );
        return false;
      }
      set((st) => ({ featureTree: tree, projectDirty: true, featureVersion: st.featureVersion + 1 }));
      recombine();
      return true;
    }
    // pushUndo clears the redo branch; a FAILED attempt restores it below.
    const savedRedo = get().redoStack;
    pushUndo();
    let holed: SolidBody;
    try {
      holed = drillHoleInBody(body, { center: start, direction: dir, diameter, depth });
    } catch {
      // Missed cutter (off-surface start): nothing was drilled — drop the
      // undo entry this attempt pushed, restore the redo branch and tell the
      // user. No mutation happened, so no recompute/recombine is needed.
      set((st) => ({ undoStack: st.undoStack.slice(0, -1), redoStack: savedRedo }));
      showToast(toastText('toast.holeMissed'), 'warning');
      return false;
    }
    set((st) => ({
      directBodies: st.directBodies.map((b) => (b.id === bodyId ? holed : b)),
      projectDirty: true,
    }));
    recombine();
    return true;
  },

  setDimensionTarget: (driver, value) => {
    if (!(value > 0) || !Number.isFinite(value)) return false;
    const body = get().bodies.find((b) => b.id === driver.bodyId);
    if (!body) return false;
    const tree = get().featureTree;
    const parentId = tree.findFeatureIdForBody(driver.bodyId);
    if (parentId) {
      const parent = tree.getFeature(parentId);
      pushUndo();
      // Repeated edits of the same dimension update the driving scale feature
      // instead of stacking a new node per edit.
      if (parent?.type === 'scale' && parent.params.axis === driver.axis) {
        tree.updateFeature(parentId, (f) =>
          f.type === 'scale' ? { ...f, params: { ...f.params, target: value } } : f,
        );
      } else {
        tree.addFeature(createScaleFeature(driver.axis, value, [parentId]));
      }
      tree.recompute();
      // The tree mutates in place — bump the version so the timeline and
      // dimension-driven panels re-render.
      set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
      recombine();
      return true;
    }
    try {
      const resized = resizeBodyAxis(body, driver.axis, value);
      pushUndo();
      set((s) => ({ directBodies: s.directBodies.map((b) => (b.id === driver.bodyId ? resized : b)), projectDirty: true }));
      recombine();
      return true;
    } catch {
      return false; // zero-extent axis (body is flat along it)
    }
  },

  performLoftFromSketches: (sketchFeatureIds) => {
    const tree = get().featureTree;
    const parents = sketchFeatureIds
      .map((id) => tree.getFeature(id))
      .filter((f): f is Extract<Feature, { type: 'sketch' }> => f?.type === 'sketch');
    if (parents.length < 2) return false;
    pushUndo();
    tree.addFeature(createLoftFeature({}, parents.map((p) => p.id)));
    tree.recompute();
    // The tree mutates in place — bump the version so the timeline re-renders.
    set((s) => ({ featureTree: tree, projectDirty: true, featureVersion: s.featureVersion + 1 }));
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

  // Parts library
  showPartsLibrary: stored('scenelab.showPartsLibrary') === 'true',
  togglePartsLibrary: () => set((s) => { const v = !s.showPartsLibrary; persist('scenelab.showPartsLibrary', String(v)); return { showPartsLibrary: v }; }),
  recentPartIds: (() => { try { const v = JSON.parse(stored('scenelab.recentParts') || '[]'); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; } })(),
  insertLibraryPart: (partId) => {
    const part = findLibraryPart(partId);
    if (!part) return null;
    const placed = translateBody(part.build(), {
      // Stagger successive inserts across the plate (TinkerCAD's drop grid)
      // so parts never stack on top of each other at the origin.
      x: 18 * (get().directBodies.length % 3),
      y: 0,
      z: 18 * Math.floor((get().directBodies.length % 9) / 3),
    });
    get().addDirectBody(placed);
    get().selectObject(placed.id);
    set((s) => {
      const recent = [partId, ...s.recentPartIds.filter((x) => x !== partId)].slice(0, 6);
      persist('scenelab.recentParts', JSON.stringify(recent));
      return { recentPartIds: recent };
    });
    return placed.id;
  },

  // Onboarding
  onboardingSteps: (() => { try { const v = JSON.parse(stored('scenelab.onboarding') || '[]'); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; } })(),
  markOnboardingStep: (step) => set((s) => {
    if (s.onboardingSteps.includes(step)) return {};
    const next = [...s.onboardingSteps, step];
    persist('scenelab.onboarding', JSON.stringify(next));
    return { onboardingSteps: next };
  }),
  welcomeDismissed: stored('scenelab.welcomeDismissed') === 'true',
  dismissWelcome: () => { set({ welcomeDismissed: true }); persist('scenelab.welcomeDismissed', 'true'); },
  showWelcome: () => set({ welcomeDismissed: false, welcomeSessionHidden: false }),
  welcomeSessionHidden: false,
  hideWelcomeForSession: () => set({ welcomeSessionHidden: true }),

  projectName: 'Untitled',
  setProjectName: (projectName) => set({ projectName }),
  projectDirty: false,
  setProjectDirty: (projectDirty) => set({ projectDirty }),
  /** Fingerprint of the last explicitly saved/loaded baseline; null = none
   * yet. Undo/redo compare the restored state against it so returning to
   * exactly the saved state clears the dirty dot (Office/Fusion behaviour)
   * instead of staying dirty forever. */
  savedFingerprint: null as string | null,
  captureSavedFingerprint: (): void => {
    set({ savedFingerprint: projectFingerprint(), projectDirty: false });
  },

  autosave: () => {
    if (typeof localStorage === 'undefined') return false;
    if (!get().projectDirty) return false;
    // projectDirty stays true after an autosave by design (only an explicit
    // save/load clears it), so it alone can't gate the tick — compare the
    // memoized fingerprint against the last SUCCESSFUL write and skip the
    // serialize+zip entirely when nothing changed.
    const fingerprint = projectFingerprint();
    if (lastAutosaveFingerprint !== null && fingerprint === lastAutosaveFingerprint) return false;
    const { projectName, featureTree, directBodies, planes, axes, points, coordSystems, annotations, drawingSectionAxis, drawingDetails, drawingNotes, drawingViewPlacements, camSetup } = get();
    try {
      const project = serializeProject(
        projectName,
        featureTree.features,
        [],
        directBodies,
        { planes, axes, points, coordSystems, annotations },
        { sectionAxis: drawingSectionAxis, details: drawingDetails, notes: drawingNotes, viewPlacements: drawingViewPlacements },
        camSetup,
      );
      const json = saveToFile(project);
      localStorage.setItem(AUTOSAVE_KEY, json);
      // Desktop belt-and-braces: a native crash-recovery snapshot beside the
      // webview storage (Rust prunes to the newest 20). Fire-and-forget — the
      // localStorage copy above is already the primary restore source.
      if (isTauri()) {
        void callNative('autosave_snapshot', { data: json }).catch(() => undefined);
      }
      // Only a successful write advances the baseline — a failed one retries
      // on the next tick.
      lastAutosaveFingerprint = fingerprint;
      return true;
    } catch {
      // A quota/storage failure (typically QuotaExceededError from setItem on
      // large scenes) would otherwise silently kill crash recovery. Surface it
      // ONCE per session — the tick retries every 30 s and must not spam.
      if (!autosaveQuotaWarned) {
        autosaveQuotaWarned = true;
        showToast(toastText('toast.autosaveQuota'), 'warning');
      }
      return false;
    }
  },
  restoreAutosave: () => {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    try {
      const project = loadFromFile(raw);
      get().loadProject(deserializeFeatures(project), project.name, deserializeDirectBodies(project), deserializeReferenceGeometry(project), deserializeDrawing(project), deserializeCam(project));
      return true;
    } catch {
      return false;
    }
  },
  hasAutosave: () => typeof localStorage !== 'undefined' && localStorage.getItem(AUTOSAVE_KEY) !== null,

  // Crash-recovery probe: offer the stored autosave at boot, never auto-restore
  // it (Fusion/Office parity — the user decides). The name/timestamp come from
  // the same JSON autosave() wrote (metadata.modified), so there is no parallel
  // format knowledge here; the actual reload still goes through restoreAutosave.
  autosaveProbe: null,
  probeAutosave: () => {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw === null) {
      set({ autosaveProbe: null });
      return;
    }
    try {
      const p = JSON.parse(raw) as { name?: unknown; metadata?: { modified?: unknown } };
      const name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name : null;
      const modified = typeof p.metadata?.modified === 'string' ? Date.parse(p.metadata.modified) : NaN;
      // Age computed once here (not during render) — Date.now() in a component
      // would trip React's purity rules.
      const ageMinutes = Number.isFinite(modified)
        ? Math.max(0, Math.floor((Date.now() - modified) / 60_000))
        : null;
      set({ autosaveProbe: { name, savedAt: Number.isFinite(modified) ? modified : null, ageMinutes } });
    } catch {
      // Present but unparseable — still offer the banner so Discard can clear
      // the junk key; the age phrase is simply omitted.
      set({ autosaveProbe: { name: null, savedAt: null, ageMinutes: null } });
    }
  },
  dismissAutosaveProbe: () => set({ autosaveProbe: null }),
  discardAutosave: () => {
    // No Rust clear command exists for the native snapshots (src-tauri only
    // prunes them to the newest 20), so Discard drops the localStorage copy —
    // the primary restore source — and lets native copies age out.
    if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTOSAVE_KEY);
    set({ autosaveProbe: null });
  },
  };
});
