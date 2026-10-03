import { registerTool } from './toolRegistry';
import { useStore } from '../../store/app';
import { createSketch } from '../sketch/engine';
import { topFaceHolePlacement, createHoleFeature, drillHoleInBody } from '../features/tree';
import { featureSummary } from '../features/summary';
import type { Feature } from '../features/types';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyGridArray, applyCircularArray, applyMirror, weldVertices, translateBody, rotateBody, scaleBody, scaleBodyToTarget, resizeBody, centerBody, convexHullBody } from '../geometry/operations';
import { minDistanceBetweenBodies, bodiesInterfere, interferenceVolume, computeSceneMassProperties } from '../geometry/measure';
import { booleanOp, hollowBody, mirrorMerge } from '../geometry/boolean';
import { listFaces, angleBetweenFaces } from '../geometry/query';
import { listDimensions } from '../sketch/dimensions';
import { createBox, createBoundingBoxBody, createCylinder, createSphere, createCone, createTorus, createWedge, createPrism, createTube, createCoil, createFrustumTube, findBoundaryLoops, computeBoundingBox, computeVolume, computeCentroid, computeSurfaceArea, computeMassProperties, computePrincipalMoments, computeMomentOfInertiaAboutAxis, computePendulumPeriod } from '../geometry/brep';
import { importSTLAscii, importOBJ, importSTEP, exportSTLAscii, exportOBJ, export3MF, exportSTLBinary, export3MFPackage, downloadFile, exportDrawingSVG, projectBodies } from '../io';
import { exportSTEP } from '../io/step';
import { makeNoteId } from '../io/drawingNotes';
import type { SectionPlane } from '../io/drawing';
import { translations } from '../i18n';
import { faceAreaAndCentroid } from '../geometry/measure';
import { assertNumber, assertBoolean, assertEnum, assertString, assertStringArray, assertVec3 } from './validate';
import { LIBRARY_PARTS } from '../library/parts';
import { SAMPLE_PROJECTS } from '../library/samples';
import { loadSampleProject } from '../library/loadSample';
import { getTool as getCamTool, computeFeedsAndSpeeds } from '../cam';
import type { WorkMaterial } from '../cam';
import type { Vec3, SolidBody } from '../geometry/types';
import {
  analyzePrintability,
  analyzeStability,
  assessPrintReadiness,
  estimateMass,
  estimateMassForMaterial,
  estimatePrintJob,
  estimatePrintCost,
  estimateHollowSavings,
  estimateSupportVolume,
  recommendOrientation,
  scaleToFit,
  orientForPrint,
  arrangeOnPlate,
  sliceCrossSection,
  sliceProfile,
  seatOnBed,
  layFlat,
  MATERIAL_DENSITIES,
} from '../print';
import type { MaterialName } from '../print';

const MATERIALS = Object.keys(MATERIAL_DENSITIES) as MaterialName[];
const WORK_MATERIALS: WorkMaterial[] = [
  'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
];

/** Resolve a body by id, or fall back to the only/first body in the scene. */
function resolveBody(bodyId: unknown): SolidBody {
  const { bodies } = useStore.getState();
  if (bodyId !== undefined) {
    const body = bodies.find((b) => b.id === bodyId);
    if (!body) throw new Error(`Body "${String(bodyId)}" not found`);
    return body;
  }
  const first = bodies[0];
  if (!first) throw new Error('No body in the scene');
  return first;
}

/** Canonical file extension per export format. STEP keeps its format-name
 * extension (.step; the viewport context menu writes .stp — both are standard
 * and open in every CAD reader). */
const EXPORT_EXTS = { stl: 'stl', obj: 'obj', '3mf': '3mf', step: 'step' } as const;

/**
 * Strip every path component and control character from an AI/user-supplied
 * file name ('../evil' → 'evil', 'a/b\c.stl' → 'c.stl') — a download name must
 * never carry separators or traversal segments. Returns '' for path-only input.
 */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).filter((p) => p.length > 0 && p !== '.' && p !== '..').pop() ?? '';
  return Array.from(base)
    .filter((ch) => (ch.codePointAt(0) ?? 64) >= 32) // drop control chars
    .join('')
    .trim();
}

/** Append the canonical extension unless the name already ends with it. */
function withExtension(base: string, ext: string): string {
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/**
 * Browser download for BINARY payloads (binary STL, 3MF zip package).
 * lib/io's downloadFile takes a string and tags it application/json — routing
 * bytes through it corrupts the file. This is the exact Blob+anchor path
 * ProjectMenu and the command palette's export.stl / export.threemf use;
 * kept local because lib/io is owned by another work stream.
 */
function downloadBinaryFile(data: BlobPart, mime: string, filename: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Drawing sheet size in px — mirrors DrawingCanvas.tsx's unexported
 * SHEET_W/SHEET_H consts (not editable from here; update both if the sheet
 * size ever changes). */
const DRAWING_SHEET_W = 800;
const DRAWING_SHEET_H = 600;

/** Reason shared by every draw_* / constraint tool that no-op'd without a sketch. */
const NO_SKETCH_REASON =
  'No active sketch — call create_sketch (or create_sketch_on_plane) first';

/** Feature id whose recompute result produced this body, or null for direct bodies. */
function treeFeatureOf(bodyId: string): string | null {
  return useStore.getState().featureTree.findFeatureIdForBody(bodyId) ?? null;
}

/** Shared refusal reason: the store's replaceBody refuses feature-tree bodies (contract 1). */
const TREE_BODY_REFUSED = (id: string) =>
  `Body "${id}" is produced by the feature tree — direct edits are refused; ` +
  'edit its feature instead (list_features / update_feature)';

const r3 = (n: number) => Number(n.toFixed(3));

/** Bounding-box center of a body (where the parametric mirror/array features anchor). */
function bboxCenterOf(body: SolidBody): Vec3 {
  const bb = computeBoundingBox(body);
  return { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
}

/** The world axis a unit-ish vector is aligned with (either sign), or null. */
function axisKeyOf(v: Vec3): 'x' | 'y' | 'z' | null {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-9) return null;
  const n = { x: v.x / l, y: v.y / l, z: v.z / l };
  const eps = 1e-6;
  if (Math.abs(Math.abs(n.x) - 1) < eps) return 'x';
  if (Math.abs(Math.abs(n.y) - 1) < eps) return 'y';
  if (Math.abs(Math.abs(n.z) - 1) < eps) return 'z';
  return null;
}

/** True only for the POSITIVE world axis (arrays flip sides on the negative one). */
function isPositiveAxis(v: Vec3, axis: 'x' | 'y' | 'z'): boolean {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-9) return false;
  const key = axis === 'x' ? 'x' : axis === 'y' ? 'y' : 'z';
  const unit = { x: v.x / l, y: v.y / l, z: v.z / l };
  return unit[key] > 1 - 1e-6;
}

function samePoint(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

/**
 * Tool-level array semantics (takeover B5): the geometry array builders return
 * `count` copies INCLUDING an i=0 copy coincident with the original, and the
 * original body is kept — naively adding them leaves count+1 bodies with a
 * coincident duplicate. Normalize here (lib/geometry is owned by another
 * agent): the ORIGINAL stays as instance 0, copies coincident with it (or with
 * an earlier copy — e.g. a symmetric body spun onto itself) are dropped, and
 * the result is capped so the scene ends with AT MOST `total` DISTINCT
 * instances — matching the parametric array features (count = TOTAL).
 */
function distinctArrayCopies(original: SolidBody, copies: SolidBody[], total: number): SolidBody[] {
  const eps = 1e-6;
  const samePlace = (a: Vec3, b: Vec3) =>
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
  const seen: Vec3[] = [computeCentroid(original)];
  const out: SolidBody[] = [];
  for (const copy of copies) {
    if (out.length >= total - 1) break;
    const c = computeCentroid(copy);
    if (seen.some((s) => samePlace(s, c))) continue;
    seen.push(c);
    out.push(copy);
  }
  return out;
}

/**
 * Shared modify-routing result: after a parametric store action ran, report the
 * (possibly new) body id and the feature that was appended to the timeline.
 */
function featureApplySummary(idsBefore: Set<string>, previousBodyId: string): {
  mode: 'feature';
  featureId: string | undefined;
  bodyId: string;
} {
  const st = useStore.getState();
  const newId = st.bodies.find((b) => !idsBefore.has(b.id))?.id;
  return {
    mode: 'feature' as const,
    featureId: st.featureTree.features[st.featureTree.features.length - 1]?.id,
    // Fillet/chamfer/shell keep the parent body id; arrays regenerate ids.
    bodyId: newId ?? st.bodies.find((b) => b.id === previousBodyId)?.id ?? previousBodyId,
  };
}

export function registerBuiltinTools(): void {
  // Sketch tools
  registerTool({
    name: 'create_sketch',
    description: 'Create a new sketch on a plane (xy, xz, or yz)',
    parameters: {
      type: 'object',
      properties: {
        plane: { type: 'string', enum: ['xy', 'xz', 'yz'], description: 'The plane to sketch on' },
      },
      required: ['plane'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const plane = assertEnum(args.plane, ['xy', 'xz', 'yz'] as const, 'plane');
      store.setSketchPlaneId(plane);
      store.setSketchActive(true);
      store.setWorkspace('sketch');
      const sketch = createSketch(plane);
      store.setCurrentSketch(sketch);
      return { success: true, sketchId: sketch.id };
    },
  });

  registerTool({
    name: 'draw_line',
    description: 'Draw a line in the current sketch from (x1,y1) to (x2,y2)',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'number', description: 'Start X coordinate' },
        y1: { type: 'number', description: 'Start Y coordinate' },
        x2: { type: 'number', description: 'End X coordinate' },
        y2: { type: 'number', description: 'End Y coordinate' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    execute: async (args) => {
      const id = useStore.getState().addSketchLine(
        assertNumber(args.x1, 'x1'),
        assertNumber(args.y1, 'y1'),
        assertNumber(args.x2, 'x2'),
        assertNumber(args.y2, 'y2'),
      );
      // The store returns '' when there is no active sketch — never report
      // success for a no-op.
      if (!id) return { success: false, reason: NO_SKETCH_REASON };
      return { success: true, entityId: id };
    },
  });

  registerTool({
    name: 'draw_rectangle',
    description: 'Draw a rectangle in the current sketch from (x1,y1) to (x2,y2)',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'number', description: 'First corner X' },
        y1: { type: 'number', description: 'First corner Y' },
        x2: { type: 'number', description: 'Opposite corner X' },
        y2: { type: 'number', description: 'Opposite corner Y' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    execute: async (args) => {
      const id = useStore.getState().addSketchRect(
        assertNumber(args.x1, 'x1'),
        assertNumber(args.y1, 'y1'),
        assertNumber(args.x2, 'x2'),
        assertNumber(args.y2, 'y2'),
      );
      // '' means there was no active sketch to draw into.
      if (!id) return { success: false, reason: NO_SKETCH_REASON };
      return { success: true, entityId: id };
    },
  });

  registerTool({
    name: 'draw_circle',
    description: 'Draw a circle in the current sketch',
    parameters: {
      type: 'object',
      properties: {
        cx: { type: 'number', description: 'Center X' },
        cy: { type: 'number', description: 'Center Y' },
        radius: { type: 'number', description: 'Radius' },
      },
      required: ['cx', 'cy', 'radius'],
    },
    execute: async (args) => {
      const id = useStore.getState().addSketchCircle(
        assertNumber(args.cx, 'cx'),
        assertNumber(args.cy, 'cy'),
        assertNumber(args.radius, 'radius'),
      );
      // '' means there was no active sketch to draw into.
      if (!id) return { success: false, reason: NO_SKETCH_REASON };
      return { success: true, entityId: id };
    },
  });

  registerTool({
    name: 'draw_polygon',
    description: 'Draw a regular polygon in the current sketch: centre (cx,cy), circumradius and number of sides (>=3).',
    parameters: {
      type: 'object',
      properties: {
        cx: { type: 'number', description: 'Center X' },
        cy: { type: 'number', description: 'Center Y' },
        radius: { type: 'number', description: 'Circumradius' },
        sides: { type: 'number', description: 'Number of sides (>=3)' },
      },
      required: ['cx', 'cy', 'radius', 'sides'],
    },
    execute: async (args) => {
      if (!useStore.getState().currentSketch) throw new Error('No active sketch — create one first');
      const radius = assertNumber(args.radius, 'radius');
      // The store silently drops a non-positive radius — surface it instead.
      if (!(radius > 0)) {
        return { success: false, reason: `Radius must be a positive number of millimetres (got ${radius})` };
      }
      const sides = Math.max(3, Math.floor(assertNumber(args.sides, 'sides')));
      useStore.getState().addSketchPolygon(
        assertNumber(args.cx, 'cx'),
        assertNumber(args.cy, 'cy'),
        radius,
        sides,
      );
      return { success: true, sides };
    },
  });

  registerTool({
    name: 'draw_arc',
    description: 'Draw an arc in the current sketch: center (cx,cy), radius, and start/end angles in degrees.',
    parameters: {
      type: 'object',
      properties: {
        cx: { type: 'number', description: 'Center X' },
        cy: { type: 'number', description: 'Center Y' },
        radius: { type: 'number', description: 'Radius' },
        startAngle: { type: 'number', description: 'Start angle in degrees' },
        endAngle: { type: 'number', description: 'End angle in degrees' },
      },
      required: ['cx', 'cy', 'radius', 'startAngle', 'endAngle'],
    },
    execute: async (args) => {
      const deg = Math.PI / 180;
      const id = useStore.getState().addSketchArc(
        assertNumber(args.cx, 'cx'),
        assertNumber(args.cy, 'cy'),
        assertNumber(args.radius, 'radius'),
        assertNumber(args.startAngle, 'startAngle') * deg,
        assertNumber(args.endAngle, 'endAngle') * deg,
      );
      // '' means there was no active sketch to draw into.
      if (!id) return { success: false, reason: NO_SKETCH_REASON };
      return { success: true, entityId: id };
    },
  });

  registerTool({
    name: 'add_constraint',
    description: 'Add a sketch constraint between entities (use the entityIds returned by draw_* tools).',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['horizontal', 'vertical', 'parallel', 'perpendicular', 'coincident', 'fixed', 'equal', 'distance', 'radius', 'concentric'],
          description: 'Constraint type',
        },
        entityIds: { type: 'array', items: { type: 'string' }, description: 'Entity IDs the constraint applies to' },
        value: { type: 'number', description: 'Target value (for distance constraints)' },
      },
      required: ['type', 'entityIds'],
    },
    execute: async (args) => {
      if (!useStore.getState().currentSketch) {
        // addSketchConstraint silently no-ops without a sketch — report it.
        return { success: false, reason: NO_SKETCH_REASON };
      }
      const type = assertEnum(args.type, ['horizontal', 'vertical', 'parallel', 'perpendicular', 'coincident', 'fixed', 'equal', 'distance', 'radius', 'concentric'] as const, 'type');
      const entityIds = args.entityIds;
      if (!Array.isArray(entityIds) || !entityIds.every((e) => typeof e === 'string')) {
        throw new Error('Expected entityIds to be a string array');
      }
      useStore.getState().addSketchConstraint(
        type,
        entityIds as string[],
        args.value !== undefined ? assertNumber(args.value, 'value') : undefined,
      );
      return { success: true };
    },
  });

  registerTool({
    name: 'trim_sketch_entity',
    description:
      'TRIM a sketch entity (Fusion TRIM): the piece of the entity containing (x, y) is removed at every crossing with other lines. ' +
      'Lines keep their other pieces; circles/arcs become arcs per surviving span; an entity with no crossings is deleted entirely. ' +
      'Use entity ids from draw_* tools; (x,y) is the sketch-space point marking the piece to delete.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Entity id to trim' },
        x: { type: 'number', description: 'Sketch x of the piece to delete' },
        y: { type: 'number', description: 'Sketch y of the piece to delete' },
      },
      required: ['entityId', 'x', 'y'],
    },
    execute: async (args) => {
      const entityId = assertString(args.entityId, 'entityId');
      const x = assertNumber(args.x, 'x');
      const y = assertNumber(args.y, 'y');
      const st = useStore.getState();
      if (!st.currentSketch) throw new Error('No active sketch');
      // Go through the store action (not the pure mutator): it snapshots the
      // sketch onto the sketch-undo stack and pops it back off on failure.
      // The action resolves its target from the selection, so select first.
      useStore.setState({ selectedSketchId: entityId, selectedSketchIds: [entityId] });
      if (!useStore.getState().trimSketchAt({ x, y })) {
        throw new Error('Nothing was trimmed — the entity is not trimmable (points/rectangles) or was missing');
      }
      return { success: true };
    },
  });

  registerTool({
    name: 'extend_sketch_entity',
    description:
      'EXTEND a sketch line or arc toward (x, y) to the nearest crossing with another line (Fusion EXTEND). ' +
      'The endpoint nearest the point moves; circles are not extendable; false when no boundary lies in that direction.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Entity id to extend' },
        x: { type: 'number', description: 'Sketch x of the extension direction' },
        y: { type: 'number', description: 'Sketch y of the extension direction' },
      },
      required: ['entityId', 'x', 'y'],
    },
    execute: async (args) => {
      const entityId = assertString(args.entityId, 'entityId');
      const x = assertNumber(args.x, 'x');
      const y = assertNumber(args.y, 'y');
      const st = useStore.getState();
      if (!st.currentSketch) throw new Error('No active sketch');
      // Store action (sketch-undo covered, popped on failure); it resolves its
      // target from the selection, so select the entity first.
      useStore.setState({ selectedSketchId: entityId, selectedSketchIds: [entityId] });
      if (!useStore.getState().extendSketchTo({ x, y })) {
        throw new Error('Nothing to extend to in that direction (or the entity is not extendable)');
      }
      return { success: true };
    },
  });

  registerTool({
    name: 'offset_sketch_entity',
    description:
      'OFFSET (equidistant copy) of a sketch entity: circles/arcs scale about their centre, a line copies its whole closed loop with mitered corners. ' +
      'Positive distance = outward/larger, negative = inward; returns the new entity ids. Collapses are refused.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Entity id to offset' },
        distance: { type: 'number', description: 'Signed offset distance (negative = inward)' },
      },
      required: ['entityId', 'distance'],
    },
    execute: async (args) => {
      const entityId = assertString(args.entityId, 'entityId');
      const distance = assertNumber(args.distance, 'distance');
      const st = useStore.getState();
      if (!st.currentSketch) throw new Error('No active sketch');
      // Route through the store's PROFILE offset — the same action the sketch
      // toolbar uses — so a line offsets its whole closed loop with mitered
      // corners (a bare parallel segment would diverge from the UI). The
      // action is selection-based, pushes sketch undo, and pops it on refusal.
      useStore.setState({ selectedSketchId: entityId, selectedSketchIds: [entityId] });
      const ok = useStore.getState().offsetSelectedSketch(distance);
      if (!ok) {
        throw new Error('Offset refused — the entity is not offsetable or the copy would collapse');
      }
      const newIds = useStore.getState().selectedSketchIds;
      return { success: true, newEntityId: newIds[0] ?? null, newEntityIds: newIds };
    },
  });

  // Primitive tools (create a solid directly, no sketch needed)
  registerTool({
    name: 'create_box',
    description: 'Create a box solid (width × height × depth, mm) and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Width (X) in mm' },
        height: { type: 'number', description: 'Height (Y) in mm' },
        depth: { type: 'number', description: 'Depth (Z) in mm' },
      },
      required: ['width', 'height', 'depth'],
    },
    execute: async (args) => {
      const body = createBox(
        assertNumber(args.width, 'width'),
        assertNumber(args.height, 'height'),
        assertNumber(args.depth, 'depth'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_cylinder',
    description: 'Create a cylinder solid (radius, height in mm) along +Y and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Radius in mm' },
        height: { type: 'number', description: 'Height in mm' },
        segments: { type: 'number', description: 'Facet count (default 32)' },
      },
      required: ['radius', 'height'],
    },
    execute: async (args) => {
      const body = createCylinder(
        assertNumber(args.radius, 'radius'),
        assertNumber(args.height, 'height'),
        args.segments !== undefined ? assertNumber(args.segments, 'segments') : undefined,
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_sphere',
    description: 'Create a sphere solid (radius in mm) centered at the origin and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Radius in mm' },
        segments: { type: 'number', description: 'Facet count (default 16)' },
      },
      required: ['radius'],
    },
    execute: async (args) => {
      const body = createSphere(
        assertNumber(args.radius, 'radius'),
        args.segments !== undefined ? assertNumber(args.segments, 'segments') : undefined,
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_cone',
    description: 'Create a cone or frustum solid along +Y (top radius 0 = pointed cone) and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        radiusBottom: { type: 'number', description: 'Bottom radius in mm' },
        radiusTop: { type: 'number', description: 'Top radius in mm (0 for a pointed cone)' },
        height: { type: 'number', description: 'Height in mm' },
        segments: { type: 'number', description: 'Facet count (default 32)' },
      },
      required: ['radiusBottom', 'radiusTop', 'height'],
    },
    execute: async (args) => {
      const body = createCone(
        assertNumber(args.radiusBottom, 'radiusBottom'),
        assertNumber(args.radiusTop, 'radiusTop'),
        assertNumber(args.height, 'height'),
        args.segments !== undefined ? assertNumber(args.segments, 'segments') : undefined,
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_torus',
    description: 'Create a torus (ring) solid around +Y and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        majorRadius: { type: 'number', description: 'Ring radius (center to tube center) in mm' },
        minorRadius: { type: 'number', description: 'Tube radius in mm' },
        segments: { type: 'number', description: 'Divisions around the ring (default 32)' },
        sides: { type: 'number', description: 'Divisions around the tube (default 16)' },
      },
      required: ['majorRadius', 'minorRadius'],
    },
    execute: async (args) => {
      const body = createTorus(
        assertNumber(args.majorRadius, 'majorRadius'),
        assertNumber(args.minorRadius, 'minorRadius'),
        args.segments !== undefined ? assertNumber(args.segments, 'segments') : undefined,
        args.sides !== undefined ? assertNumber(args.sides, 'sides') : undefined,
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_wedge',
    description: 'Create a wedge (right-triangular prism ramp) solid and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Width along X (the ramp run) in mm' },
        height: { type: 'number', description: 'Height along Y (the ramp rise) in mm' },
        depth: { type: 'number', description: 'Depth along Z in mm' },
      },
      required: ['width', 'height', 'depth'],
    },
    execute: async (args) => {
      const body = createWedge(
        assertNumber(args.width, 'width'),
        assertNumber(args.height, 'height'),
        assertNumber(args.depth, 'depth'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_coil',
    description: 'Create a helical coil/spring (also the basis for threads) about +Y, and add it to the scene.',
    parameters: {
      type: 'object',
      properties: {
        coilRadius: { type: 'number', description: 'Helix radius (center to wire center) in mm' },
        wireRadius: { type: 'number', description: 'Wire (cross-section) radius in mm' },
        pitch: { type: 'number', description: 'Rise per turn in mm' },
        turns: { type: 'number', description: 'Number of turns' },
      },
      required: ['coilRadius', 'wireRadius', 'pitch', 'turns'],
    },
    execute: async (args) => {
      const body = createCoil(
        assertNumber(args.coilRadius, 'coilRadius'),
        assertNumber(args.wireRadius, 'wireRadius'),
        assertNumber(args.pitch, 'pitch'),
        assertNumber(args.turns, 'turns'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_frustum_tube',
    description: 'Create a hollow truncated cone (funnel/nozzle/vase wall) with a constant wall thickness, and add it to the scene. Base on y=0.',
    parameters: {
      type: 'object',
      properties: {
        bottomRadius: { type: 'number', description: 'Outer radius at the base (mm)' },
        topRadius: { type: 'number', description: 'Outer radius at the top (mm)' },
        wallThickness: { type: 'number', description: 'Wall thickness (mm), < smaller radius' },
        height: { type: 'number', description: 'Height along +Y (mm)' },
      },
      required: ['bottomRadius', 'topRadius', 'wallThickness', 'height'],
    },
    execute: async (args) => {
      const body = createFrustumTube(
        assertNumber(args.bottomRadius, 'bottomRadius'),
        assertNumber(args.topRadius, 'topRadius'),
        assertNumber(args.wallThickness, 'wallThickness'),
        assertNumber(args.height, 'height'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_tube',
    description: 'Create a hollow cylinder (tube/pipe — ring, bushing, spacer) and add it to the scene. Base on y=0, extruded up +Y.',
    parameters: {
      type: 'object',
      properties: {
        outerRadius: { type: 'number', description: 'Outer radius in mm' },
        innerRadius: { type: 'number', description: 'Inner (bore) radius in mm, < outerRadius' },
        height: { type: 'number', description: 'Height along +Y in mm' },
      },
      required: ['outerRadius', 'innerRadius', 'height'],
    },
    execute: async (args) => {
      const body = createTube(
        assertNumber(args.outerRadius, 'outerRadius'),
        assertNumber(args.innerRadius, 'innerRadius'),
        assertNumber(args.height, 'height'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_prism',
    description: 'Create a regular n-sided prism (e.g. hexagon for a nut/standoff) and add it to the scene. Base on y=0, extruded up +Y.',
    parameters: {
      type: 'object',
      properties: {
        sides: { type: 'number', description: 'Number of sides (>= 3, e.g. 6 for a hexagon)' },
        radius: { type: 'number', description: 'Circumradius (center to corner) in mm' },
        height: { type: 'number', description: 'Height along +Y in mm' },
      },
      required: ['sides', 'radius', 'height'],
    },
    execute: async (args) => {
      const body = createPrism(
        assertNumber(args.sides, 'sides'),
        assertNumber(args.radius, 'radius'),
        assertNumber(args.height, 'height'),
      );
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id };
    },
  });

  registerTool({
    name: 'create_stock',
    description: 'Create a stock block (bounding box + margin) around a body — useful as CAM raw material.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body to enclose (defaults to the first body)' },
        margin: { type: 'number', description: 'Margin on each side in mm (default 0)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const margin = args.margin !== undefined ? assertNumber(args.margin, 'margin') : 0;
      const stock = createBoundingBoxBody(body, margin);
      useStore.getState().addDirectBody(stock);
      return { success: true, bodyId: stock.id };
    },
  });

  // Feature tools
  registerTool({
    name: 'extrude',
    description: 'Extrude the current sketch to create a 3D solid. Call after creating a sketch with shapes.',
    parameters: {
      type: 'object',
      properties: {
        distance: { type: 'number', description: 'Extrude distance in mm' },
        symmetric: { type: 'boolean', description: 'Whether to extrude symmetrically from the sketch plane' },
      },
      required: ['distance'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      // Mirror the store's own guards (no sketch / non-positive distance are
      // its only no-op cases) so the tool never claims success for a no-op.
      if (!store.currentSketch) {
        return { success: false, reason: NO_SKETCH_REASON };
      }
      const distance = assertNumber(args.distance, 'distance');
      if (!(distance > 0)) {
        return { success: false, reason: `Extrude distance must be a positive number of millimetres (got ${distance})` };
      }
      const symmetric = args.symmetric !== undefined ? assertBoolean(args.symmetric, 'symmetric') : false;
      // performExtrude is void; the honest signal is whether a NEW body
      // appeared (recompute swallows evaluator errors into zero bodies when
      // the sketch has no usable profile — the create_hole pattern).
      const idsBefore = new Set(useStore.getState().bodies.map((b) => b.id));
      store.performExtrude(distance, symmetric);
      const appeared = useStore.getState().bodies.some((b) => !idsBefore.has(b.id));
      if (!appeared) {
        return { success: false, reason: 'Extrude produced no solid — the sketch has no closed profile' };
      }
      return { success: true };
    },
  });

  registerTool({
    name: 'revolve',
    description: 'Revolve the current sketch around the Y axis to create a solid. Call after creating a sketch profile.',
    parameters: {
      type: 'object',
      properties: {
        angleDeg: { type: 'number', description: 'Revolution angle in degrees (default 360)' },
      },
    },
    execute: async (args) => {
      const store = useStore.getState();
      // performRevolve silently no-ops without a sketch — its only guard.
      if (!store.currentSketch) {
        return { success: false, reason: NO_SKETCH_REASON };
      }
      const angleDeg = args.angleDeg !== undefined ? assertNumber(args.angleDeg, 'angleDeg') : 360;
      // performRevolve is void; the honest signal is whether a NEW body
      // appeared (open profile → evaluator error → zero bodies).
      const idsBefore = new Set(useStore.getState().bodies.map((b) => b.id));
      useStore.getState().performRevolve((angleDeg * Math.PI) / 180);
      const appeared = useStore.getState().bodies.some((b) => !idsBefore.has(b.id));
      if (!appeared) {
        return { success: false, reason: 'Revolve produced no solid — the sketch has no closed profile' };
      }
      return { success: true };
    },
  });

  registerTool({
    name: 'list_features',
    description:
      'List the parametric feature tree in timeline order: per feature its id, type, name, ' +
      'suppressed flag and a short parameter summary. Use the ids with update_feature to edit ' +
      'parameters (e.g. "make the extrude 30 mm", "fillet radius 3").',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const features = useStore.getState().featureTree.features;
      return {
        count: features.length,
        features: features.map((f) => ({
          id: f.id,
          type: f.type,
          name: f.name,
          suppressed: f.suppressed,
          summary: featureSummary(f),
        })),
      };
    },
  });

  registerTool({
    name: 'update_feature',
    description:
      "Edit a feature's parameters with a shallow merge and recompute the model — e.g. " +
      '{ "distance": 30 } on an extrude or { "radius": 3 } on a fillet. Use list_features for ' +
      'feature ids and their current parameter values.',
    parameters: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: 'Feature id from list_features' },
        params: {
          type: 'object',
          description: 'Parameter patch merged over the existing params (keys match the feature type, e.g. { "distance": 30 })',
        },
      },
      required: ['featureId', 'params'],
    },
    execute: async (args) => {
      const featureId = assertString(args.featureId, 'featureId');
      const patch = args.params;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new Error('Expected params to be an object of parameter overrides');
      }
      const st = useStore.getState();
      const existing = st.featureTree.getFeature(featureId);
      if (!existing) {
        return { success: false, reason: `Feature "${featureId}" not found — call list_features for valid ids` };
      }
      if (existing.type === 'sketch') {
        return { success: false, reason: 'Sketch features have no editable params — edit the sketch entities instead' };
      }
      // Shallow params merge: {...f.params, ...patch}. updateFeature pushes
      // undo, recomputes the tree and bumps featureVersion.
      const current = existing.params as Record<string, unknown>;
      const merged = { ...current, ...(patch as Record<string, unknown>) };
      st.updateFeature(featureId, (f) => ({ ...f, params: merged }) as Feature);
      return {
        success: true,
        featureId,
        type: existing.type,
        params: merged,
        summary: featureSummary(useStore.getState().featureTree.getFeature(featureId)!),
      };
    },
  });

  registerTool({
    name: 'undo',
    description:
      'Undo the last change (bodies, feature tree, visibility, drawing sheet, or — while a ' +
      'sketch is active — the last sketch edit). Call it right after a mistake, then continue ' +
      'with a corrected call instead of working around the bad state.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const st = useStore.getState();
      // While a sketch is open, undo means the SKETCH history — mirroring
      // the keyboard shortcut. The model-level undo would otherwise restore
      // a pre-sketch snapshot (currentSketch: null) and wipe the session.
      if (st.sketchActive && st.currentSketch) {
        if (st.sketchUndoStack.length === 0) {
          return {
            success: false,
            reason: 'Nothing to undo in the sketch — the sketch history is empty',
            canUndo: st.undoStack.length > 0,
            canRedo: st.redoStack.length > 0,
          };
        }
        const ok = st.sketchUndo();
        return {
          success: ok,
          ...(ok ? {} : { reason: 'Sketch undo was refused' }),
          scope: 'sketch',
          canUndo: useStore.getState().sketchUndoStack.length > 0,
          canRedo: useStore.getState().sketchRedoStack.length > 0,
        };
      }
      if (st.undoStack.length === 0) {
        return {
          success: false,
          reason: 'Nothing to undo — the history is empty',
          canUndo: false,
          canRedo: st.redoStack.length > 0,
        };
      }
      const ok = st.undo();
      if (!ok) return { success: false, reason: 'Undo was refused', canUndo: false };
      // HistorySnapshot carries no label — summarize the restored state instead.
      const after = useStore.getState();
      return {
        success: true,
        canUndo: after.undoStack.length > 0,
        canRedo: after.redoStack.length > 0,
        restored: { bodyCount: after.bodies.length, featureCount: after.featureTree.features.length },
      };
    },
  });

  registerTool({
    name: 'redo',
    description:
      'Re-apply the last undone change (the counterpart of undo — the sketch history while a sketch is active). No-op when the redo history is empty.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const st = useStore.getState();
      // Same routing as undo: inside a sketch, redo steps the sketch history.
      if (st.sketchActive && st.currentSketch) {
        if (st.sketchRedoStack.length === 0) {
          return {
            success: false,
            reason: 'Nothing to redo in the sketch — no sketch change was undone',
            canUndo: st.sketchUndoStack.length > 0,
            canRedo: false,
          };
        }
        const ok = st.sketchRedo();
        return {
          success: ok,
          ...(ok ? {} : { reason: 'Sketch redo was refused' }),
          scope: 'sketch',
          canUndo: useStore.getState().sketchUndoStack.length > 0,
          canRedo: useStore.getState().sketchRedoStack.length > 0,
        };
      }
      if (st.redoStack.length === 0) {
        return {
          success: false,
          reason: 'Nothing to redo — no change was undone',
          canUndo: st.undoStack.length > 0,
          canRedo: false,
        };
      }
      const ok = st.redo();
      if (!ok) return { success: false, reason: 'Redo was refused', canRedo: false };
      const after = useStore.getState();
      return {
        success: true,
        canUndo: after.undoStack.length > 0,
        canRedo: after.redoStack.length > 0,
        restored: { bodyCount: after.bodies.length, featureCount: after.featureTree.features.length },
      };
    },
  });

  registerTool({
    name: 'remove_feature',
    description:
      'Remove a feature from the parametric timeline; the model recomputes without it ' +
      '(its body and everything downstream disappears). Use list_features for ids. ' +
      'Undoable via undo.',
    parameters: {
      type: 'object',
      properties: { featureId: { type: 'string', description: 'Feature id from list_features' } },
      required: ['featureId'],
    },
    execute: async (args) => {
      const featureId = assertString(args.featureId, 'featureId');
      const st = useStore.getState();
      if (!st.featureTree.getFeature(featureId)) {
        return { success: false, reason: `Feature "${featureId}" not found — call list_features for valid ids` };
      }
      st.removeFeature(featureId);
      return {
        success: true,
        featureId,
        remainingFeatures: useStore.getState().featureTree.features.length,
        bodyCount: useStore.getState().bodies.length,
      };
    },
  });

  registerTool({
    name: 'set_feature_suppressed',
    description:
      'Suppress (hide/skip) or unsuppress a timeline feature without deleting it — the model ' +
      'recomputes as if the feature were gone; unsuppressing brings it back. ' +
      'Use list_features for ids.',
    parameters: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: 'Feature id from list_features' },
        suppressed: { type: 'boolean', description: 'true = suppress the feature, false = re-enable it' },
      },
      required: ['featureId', 'suppressed'],
    },
    execute: async (args) => {
      const featureId = assertString(args.featureId, 'featureId');
      const suppressed = assertBoolean(args.suppressed, 'suppressed');
      const st = useStore.getState();
      const existing = st.featureTree.getFeature(featureId);
      if (!existing) {
        return { success: false, reason: `Feature "${featureId}" not found — call list_features for valid ids` };
      }
      // Same pattern the timeline context menu uses (TimelineBar.tsx).
      st.updateFeature(featureId, (x) => ({ ...x, suppressed }) as Feature);
      return { success: true, featureId, suppressed, type: existing.type };
    },
  });

  registerTool({
    name: 'reorder_feature',
    description:
      'Move a feature to a new position in the timeline (0 = first). Dependency order is ' +
      'enforced: the feature must stay after its parents and before its dependents — ' +
      'illegal moves are refused without changing anything. Use list_features for ids.',
    parameters: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: 'Feature id from list_features' },
        toIndex: { type: 'number', description: 'Target timeline index (0-based)' },
      },
      required: ['featureId', 'toIndex'],
    },
    execute: async (args) => {
      const featureId = assertString(args.featureId, 'featureId');
      const toIndex = assertNumber(args.toIndex, 'toIndex');
      const st = useStore.getState();
      if (!st.featureTree.getFeature(featureId)) {
        return { success: false, reason: `Feature "${featureId}" not found — call list_features for valid ids` };
      }
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= st.featureTree.features.length) {
        return {
          success: false,
          reason: `toIndex must be an integer in [0, ${st.featureTree.features.length - 1}] (got ${toIndex})`,
        };
      }
      const moved = st.moveFeature(featureId, toIndex);
      if (!moved) {
        return {
          success: false,
          reason:
            'Illegal move — a feature must stay AFTER every feature it depends on and BEFORE ' +
            'every feature that depends on it (or the target index is where it already is)',
        };
      }
      const after = useStore.getState();
      return {
        success: true,
        featureId,
        toIndex: after.featureTree.features.findIndex((f) => f.id === featureId),
        order: after.featureTree.features.map((f) => f.type),
      };
    },
  });

  registerTool({
    name: 'list_edges',
    description:
      "List a body's edges with id, endpoints (x,y,z) and length (mm) — use the ids as " +
      'fillet/chamfer edgeIds. Capped at the first 200 edges (truncated=true plus the total ' +
      'count) so a large imported mesh cannot flood the context; narrow with edgeIds from ' +
      'the first page or use list_faces for face-level addressing.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        limit: { type: 'number', description: 'Max edges to return (default 200, hard cap 200)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const CAP = 200;
      const limit = Math.min(CAP, args.limit !== undefined ? assertNumber(args.limit, 'limit') : CAP);
      const edges = body.edges.slice(0, limit).map((e) => ({
        id: e.id,
        start: { x: r3(e.start.x), y: r3(e.start.y), z: r3(e.start.z) },
        end: { x: r3(e.end.x), y: r3(e.end.y), z: r3(e.end.z) },
        length: r3(Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z)),
      }));
      return {
        bodyId: body.id,
        edgeCount: body.edges.length,
        returned: edges.length,
        truncated: body.edges.length > edges.length,
        edges,
      };
    },
  });

  registerTool({
    name: 'fillet',
    description:
      'Round edges of a body. Tree-produced bodies get a parametric FILLET FEATURE on the ' +
      'timeline (mode:"feature" — edit it later with update_feature); direct bodies are ' +
      'edited in place (mode:"direct"). Feature-mode fillets scope to the given edgeIds, or ' +
      'ALL edges when none are passed. Use list_edges for edge ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to fillet' },
        edgeIds: { type: 'array', items: { type: 'string' }, description: 'Edge IDs to fillet (from list_edges; omit for all edges)' },
        radius: { type: 'number', description: 'Fillet radius in mm' },
      },
      required: ['bodyId', 'radius'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const radius = assertNumber(args.radius, 'radius');
      // applyFillet early-returns the body unchanged for radius ≤ 0 — without
      // this guard the no-op would still claim success and push an undo entry.
      if (!(radius > 0)) {
        return { success: false, reason: `Fillet radius must be positive (got ${radius})` };
      }
      const edgeIds = args.edgeIds !== undefined ? assertStringArray(args.edgeIds, 'edgeIds') : body.edges.map((e) => e.id);
      const unknown = edgeIds.filter((id) => !body.edges.some((e) => e.id === id));
      if (unknown.length > 0) {
        return { success: false, reason: `Unknown edge ids on this body: ${unknown.join(', ')}` };
      }
      // Tree-produced body: route to the PARAMETRIC fillet feature (the store
      // handles undo/dirty/featureVersion and scopes to the edge selection).
      if (treeFeatureOf(body.id)) {
        store.selectObject(body.id);
        useStore.getState().setSelectedEdgeIds(edgeIds);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        const ok = useStore.getState().applyFilletFeature(radius);
        if (!ok) return { success: false, reason: 'Fillet feature was rejected — check that the body is still selected' };
        return { success: true, ...featureApplySummary(idsBefore, body.id), radius, edgeCount: edgeIds.length };
      }
      const result = applyFillet(body, edgeIds, radius);
      // Contract 1: replaceBody returns false (no mutation, no undo entry) for
      // feature-tree bodies — never claim success for the refused direct edit.
      if (!store.replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, mode: 'direct' as const, bodyId: result.id, radius, edgeCount: edgeIds.length };
    },
  });

  registerTool({
    name: 'chamfer',
    description:
      'Bevel edges of a body. Tree-produced bodies get a parametric CHAMFER FEATURE on the ' +
      'timeline (mode:"feature" — edit it later with update_feature); direct bodies are ' +
      'edited in place (mode:"direct"). Feature-mode chamfers scope to the given edgeIds, or ' +
      'ALL edges when none are passed. Use list_edges for edge ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        edgeIds: { type: 'array', items: { type: 'string' }, description: 'Edge IDs to chamfer (from list_edges; omit for all edges)' },
        distance: { type: 'number', description: 'Chamfer distance in mm' },
      },
      required: ['bodyId', 'distance'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const distance = assertNumber(args.distance, 'distance');
      if (!(distance > 0)) {
        return { success: false, reason: `Chamfer distance must be positive (got ${distance})` };
      }
      const edgeIds = args.edgeIds !== undefined ? assertStringArray(args.edgeIds, 'edgeIds') : body.edges.map((e) => e.id);
      const unknown = edgeIds.filter((id) => !body.edges.some((e) => e.id === id));
      if (unknown.length > 0) {
        return { success: false, reason: `Unknown edge ids on this body: ${unknown.join(', ')}` };
      }
      if (treeFeatureOf(body.id)) {
        store.selectObject(body.id);
        useStore.getState().setSelectedEdgeIds(edgeIds);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        const ok = useStore.getState().applyChamferFeature(distance);
        if (!ok) return { success: false, reason: 'Chamfer feature was rejected — check that the body is still selected' };
        return { success: true, ...featureApplySummary(idsBefore, body.id), distance, edgeCount: edgeIds.length };
      }
      const result = applyChamfer(body, edgeIds, distance);
      if (!store.replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, mode: 'direct' as const, bodyId: result.id, distance, edgeCount: edgeIds.length };
    },
  });

  registerTool({
    name: 'shell',
    description:
      'Hollow out a body by removing open faces and offsetting the rest inward. Tree-produced ' +
      'bodies get a parametric SHELL FEATURE on the timeline (mode:"feature"); direct bodies ' +
      'are edited in place (mode:"direct"). Use list_faces for face ids; omitting faceIds ' +
      'removes the first face (feature mode scopes to the given faceIds the same way).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        faceIds: { type: 'array', items: { type: 'string' }, description: 'Face IDs to remove (open faces; from list_faces)' },
        thickness: { type: 'number', description: 'Wall thickness in mm' },
      },
      required: ['bodyId', 'thickness'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const thickness = assertNumber(args.thickness, 'thickness');
      if (!(thickness > 0)) {
        return { success: false, reason: `Wall thickness must be positive (got ${thickness})` };
      }
      const faceIds = args.faceIds !== undefined ? assertStringArray(args.faceIds, 'faceIds') : [body.faces[0]?.id ?? ''];
      const unknown = faceIds.filter((id) => !body.faces.some((f) => f.id === id));
      if (unknown.length > 0) {
        return { success: false, reason: `Unknown face ids on this body: ${unknown.join(', ')}` };
      }
      if (treeFeatureOf(body.id)) {
        store.selectObject(body.id);
        useStore.getState().setSelectedFaceIds(faceIds);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        const ok = useStore.getState().applyShellFeature(thickness);
        if (!ok) return { success: false, reason: 'Shell feature was rejected — check that the body is still selected' };
        return { success: true, ...featureApplySummary(idsBefore, body.id), thickness, openFaces: faceIds.length };
      }
      const result = applyShell(body, faceIds, thickness);
      if (!store.replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, mode: 'direct' as const, bodyId: result.id, thickness, openFaces: faceIds.length };
    },
  });

  registerTool({
    name: 'create_hole',
    description:
      'Drill a hole in a body (Fusion HOLE): subtracts a cylinder of the given diameter, drilled DOWN (−Y) ' +
      'from (x, y, z). Omit x/y/z to drill from the body\'s top-face centroid; omit depth for a through hole. ' +
      'An optional counterbore (flat-bottom widening) or countersink (conical widening) enlarges the entry. ' +
      'Replaces the body and returns the new body id plus the removed volume.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        diameter: { type: 'number', description: 'Hole diameter in mm (> 0.1)' },
        depth: { type: 'number', description: 'Hole depth in mm (omit for a through hole)' },
        x: { type: 'number', description: 'Hole centre X (mm; omit all of x/y/z for the top-face centroid)' },
        y: { type: 'number', description: 'Hole centre Y (mm)' },
        z: { type: 'number', description: 'Hole centre Z (mm)' },
        counterbore: {
          type: 'object',
          properties: {
            diameter: { type: 'number', description: 'Counterbore diameter in mm (> hole diameter)' },
            depth: { type: 'number', description: 'Counterbore depth in mm from the entry face' },
          },
          required: ['diameter', 'depth'],
          description: 'Flat-bottomed widening of the hole entry (e.g. a bolt-head recess)',
        },
        countersink: {
          type: 'object',
          properties: {
            diameter: { type: 'number', description: 'Countersink (cone top) diameter in mm' },
            angleDeg: { type: 'number', description: 'Full included cone angle in degrees (e.g. 90)' },
          },
          required: ['diameter', 'angleDeg'],
          description: 'Conical widening of the hole entry (e.g. a flat-head screw seat); mutually exclusive with counterbore',
        },
      },
      required: ['diameter'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const diameter = assertNumber(args.diameter, 'diameter');
      const depth = args.depth !== undefined && args.depth !== null ? assertNumber(args.depth, 'depth') : null;
      if (args.counterbore !== undefined && args.countersink !== undefined) {
        throw new Error('Provide either counterbore or countersink, not both');
      }
      const counterbore = args.counterbore === undefined ? undefined : (() => {
        const o = args.counterbore as Record<string, unknown>;
        const cbDiameter = assertNumber(o.diameter, 'counterbore.diameter');
        const cbDepth = assertNumber(o.depth, 'counterbore.depth');
        if (cbDiameter <= 0.1 || cbDepth <= 0.1) throw new Error('Counterbore diameter and depth must exceed 0.1 mm');
        return { diameter: cbDiameter, depth: cbDepth };
      })();
      const countersink = args.countersink === undefined ? undefined : (() => {
        const o = args.countersink as Record<string, unknown>;
        const csDiameter = assertNumber(o.diameter, 'countersink.diameter');
        const csAngle = assertNumber(o.angleDeg, 'countersink.angleDeg');
        if (csDiameter <= 0.1 || !(csAngle > 0) || csAngle >= 180) {
          throw new Error('Countersink diameter must exceed 0.1 mm and angleDeg be within (0, 180)');
        }
        return { diameter: csDiameter, angleDeg: csAngle };
      })();
      const hasXyz = args.x !== undefined || args.y !== undefined || args.z !== undefined;
      let center: Vec3;
      if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
        center = { x: assertNumber(args.x, 'x'), y: assertNumber(args.y, 'y'), z: assertNumber(args.z, 'z') };
      } else if (hasXyz) {
        throw new Error('Provide all of x, y and z — or none to drill from the top-face centroid');
      } else {
        center = topFaceHolePlacement(body).center;
      }

      const volumeBefore = Math.abs(computeVolume(body));
      const idsBefore = new Set(useStore.getState().bodies.map((b) => b.id));
      const direction: Vec3 = { x: 0, y: -1, z: 0 };
      let applied: boolean;
      if (!counterbore && !countersink) {
        // The store's plain path covers both tree and direct bodies.
        applied = useStore.getState().applyHoleToBody(body.id, diameter, depth, center);
      } else {
        // Counterbore/countersink variants: parametric feature for tree bodies,
        // undoable direct edit otherwise (the store action only takes the plain
        // cylinder params).
        const st = useStore.getState();
        const parentId = st.featureTree.findFeatureIdForBody(body.id);
        const holeParams = { center, direction, diameter, depth, counterbore, countersink };
        if (parentId) {
          st.addFeature(createHoleFeature(holeParams, [parentId]));
        } else {
          st.replaceBody(body.id, drillHoleInBody(body, holeParams));
        }
        applied = true;
      }
      if (!applied) {
        throw new Error('Hole rejected — check that the body exists and the diameter/depth are valid');
      }
      const bodiesAfter = useStore.getState().bodies;
      const holed = bodiesAfter.find((b) => !idsBefore.has(b.id)) ?? bodiesAfter.find((b) => b.id === body.id);
      const volumeAfter = holed ? Math.abs(computeVolume(holed)) : volumeBefore;
      return {
        success: true,
        bodyId: holed?.id ?? body.id,
        diameter,
        depth,
        throughAll: depth === null,
        counterbore: counterbore ?? undefined,
        countersink: countersink ?? undefined,
        volumeRemoved: Number((volumeBefore - volumeAfter).toFixed(3)),
      };
    },
  });

  registerTool({
    name: 'linear_array',
    description:
      'Linear pattern of a body: ends with EXACTLY `count` total instances (the original is ' +
      'instance 0 — it is not duplicated). Tree-produced bodies get a parametric LINEAR ARRAY ' +
      'FEATURE (mode:"feature"), which only runs along +x/+y/+z — other directions are ' +
      'refused on tree bodies; direct bodies (mode:"direct") pattern along any direction.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to array' },
        direction: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Array direction vector',
        },
        count: { type: 'number', description: 'TOTAL number of instances (including the original)' },
        spacing: { type: 'number', description: 'Spacing between instances in mm' },
      },
      required: ['bodyId', 'direction', 'count', 'spacing'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const direction = assertVec3(args.direction, 'direction');
      const count = assertNumber(args.count, 'count');
      const spacing = assertNumber(args.spacing, 'spacing');
      if (!Number.isInteger(count) || count < 1) {
        return { success: false, reason: `count must be a whole number of TOTAL instances >= 1 (got ${count})` };
      }
      if (!(spacing > 0)) {
        return { success: false, reason: `spacing must be positive (got ${spacing})` };
      }
      // Tree-produced body → parametric array feature (count = TOTAL instances,
      // matching the fix below). The store action only supports world axes.
      if (treeFeatureOf(body.id)) {
        const axis = axisKeyOf(direction);
        if (!axis || !isPositiveAxis(direction, axis)) {
          return {
            success: false,
            reason:
              `Body "${body.id}" is produced by the feature tree — its linear array feature only ` +
              'runs along +x, +y or +z. Pass one of those directions (or edit the sketch/feature)',
          };
        }
        store.selectObject(body.id);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        const ok = useStore.getState().applyLinearArrayFeature(count, spacing, axis);
        if (!ok) return { success: false, reason: 'Array feature was rejected — check that the body is still selected' };
        return { success: true, ...featureApplySummary(idsBefore, body.id), count, spacing, axis };
      }
      // Direct body: geometry returns `count` copies INCLUDING one coincident
      // with the original (i=0) — drop it and cap so the scene ends with
      // EXACTLY `count` bodies (the original + count-1 distinct copies).
      const copies = distinctArrayCopies(
        body,
        applyLinearArray(body, direction, count, spacing),
        count,
      );
      store.addDirectBodies(copies);
      return { success: true, mode: 'direct' as const, count, added: copies.length, bodyId: body.id };
    },
  });

  registerTool({
    name: 'hollow_body',
    description: 'Hollow a solid into a closed shell of the given wall thickness (true lightweighting hollow). Voxel-based watertight result; replaces the body.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        wallThickness: { type: 'number', description: 'Wall thickness in mm' },
        resolution: { type: 'number', description: 'Voxel grid resolution per axis (default 48)' },
      },
      required: ['wallThickness'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const resolution = args.resolution !== undefined ? assertNumber(args.resolution, 'resolution') : 48;
      const result = hollowBody(body, assertNumber(args.wallThickness, 'wallThickness'), resolution);
      if (!result) return { success: false, reason: 'Wall thickness consumes the whole part' };
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id, faces: result.faces.length };
    },
  });

  registerTool({
    name: 'boolean_op',
    description: 'Combine two bodies with a boolean: union, difference (A−B), or intersect. Voxel-based — watertight blocky result; raise resolution for finer detail. Adds the result as a new body.',
    parameters: {
      type: 'object',
      properties: {
        bodyIdA: { type: 'string', description: 'First body (the base for difference)' },
        bodyIdB: { type: 'string', description: 'Second body (subtracted for difference)' },
        op: { type: 'string', enum: ['union', 'difference', 'intersect'], description: 'Boolean operation' },
        resolution: { type: 'number', description: 'Voxel grid resolution per axis (default 48)' },
      },
      required: ['bodyIdA', 'bodyIdB', 'op'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const a = store.bodies.find((x) => x.id === args.bodyIdA);
      const b = store.bodies.find((x) => x.id === args.bodyIdB);
      if (!a || !b) throw new Error('Both bodyIdA and bodyIdB must exist');
      const op = assertEnum(args.op, ['union', 'difference', 'intersect'] as const, 'op');
      const resolution = args.resolution !== undefined ? assertNumber(args.resolution, 'resolution') : 48;
      const result = booleanOp(a, b, op, resolution);
      if (!result) return { success: false, reason: 'Empty result (bodies do not overlap for this op)' };
      store.addDirectBody(result);
      return { success: true, bodyId: result.id, op, faces: result.faces.length };
    },
  });

  registerTool({
    name: 'grid_array',
    description:
      '2-direction grid pattern (SolidWorks linear pattern with a second direction): ends with ' +
      'EXACTLY count1 × count2 total instances (the original is one of them — not duplicated). ' +
      'Copies are added as direct bodies.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to pattern' },
        direction1: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'First direction' },
        count1: { type: 'number', description: 'Instances along direction 1 (including the original)' },
        spacing1: { type: 'number', description: 'Spacing along direction 1 (mm)' },
        direction2: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'Second direction' },
        count2: { type: 'number', description: 'Instances along direction 2 (including the original)' },
        spacing2: { type: 'number', description: 'Spacing along direction 2 (mm)' },
      },
      required: ['bodyId', 'direction1', 'count1', 'spacing1', 'direction2', 'count2', 'spacing2'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const count1 = assertNumber(args.count1, 'count1');
      const count2 = assertNumber(args.count2, 'count2');
      const total = count1 * count2;
      if (!Number.isInteger(total) || total < 1) {
        return { success: false, reason: `count1/count2 must be whole numbers >= 1 (got ${count1} × ${count2})` };
      }
      const results = applyGridArray(
        body,
        assertVec3(args.direction1, 'direction1'),
        count1,
        assertNumber(args.spacing1, 'spacing1'),
        assertVec3(args.direction2, 'direction2'),
        count2,
        assertNumber(args.spacing2, 'spacing2'),
      );
      // Same instance-counting fix as linear_array: drop the copy coincident
      // with the original and cap at EXACTLY count1 × count2 total bodies.
      const copies = distinctArrayCopies(body, results, total);
      store.addDirectBodies(copies);
      return { success: true, mode: 'direct' as const, count: total, added: copies.length, bodyId: body.id };
    },
  });

  registerTool({
    name: 'circular_array',
    description:
      'Circular pattern of a body around an axis: ends with EXACTLY `count` total instances ' +
      '(the original is one of them). Tree-produced bodies get a parametric CIRCULAR ARRAY ' +
      'FEATURE (mode:"feature"), which only spins about +Z through the body\'s own bounding-box ' +
      'centre — other axes are refused on tree bodies; direct bodies (mode:"direct") pattern ' +
      'about any axis.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        axis: {
          type: 'object',
          properties: {
            origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            direction: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          },
          description: 'Rotation axis',
        },
        count: { type: 'number', description: 'TOTAL number of instances (including the original)' },
      },
      required: ['bodyId', 'axis', 'count'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const axisArg = (args.axis ?? {}) as { origin?: unknown; direction?: unknown };
      const axis = { origin: assertVec3(axisArg.origin, 'axis.origin'), direction: assertVec3(axisArg.direction, 'axis.direction') };
      const count = assertNumber(args.count, 'count');
      if (!Number.isInteger(count) || count < 1) {
        return { success: false, reason: `count must be a whole number of TOTAL instances >= 1 (got ${count})` };
      }
      if (treeFeatureOf(body.id)) {
        // The feature spins about world Z through the body's bbox centre — only
        // route when the request asks for exactly that (no silent re-anchoring).
        const axisAligned = axisKeyOf(axis.direction) === 'z';
        const anchored = samePoint(axis.origin, bboxCenterOf(body), 1e-3);
        if (!axisAligned || !anchored) {
          return {
            success: false,
            reason:
              `Body "${body.id}" is produced by the feature tree — its circular array feature only ` +
              'spins about +Z through the body\'s own bounding-box centre. Use that axis (or edit ' +
              'the feature/sketch)',
          };
        }
        store.selectObject(body.id);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        const ok = useStore.getState().applyCircularArrayFeature(count);
        if (!ok) return { success: false, reason: 'Array feature was rejected — check that the body is still selected' };
        return { success: true, ...featureApplySummary(idsBefore, body.id), count };
      }
      const copies = distinctArrayCopies(body, applyCircularArray(body, axis, count), count);
      store.addDirectBodies(copies);
      return { success: true, mode: 'direct' as const, count, added: copies.length, bodyId: body.id };
    },
  });

  registerTool({
    name: 'circular_array_about_axis',
    description: 'Circular-pattern a body around a stored datum axis (reference geometry driving the pattern). Use list_axes for axis ids; the original body is replaced by the pattern.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        axisId: { type: 'string', description: 'Datum axis id from list_axes' },
        count: { type: 'number', description: 'Number of instances around the axis' },
      },
      required: ['axisId', 'count'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const ids = useStore.getState().circularPatternAboutAxis(body.id, assertString(args.axisId, 'axisId'), assertNumber(args.count, 'count'));
      if (ids.length === 0) throw new Error('Pattern failed — check the axis id and count');
      return { success: true, bodyIds: ids, count: ids.length };
    },
  });

  registerTool({
    name: 'mirror',
    description:
      'Mirror a body across a plane, keeping the original. Tree-produced bodies whose plane is ' +
      'a world plane (xy/xz/yz) through the body\'s own centre get a parametric MIRROR FEATURE ' +
      '(mode:"feature"); everything else adds the reflection as a direct body (mode:"direct").',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        plane: {
          type: 'object',
          properties: {
            origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            normal: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          },
          description: 'Mirror plane',
        },
      },
      required: ['bodyId', 'plane'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const planeArg = (args.plane ?? {}) as { origin?: unknown; normal?: unknown };
      const plane = { origin: assertVec3(planeArg.origin, 'plane.origin'), normal: assertVec3(planeArg.normal, 'plane.normal') };
      // Tree-produced body → parametric mirror feature when the request matches
      // what the feature does (world plane through the body's bbox centre);
      // otherwise fall through to the direct copy, which never touches the tree.
      const normalAxis = axisKeyOf(plane.normal);
      if (treeFeatureOf(body.id) && normalAxis && samePoint(plane.origin, bboxCenterOf(body), 1e-3)) {
        store.selectObject(body.id);
        const idsBefore = new Set(store.bodies.map((b) => b.id));
        // This tool keeps the original + adds the reflection → keepOriginal.
        // The feature API names the mirror by its PLANE, the tool by the
        // plane's normal axis: normal +X ↔ the yz plane, etc.
        const featurePlane = normalAxis === 'x' ? 'yz' : normalAxis === 'y' ? 'xz' : 'xy';
        const ok = useStore.getState().applyMirrorFeature(featurePlane, true);
        if (ok) {
          return { success: true, ...featureApplySummary(idsBefore, body.id), keepOriginal: true };
        }
      }
      const result = applyMirror(body, plane);
      store.addDirectBody(result);
      return { success: true, mode: 'direct' as const, bodyId: result.id, keepOriginal: true };
    },
  });

  registerTool({
    name: 'mirror_merge',
    description: 'Mirror a body across a plane and fuse it with its reflection into one symmetric watertight solid (SolidWorks Mirror with "merge solids"). Use for symmetric parts.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        plane: {
          type: 'object',
          properties: {
            origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            normal: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          },
          description: 'Mirror plane (origin + normal)',
        },
      },
      required: ['plane'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const planeArg = (args.plane ?? {}) as { origin?: unknown; normal?: unknown };
      const plane = { origin: assertVec3(planeArg.origin, 'plane.origin'), normal: assertVec3(planeArg.normal, 'plane.normal') };
      const result = mirrorMerge(body, plane);
      if (!result) throw new Error('Mirror merge produced no result');
      useStore.getState().addDirectBody(result);
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'export_body',
    description:
      'Validate/count an export of a body as STL (ASCII), OBJ, 3MF, or STEP — returns the byte ' +
      'count and a short preview, NOT the file content (inlining it would flood the context) ' +
      'and does NOT save anything. To hand the user a real file call export_file instead. ' +
      'STEP is a CAD exchange format (AP203 faceted B-rep).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        format: { type: 'string', enum: ['stl', 'obj', '3mf', 'step'], description: 'Output format (default stl)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const format = args.format !== undefined ? assertEnum(args.format, ['stl', 'obj', '3mf', 'step'] as const, 'format') : 'stl';
      const content = format === 'obj' ? exportOBJ(body) : format === '3mf' ? export3MF([body]) : format === 'step' ? exportSTEP(body) : exportSTLAscii(body);
      return {
        success: true,
        bodyId: body.id,
        format,
        bytes: content.length,
        // Keep the context bounded: a shape preview only, never the payload.
        preview: content.slice(0, 200),
        note: 'content not inlined — call export_file to save the file',
      };
    },
  });

  registerTool({
    name: 'export_file',
    description:
      'Save the scene to a real FILE the user receives as a browser download: STL (binary, one ' +
      'file per body), OBJ (one per body), 3MF (a single package bundling every body) or STEP ' +
      '(AP203, one per body) — the same exporters the UI export buttons use. Omit bodyId to ' +
      'export ALL bodies in the scene (the default; per-body formats then download one file ' +
      'per body). The file content is never inlined in the result — only byte counts. ' +
      'Viewport PNG and drawing PNG/PDF are canvas renders that stay on the UI export buttons.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['stl', 'obj', '3mf', 'step'], description: 'Output format' },
        bodyId: { type: 'string', description: 'Export a single body by id (default: ALL bodies in the scene)' },
        filename: { type: 'string', description: 'File name for the download (default scenelab.<ext>; path separators are stripped)' },
      },
      required: ['format'],
    },
    execute: async (args) => {
      const format = assertEnum(args.format, ['stl', 'obj', '3mf', 'step'] as const, 'format');
      const st = useStore.getState();
      // Body assembly matches the palette export commands (ProjectMenu /
      // registry: framingBodies over the selection, else the whole scene). A
      // tool cannot rely on UI selection state the model cannot see, so the
      // default here is the palette's no-selection default: EVERY body.
      let bodies = st.bodies;
      if (args.bodyId !== undefined) {
        const id = assertString(args.bodyId, 'bodyId');
        const body = st.bodies.find((b) => b.id === id);
        if (!body) {
          return { success: false, reason: `Body "${id}" not found — call list_bodies for valid ids` };
        }
        bodies = [body];
      }
      if (bodies.length === 0) {
        return { success: false, reason: 'No bodies in the scene — nothing to export' };
      }
      const ext = EXPORT_EXTS[format];
      const requested = args.filename !== undefined ? sanitizeFilename(assertString(args.filename, 'filename')) : '';
      const files: { filename: string; bytes: number }[] = [];
      if (format === '3mf') {
        // One package for the whole set — exactly the palette's export.threemf.
        const pkg = export3MFPackage(bodies);
        const filename = withExtension(requested || 'scenelab', ext);
        downloadBinaryFile(pkg as BlobPart, 'model/3mf', filename);
        files.push({ filename, bytes: pkg.length });
      } else {
        for (const [i, body] of bodies.entries()) {
          // Default naming follows the palette: per-body files carry the body
          // name (disambiguated when the caller forced one name onto many
          // bodies); a single-body export gets the plain default name.
          const autoBase = sanitizeFilename(body.name) || `body-${i + 1}`;
          const base = requested
            ? bodies.length > 1 ? `${requested}-${i + 1}` : requested
            : bodies.length > 1 ? autoBase : 'scenelab';
          if (format === 'stl') {
            // Binary STL per body — the palette's export.stl path verbatim.
            const buffer = exportSTLBinary(body);
            const filename = withExtension(base, ext);
            downloadBinaryFile(buffer, 'application/octet-stream', filename);
            files.push({ filename, bytes: buffer.byteLength });
          } else {
            // Text formats go through the shared string downloader.
            const content = format === 'obj' ? exportOBJ(body) : exportSTEP(body);
            const filename = withExtension(base, ext);
            downloadFile(content, filename);
            files.push({ filename, bytes: content.length });
          }
        }
      }
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      return {
        success: true,
        format,
        bytes,
        fileCount: files.length,
        bodyCount: bodies.length,
        // One file → its name; several → the per-file list. Never the content.
        ...(files.length === 1 ? { filename: files[0]!.filename } : { files }),
      };
    },
  });

  registerTool({
    name: 'import_mesh',
    description: 'Import an ASCII STL, OBJ, or faceted STEP mesh from text and add it to the scene (format auto-detected).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The STL (ASCII), OBJ or STEP file contents' },
        format: { type: 'string', enum: ['stl', 'obj', 'step'], description: 'Override format detection' },
      },
      required: ['content'],
    },
    execute: async (args) => {
      const content = assertString(args.content, 'content');
      let format = args.format !== undefined ? assertEnum(args.format, ['stl', 'obj', 'step'] as const, 'format') : undefined;
      if (!format) {
        const head = content.trimStart().slice(0, 200).toLowerCase();
        format = head.includes('iso-10303') ? 'step' : head.startsWith('solid') && content.includes('facet') ? 'stl' : 'obj';
      }
      const body = format === 'stl' ? importSTLAscii(content) : format === 'step' ? importSTEP(content) : importOBJ(content);
      if (body.faces.length === 0) throw new Error('No faces parsed from the mesh');
      useStore.getState().addDirectBody(body);
      return { success: true, bodyId: body.id, faces: body.faces.length, vertices: body.vertices.length };
    },
  });

  registerTool({
    name: 'list_faces',
    description: 'List a body\'s faces with id, area, outward normal and centroid — use the ids to target fillet/chamfer/shell. Optionally sorted by area.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        largestFirst: { type: 'boolean', description: 'Sort by descending area' },
        limit: { type: 'number', description: 'Max faces to return (default 50)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      let faces = listFaces(body);
      if (args.largestFirst) faces = [...faces].sort((a, b) => b.area - a.area);
      const limit = args.limit !== undefined ? assertNumber(args.limit, 'limit') : 50;
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        bodyId: body.id,
        faceCount: faces.length,
        faces: faces.slice(0, limit).map((f) => ({
          id: f.id,
          area: r3(f.area),
          normal: { x: r3(f.normal.x), y: r3(f.normal.y), z: r3(f.normal.z) },
          centroid: { x: r3(f.centroid.x), y: r3(f.centroid.y), z: r3(f.centroid.z) },
        })),
      };
    },
  });

  registerTool({
    name: 'list_sketch_dimensions',
    description: 'List the measured dimensions of the active sketch — a length per line and a radius per circle/arc, with mm values. Use to read a sketch\'s current sizes.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const sketch = useStore.getState().currentSketch;
      if (!sketch) throw new Error('No active sketch');
      const dims = listDimensions(sketch);
      return {
        count: dims.length,
        dimensions: dims.map((d) => ({ kind: d.kind, value: Number(d.value.toFixed(3)), entityIds: d.entityIds, label: d.label })),
      };
    },
  });

  registerTool({
    name: 'list_sketch_entities',
    description:
      'Read back the ACTIVE sketch: entities (id, type, key parameters — line endpoints, ' +
      'circle/arc centre + radius + sweep, rectangle corners, construction flag) and its ' +
      'constraints (id, type, entities, value). Call it before editing a sketch you did not ' +
      'just draw — the ids drive trim/extend/offset and constraint updates.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const sketch = useStore.getState().currentSketch;
      if (!sketch) throw new Error('No active sketch');
      const point = (id: string): { x: number; y: number } | null => {
        const e = sketch.entities.get(id);
        return e?.type === 'point' ? { x: r3(e.x), y: r3(e.y) } : null;
      };
      const entities = Array.from(sketch.entities.values())
        .filter((e) => e.type !== 'point') // points are reported via their owners
        .slice(0, 200)
        .map((e) => {
          const base = { id: e.id, type: e.type, construction: e.construction === true };
          switch (e.type) {
            case 'line':
              return { ...base, p1: point(e.p1Id), p2: point(e.p2Id) };
            case 'circle':
              return { ...base, center: point(e.centerId), radius: r3(e.radius) };
            case 'arc': {
              const deg = 180 / Math.PI;
              return {
                ...base,
                center: point(e.centerId),
                radius: r3(e.radius),
                startAngleDeg: r3(e.startAngle * deg),
                endAngleDeg: r3(e.endAngle * deg),
              };
            }
            case 'rectangle':
              return {
                ...base,
                corners: [e.p1Id, e.p2Id, e.p3Id, e.p4Id].map(point),
              };
            default:
              return base;
          }
        });
      const constraints = Array.from(sketch.constraints.values())
        .slice(0, 200)
        .map((c) => ({
          id: c.id,
          type: c.type,
          entityIds: c.entityIds,
          ...(typeof c.value === 'number' ? { value: r3(c.value) } : {}),
          // Only distance/radius constraints are driving dimensions.
          editable: (c.type === 'distance' || c.type === 'radius') && typeof c.value === 'number',
        }));
      return {
        sketchId: sketch.id,
        planeId: sketch.planeId,
        entityCount: sketch.entities.size,
        entities,
        constraintCount: sketch.constraints.size,
        constraints,
      };
    },
  });

  registerTool({
    name: 'update_sketch_constraint',
    description:
      "Change a DRIVING dimension of the active sketch (a 'distance' or 'radius' constraint " +
      'with a value) and re-solve it so the geometry follows — e.g. resize a circle to R8 ' +
      'without redrawing. Use list_sketch_entities for constraint ids and current values.',
    parameters: {
      type: 'object',
      properties: {
        constraintId: { type: 'string', description: 'Constraint id from list_sketch_entities' },
        value: { type: 'number', description: 'New value in mm (> 0.01)' },
      },
      required: ['constraintId', 'value'],
    },
    execute: async (args) => {
      const constraintId = assertString(args.constraintId, 'constraintId');
      const value = assertNumber(args.value, 'value');
      const st = useStore.getState();
      if (!st.currentSketch) {
        return { success: false, reason: NO_SKETCH_REASON };
      }
      const c = st.currentSketch.constraints.get(constraintId);
      if (!c) {
        return { success: false, reason: `Constraint "${constraintId}" not found — call list_sketch_entities for valid ids` };
      }
      if ((c.type !== 'distance' && c.type !== 'radius') || typeof c.value !== 'number') {
        return {
          success: false,
          reason: `Constraint "${constraintId}" is a "${c.type}" — only distance/radius constraints carry an editable value`,
        };
      }
      if (!(value > 0.01)) {
        return { success: false, reason: `Value must be positive (got ${value})` };
      }
      // The store mutates the constraint in place — capture the old value first.
      const previousValue = c.value;
      const ok = st.updateSketchConstraintValue(constraintId, value);
      if (!ok) return { success: false, reason: 'The solver rejected the new value' };
      return { success: true, constraintId, type: c.type, value, previousValue };
    },
  });

  registerTool({
    name: 'list_planes',
    description: 'List the scene\'s datum/reference planes with id, name, origin and normal.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        planes: useStore.getState().planes.map((p) => ({
          id: p.id,
          name: p.name,
          origin: { x: r3(p.origin.x), y: r3(p.origin.y), z: r3(p.origin.z) },
          normal: { x: r3(p.normal.x), y: r3(p.normal.y), z: r3(p.normal.z) },
        })),
      };
    },
  });

  registerTool({
    name: 'create_standard_planes',
    description: 'Seed the three standard datum planes (Front/Top/Right) through the origin if none exist.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const added = useStore.getState().ensureStandardPlanes();
      return { added, planeCount: useStore.getState().planes.length };
    },
  });

  registerTool({
    name: 'list_axes',
    description: 'List the scene\'s datum/reference axes with id, name, origin and unit direction.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        axes: useStore.getState().axes.map((a) => ({
          id: a.id,
          name: a.name,
          origin: { x: r3(a.origin.x), y: r3(a.origin.y), z: r3(a.origin.z) },
          direction: { x: r3(a.direction.x), y: r3(a.direction.y), z: r3(a.direction.z) },
        })),
      };
    },
  });

  registerTool({
    name: 'create_axis_from_planes',
    description: 'Create a datum axis at the intersection of two datum planes (SolidWorks axis from two planes). Use list_planes for ids; the planes must not be parallel.',
    parameters: {
      type: 'object',
      properties: {
        planeIdA: { type: 'string', description: 'First datum plane id' },
        planeIdB: { type: 'string', description: 'Second datum plane id' },
      },
      required: ['planeIdA', 'planeIdB'],
    },
    execute: async (args) => {
      const id = useStore.getState().addAxisFromPlanes(assertString(args.planeIdA, 'planeIdA'), assertString(args.planeIdB, 'planeIdB'));
      if (!id) throw new Error('Planes not found or parallel — no intersection axis');
      return { success: true, axisId: id };
    },
  });

  registerTool({
    name: 'list_points',
    description: 'List the scene\'s datum/reference points with id, name and position (mm).',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        points: useStore.getState().points.map((p) => ({
          id: p.id,
          name: p.name,
          position: { x: r3(p.position.x), y: r3(p.position.y), z: r3(p.position.z) },
        })),
      };
    },
  });

  registerTool({
    name: 'create_point',
    description: 'Create a datum point at a position (mm).',
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      },
      required: ['position'],
    },
    execute: async (args) => {
      const id = useStore.getState().addPoint(assertVec3(args.position, 'position'));
      return { success: true, pointId: id };
    },
  });

  registerTool({
    name: 'list_coordinate_systems',
    description: 'List the scene\'s reference coordinate systems with id, name, origin and the X/Y/Z axis directions.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const r3 = (n: number) => Number(n.toFixed(3));
      const v = (p: { x: number; y: number; z: number }) => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z) });
      return {
        coordinateSystems: useStore.getState().coordSystems.map((c) => ({
          id: c.id, name: c.name, origin: v(c.origin), xAxis: v(c.xAxis), yAxis: v(c.yAxis), zAxis: v(c.zAxis),
        })),
      };
    },
  });

  registerTool({
    name: 'create_coordinate_system',
    description: 'Create a reference coordinate system from an origin, a primary direction (+X) and a secondary direction defining the XY plane (Gram–Schmidt makes it orthonormal). Fails if the directions are parallel.',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        primary: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'Becomes the +X axis' },
        secondary: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'Defines the XY plane' },
      },
      required: ['origin', 'primary', 'secondary'],
    },
    execute: async (args) => {
      const id = useStore.getState().addCoordinateSystem(
        assertVec3(args.origin, 'origin'),
        assertVec3(args.primary, 'primary'),
        assertVec3(args.secondary, 'secondary'),
      );
      if (!id) throw new Error('Primary and secondary directions must not be parallel');
      return { success: true, coordinateSystemId: id };
    },
  });

  registerTool({
    name: 'place_body_in_coordinate_system',
    description: 'Place a body into a reference coordinate system\'s frame — a rigid transform that treats the body\'s coordinates as local to the CSYS (SolidWorks part placement). Use list_coordinate_systems for ids; the body is replaced by the placed copy.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        coordinateSystemId: { type: 'string', description: 'Coordinate system id from list_coordinate_systems' },
      },
      required: ['coordinateSystemId'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const id = useStore.getState().placeBodyInCoordinateSystem(body.id, assertString(args.coordinateSystemId, 'coordinateSystemId'));
      if (!id) throw new Error('Body or coordinate system not found');
      return { success: true, bodyId: id };
    },
  });

  registerTool({
    name: 'create_point_at_axis_plane',
    description: 'Create a datum point where a datum axis pierces a datum plane (SolidWorks point at axis/plane intersection). Use list_axes and list_planes for ids; null if the axis is parallel to the plane.',
    parameters: {
      type: 'object',
      properties: {
        axisId: { type: 'string', description: 'Datum axis id from list_axes' },
        planeId: { type: 'string', description: 'Datum plane id from list_planes' },
      },
      required: ['axisId', 'planeId'],
    },
    execute: async (args) => {
      const id = useStore.getState().addPointAtAxisPlane(assertString(args.axisId, 'axisId'), assertString(args.planeId, 'planeId'));
      if (!id) throw new Error('Axis/plane not found or axis parallel to the plane');
      return { success: true, pointId: id };
    },
  });

  registerTool({
    name: 'create_axis_from_points',
    description: 'Create a datum axis through two points (mm).',
    parameters: {
      type: 'object',
      properties: {
        p1: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        p2: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      },
      required: ['p1', 'p2'],
    },
    execute: async (args) => {
      const id = useStore.getState().addAxisFromPoints(assertVec3(args.p1, 'p1'), assertVec3(args.p2, 'p2'));
      if (!id) throw new Error('The two points coincide — no axis');
      return { success: true, axisId: id };
    },
  });

  registerTool({
    name: 'create_plane_from_face',
    description: 'Create a datum plane coincident with a body face, optionally offset (mm) along its outward normal. Use list_faces for face ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        faceId: { type: 'string', description: 'Face id from list_faces' },
        offset: { type: 'number', description: 'Offset along the face normal in mm (default 0)' },
      },
      required: ['faceId'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const offset = args.offset !== undefined ? assertNumber(args.offset, 'offset') : 0;
      const id = useStore.getState().addPlaneFromFace(body.id, assertString(args.faceId, 'faceId'), offset);
      if (!id) throw new Error('Face id not found on this body');
      return { success: true, planeId: id };
    },
  });

  registerTool({
    name: 'split_by_plane',
    description: 'Split a body into two halves with a datum plane (SolidWorks Split). Use list_planes for plane ids and create_* tools to make one first. The original body is replaced by its two halves.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        planeId: { type: 'string', description: 'Datum plane id from list_planes' },
      },
      required: ['planeId'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const ids = useStore.getState().splitBodyByPlane(body.id, assertString(args.planeId, 'planeId'));
      if (ids.length === 0) throw new Error('Split produced no result — check the plane id and that it intersects the body');
      return { success: true, bodyIds: ids, pieces: ids.length };
    },
  });

  registerTool({
    name: 'create_midplane',
    description: 'Create a datum plane halfway between two parallel faces of a body (SolidWorks mid plane). Use list_faces for face ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        faceIdA: { type: 'string', description: 'First face id' },
        faceIdB: { type: 'string', description: 'Second (parallel) face id' },
      },
      required: ['faceIdA', 'faceIdB'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const id = useStore.getState().addMidplane(body.id, assertString(args.faceIdA, 'faceIdA'), assertString(args.faceIdB, 'faceIdB'));
      if (!id) throw new Error('Faces not found or not parallel enough for a midplane');
      return { success: true, planeId: id };
    },
  });

  registerTool({
    name: 'measure_face_angle',
    description: 'Measure the angle (degrees, 0–180) between two faces of a body — the angle between their outward normals, like SolidWorks Measure. Use list_faces to get face ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        faceIdA: { type: 'string', description: 'First face id (from list_faces)' },
        faceIdB: { type: 'string', description: 'Second face id (from list_faces)' },
      },
      required: ['faceIdA', 'faceIdB'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const angle = angleBetweenFaces(body, assertString(args.faceIdA, 'faceIdA'), assertString(args.faceIdB, 'faceIdB'));
      if (angle === null) throw new Error('Face id not found on this body');
      return { bodyId: body.id, angleDeg: Number(angle.toFixed(3)) };
    },
  });

  registerTool({
    name: 'find_holes',
    description: 'Find open boundary loops (holes) in a body — a watertight mesh has none.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const r = findBoundaryLoops(body);
      return { bodyId: body.id, holeCount: r.holeCount, boundaryEdges: r.boundaryEdgeCount };
    },
  });

  registerTool({
    name: 'arrange_on_plate',
    description: 'Lay out all scene bodies on the build plate without overlap, seated on the bed.',
    parameters: {
      type: 'object',
      properties: {
        bedX: { type: 'number', description: 'Build plate width (X) in mm' },
        bedZ: { type: 'number', description: 'Build plate depth (Z) in mm' },
        spacing: { type: 'number', description: 'Gap between parts in mm (default 5)' },
      },
      required: ['bedX', 'bedZ'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const bodies = store.bodies;
      if (bodies.length === 0) throw new Error('No bodies to arrange');
      const r = arrangeOnPlate(
        bodies,
        assertNumber(args.bedX, 'bedX'),
        assertNumber(args.bedZ, 'bedZ'),
        args.spacing !== undefined ? assertNumber(args.spacing, 'spacing') : undefined,
      );
      // Replace the scene as ONE undoable step — undo restores the
      // pre-arrange scene. (clearScene + re-adding would have wiped the whole
      // global undo history.)
      useStore.getState().arrangeScene(r.bodies);
      return { success: true, count: r.bodies.length, fits: r.fits, usedX: Number(r.usedX.toFixed(1)), usedZ: Number(r.usedZ.toFixed(1)) };
    },
  });

  registerTool({
    name: 'move_body',
    description: 'Translate a body by an offset (mm) — e.g. to arrange parts on the build plate.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        offset: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Translation offset in mm',
        },
      },
      required: ['offset'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const result = translateBody(body, assertVec3(args.offset, 'offset'));
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'rotate_body',
    description: 'Rotate a body by an angle (degrees) about an axis, around the body center.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        axis: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Rotation axis (e.g. {x:0,y:1,z:0} for Y)',
        },
        angleDeg: { type: 'number', description: 'Rotation angle in degrees' },
      },
      required: ['axis', 'angleDeg'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const bb = computeBoundingBox(body);
      const origin: Vec3 = {
        x: (bb.min.x + bb.max.x) / 2,
        y: (bb.min.y + bb.max.y) / 2,
        z: (bb.min.z + bb.max.z) / 2,
      };
      const angle = (assertNumber(args.angleDeg, 'angleDeg') * Math.PI) / 180;
      const result = rotateBody(body, { origin, direction: assertVec3(args.axis, 'axis') }, angle);
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'scale_body',
    description: 'Uniformly scale a body by a factor, about its center (e.g. 2 = twice as big, 0.5 = half).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        factor: { type: 'number', description: 'Scale factor (> 0)' },
      },
      required: ['factor'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const factor = assertNumber(args.factor, 'factor');
      const bb = computeBoundingBox(body);
      const center: Vec3 = {
        x: (bb.min.x + bb.max.x) / 2,
        y: (bb.min.y + bb.max.y) / 2,
        z: (bb.min.z + bb.max.z) / 2,
      };
      const result = scaleBody(body, factor, center);
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'resize_to_target',
    description: 'Uniformly scale a body so its size along an axis equals a target (mm), preserving aspect.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Axis to size' },
        target: { type: 'number', description: 'Desired extent along that axis in mm' },
      },
      required: ['axis', 'target'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const axis = assertEnum(args.axis, ['x', 'y', 'z'] as const, 'axis');
      const result = scaleBodyToTarget(body, axis, assertNumber(args.target, 'target'));
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'resize_to_dimensions',
    description: 'Resize a body to exact width/height/depth (X/Y/Z mm), scaling each axis independently (changes aspect ratio).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        x: { type: 'number', description: 'Target size along X (mm)' },
        y: { type: 'number', description: 'Target size along Y (mm)' },
        z: { type: 'number', description: 'Target size along Z (mm)' },
      },
      required: ['x', 'y', 'z'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const result = resizeBody(body, {
        x: assertNumber(args.x, 'x'),
        y: assertNumber(args.y, 'y'),
        z: assertNumber(args.z, 'z'),
      });
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  // Mesh / print editing tools
  registerTool({
    name: 'repair_mesh',
    description: 'Weld near-coincident vertices of a body to make it watertight-friendly.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        tolerance: { type: 'number', description: 'Weld tolerance in mm (default 0.0001)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const tol = args.tolerance !== undefined ? assertNumber(args.tolerance, 'tolerance') : undefined;
      const holesBefore = findBoundaryLoops(body).holeCount;
      const result = weldVertices(body, tol);
      const holesAfter = findBoundaryLoops(result).holeCount;
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      // Report watertightness so the caller knows whether repair actually closed
      // the gaps (welding only merges coincident vertices — it can't fill a real
      // hole).
      return {
        success: true,
        bodyId: result.id,
        vertices: result.vertices.length,
        holesBefore,
        holesAfter,
        watertight: holesAfter === 0,
      };
    },
  });

  registerTool({
    name: 'scale_to_fit',
    description: 'Uniformly scale a body to fit inside a printer build volume (shrinks oversized parts).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        buildVolume: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Printer build volume in mm',
        },
        margin: { type: 'number', description: 'Margin per side in mm (default 0)' },
      },
      required: ['buildVolume'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const build = assertVec3(args.buildVolume, 'buildVolume');
      const margin = args.margin !== undefined ? assertNumber(args.margin, 'margin') : 0;
      const result = scaleToFit(body, build, margin);
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'orient_for_print',
    description: 'Rotate a body into the build orientation that minimizes support material.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const result = orientForPrint(body);
      if (!useStore.getState().replaceBody(body.id, result.body)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.body.id, orientation: result.orientation, rotated: result.rotated };
    },
  });

  registerTool({
    name: 'lay_flat',
    description: 'Rotate a body to rest on its largest flat face (most stable, usually least support) and seat it on the bed.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const result = layFlat(body);
      if (!useStore.getState().replaceBody(body.id, result)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'seat_on_bed',
    description: 'Drop a body onto the build plate so its lowest point rests at the bed (height 0 along +Y). Footprint position is preserved.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const seated = seatOnBed(body);
      if (!useStore.getState().replaceBody(body.id, seated)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: seated.id };
    },
  });

  registerTool({
    name: 'convex_hull',
    description: 'Replace a body with its 3D convex hull — the tightest convex solid enclosing it. Useful for collision/grip proxies and simplifying concave or messy meshes.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const hull = convexHullBody(body);
      if (!useStore.getState().replaceBody(body.id, hull)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: hull.id, faces: hull.faces.length };
    },
  });

  registerTool({
    name: 'center_body',
    description: 'Move a body so its bounding-box center is at the origin — normalizes off-origin imported meshes.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const centered = centerBody(body);
      if (!useStore.getState().replaceBody(body.id, centered)) {
        return { success: false, reason: TREE_BODY_REFUSED(body.id) };
      }
      return { success: true, bodyId: centered.id };
    },
  });

  // Analysis tools (3D-print oriented)
  registerTool({
    name: 'estimate_mass',
    description: 'Estimate the printed mass of a body for a given material (defaults to PLA).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        material: { type: 'string', enum: MATERIALS, description: 'Filament/resin material' },
        density: { type: 'number', description: 'Custom density in g/cm³ (overrides material)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const est =
        args.density !== undefined
          ? estimateMass(body, assertNumber(args.density, 'density'))
          : estimateMassForMaterial(
              body,
              args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA',
            );
      return {
        bodyId: body.id,
        volumeCm3: Number(est.volumeCm3.toFixed(3)),
        massGrams: Number(est.massGrams.toFixed(3)),
        density: est.density,
      };
    },
  });

  registerTool({
    name: 'slice_cross_section',
    description:
      'Cross-section of a body at a height along the build axis (+Y): filled area (mm²) and contour/perimeter length (mm). Useful for layer preview, finding the thinnest section, or per-layer estimates.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        height: { type: 'number', description: 'Cut height in mm along +Y' },
      },
      required: ['height'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const r = sliceCrossSection(body, assertNumber(args.height, 'height'));
      return {
        bodyId: body.id,
        height: r.height,
        areaMm2: Number(r.area.toFixed(3)),
        perimeterMm: Number(r.perimeter.toFixed(3)),
        segments: r.segments,
      };
    },
  });

  registerTool({
    name: 'find_weak_section',
    description:
      'Sample the cross-section along the build axis (+Y) and report the thinnest (minimum-area) section and its height — the likely weak point or narrowest neck — alongside the largest section.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        samples: { type: 'number', description: 'Number of height samples (default 32)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const samples = args.samples !== undefined ? assertNumber(args.samples, 'samples') : 32;
      const p = sliceProfile(body, samples);
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        bodyId: body.id,
        minAreaMm2: r3(p.minArea),
        minAreaHeight: r3(p.minAreaHeight),
        maxAreaMm2: r3(p.maxArea),
        maxAreaHeight: r3(p.maxAreaHeight),
        samples: p.sections.length,
      };
    },
  });

  registerTool({
    name: 'pendulum_period',
    description: 'Small-amplitude swing period (seconds) of a body hung as a physical pendulum on a pin at `pivot` rotating about `axis`. Density-independent.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        pivot: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Pin location (mm)',
        },
        axis: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Rotation axis through the pivot',
        },
        gravity: { type: 'number', description: 'Gravity in mm/s² (default 9810)' },
      },
      required: ['pivot', 'axis'],
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const period = computePendulumPeriod(
        body,
        assertVec3(args.pivot, 'pivot'),
        assertVec3(args.axis, 'axis'),
        args.gravity !== undefined ? assertNumber(args.gravity, 'gravity') : undefined,
      );
      return {
        bodyId: body.id,
        periodSeconds: Number.isFinite(period) ? Number(period.toFixed(4)) : null,
        note: Number.isFinite(period) ? undefined : 'CoM lies on the axis — no restoring torque',
      };
    },
  });

  registerTool({
    name: 'compute_mass_properties',
    description:
      'Compute rigid-body mass properties: volume, mass, center of mass, and the inertia tensor about the center of mass (for simulation). Density defaults to PLA; pass a material or a custom density in g/cm³.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        material: { type: 'string', enum: MATERIALS, description: 'Material whose density to use' },
        density: { type: 'number', description: 'Custom density in g/cm³ (overrides material)' },
        axis: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Optional axis to also report the scalar moment of inertia about',
        },
        axisPoint: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Optional point the axis passes through (a hinge/pivot); applies the parallel-axis theorem. Defaults to the CoM.',
        },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      // Geometry is in mm; convert g/cm³ → g/mm³ so mass comes out in grams.
      const densityGramsPerCm3 =
        args.density !== undefined
          ? assertNumber(args.density, 'density')
          : MATERIAL_DENSITIES[args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA'];
      const densityGramsPerMm3 = densityGramsPerCm3 / 1000;
      const mp = computeMassProperties(body, densityGramsPerMm3);
      const pm = computePrincipalMoments(body, densityGramsPerMm3);
      const r3 = (n: number) => Number(n.toFixed(3));
      const i = mp.inertia;
      const axisMoment =
        args.axis !== undefined
          ? r3(
              computeMomentOfInertiaAboutAxis(
                body,
                assertVec3(args.axis, 'axis'),
                densityGramsPerMm3,
                args.axisPoint !== undefined ? assertVec3(args.axisPoint, 'axisPoint') : undefined,
              ),
            )
          : undefined;
      return {
        bodyId: body.id,
        volumeMm3: r3(mp.volume),
        massGrams: r3(mp.mass),
        densityGramsPerCm3,
        centerOfMass: { x: r3(mp.centerOfMass.x), y: r3(mp.centerOfMass.y), z: r3(mp.centerOfMass.z) },
        // Inertia tensor (g·mm²) about the center of mass.
        inertia: { ixx: r3(i.ixx), iyy: r3(i.iyy), izz: r3(i.izz), ixy: r3(i.ixy), iyz: r3(i.iyz), ixz: r3(i.ixz) },
        // Principal moments (descending, g·mm²) and radii of gyration (mm).
        principalMoments: pm.moments.map(r3),
        radiiOfGyration: pm.radiiOfGyration.map(r3),
        ...(axisMoment !== undefined ? { momentAboutAxis: axisMoment } : {}),
      };
    },
  });

  registerTool({
    name: 'analyze_stability',
    description: 'Check whether a body is statically stable on its base (will it tip over?).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const r = analyzeStability(body);
      return {
        bodyId: body.id,
        stable: r.stable,
        comInsideBase: r.comInsideBase,
        footprintArea: Number(r.footprintArea.toFixed(2)),
        tipOverMarginMm: Number(r.marginMm.toFixed(2)),
        tippingAngleDeg: Number(r.tippingAngleDeg.toFixed(1)),
        centerOfMass: r.centerOfMass,
      };
    },
  });

  registerTool({
    name: 'analyze_printability',
    description:
      'Full 3D-print check for a body: overhangs needing support, estimated mass, build-volume fit, and tip-over stability.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        material: { type: 'string', enum: MATERIALS, description: 'Material (defaults to PLA)' },
        thresholdDeg: { type: 'number', description: 'Overhang support-angle threshold (default 45)' },
        buildVolume: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Printer build volume in mm (optional)',
        },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const material = args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA';
      const report = analyzePrintability(body, {
        material,
        thresholdDeg: args.thresholdDeg !== undefined ? assertNumber(args.thresholdDeg, 'thresholdDeg') : undefined,
        buildVolume: args.buildVolume !== undefined ? assertVec3(args.buildVolume, 'buildVolume') : undefined,
      });
      const stability = analyzeStability(body);
      const support = report.overhangs.faces.filter((f) => f.needsSupport);
      const supportVol = estimateSupportVolume(body, {
        thresholdDeg: args.thresholdDeg !== undefined ? assertNumber(args.thresholdDeg, 'thresholdDeg') : undefined,
      });
      const orient = recommendOrientation(body, {
        thresholdDeg: args.thresholdDeg !== undefined ? assertNumber(args.thresholdDeg, 'thresholdDeg') : undefined,
      });
      return {
        bodyId: body.id,
        overhangs: {
          thresholdDeg: report.overhangs.thresholdDeg,
          facesNeedingSupport: support.length,
          overhangArea: Number(report.overhangs.overhangArea.toFixed(2)),
          worstAngleDeg: Number(report.overhangs.worstAngleDeg.toFixed(1)),
          supportVolumeCm3: Number((supportVol.supportVolumeMm3 / 1000).toFixed(2)),
        },
        mass: { material, grams: Number(report.mass.massGrams.toFixed(3)) },
        buildVolume: report.buildVolume
          ? { fits: report.buildVolume.fits, overage: report.buildVolume.overage }
          : null,
        stability: { stable: stability.stable, tipOverMarginMm: Number(stability.marginMm.toFixed(2)) },
        recommendedOrientation: {
          orientation: orient.best.label,
          supportArea: Number(orient.best.supportArea.toFixed(2)),
        },
      };
    },
  });

  registerTool({
    name: 'estimate_print_job',
    description:
      'Estimate FDM print material and time for a body: filament length, mass, and rough print time given infill and wall thickness.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        material: { type: 'string', enum: MATERIALS, description: 'Material (defaults to PLA)' },
        infill: { type: 'number', description: 'Infill fraction 0–1 (default 0.2)' },
        wallThickness: { type: 'number', description: 'Wall thickness in mm (default 1.2)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const est = estimatePrintJob(body, {
        material: args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA',
        infill: args.infill !== undefined ? assertNumber(args.infill, 'infill') : undefined,
        wallThickness: args.wallThickness !== undefined ? assertNumber(args.wallThickness, 'wallThickness') : undefined,
      });
      return {
        bodyId: body.id,
        filamentLengthM: Number(est.filamentLengthM.toFixed(2)),
        filamentMassG: Number(est.filamentMassG.toFixed(2)),
        printTimeMinutes: Number(est.printTimeMinutes.toFixed(1)),
        materialVolumeCm3: Number((est.materialVolumeMm3 / 1000).toFixed(2)),
        layerCount: est.layerCount,
        infill: est.infill,
      };
    },
  });

  registerTool({
    name: 'scene_mass_properties',
    description: 'Combined mass properties of the whole scene (assembly): total volume, total mass, and the assembly center of mass. Density defaults to PLA.',
    parameters: {
      type: 'object',
      properties: {
        material: { type: 'string', enum: MATERIALS, description: 'Material whose density to use' },
        density: { type: 'number', description: 'Custom density in g/cm³ (overrides material)' },
      },
    },
    execute: async (args) => {
      const bodies = useStore.getState().bodies;
      const densityGramsPerCm3 =
        args.density !== undefined
          ? assertNumber(args.density, 'density')
          : MATERIAL_DENSITIES[args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA'];
      const s = computeSceneMassProperties(bodies, densityGramsPerCm3 / 1000);
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        bodyCount: s.bodyCount,
        totalVolumeMm3: r3(s.totalVolume),
        totalMassGrams: r3(s.totalMass),
        centerOfMass: { x: r3(s.centerOfMass.x), y: r3(s.centerOfMass.y), z: r3(s.centerOfMass.z) },
      };
    },
  });

  registerTool({
    name: 'estimate_scene_print_job',
    description:
      'Sum the FDM print material and time across every body in the scene — a batch-job total (filament length, mass, time) to print all parts.',
    parameters: {
      type: 'object',
      properties: {
        material: { type: 'string', enum: MATERIALS, description: 'Material (defaults to PLA)' },
        infill: { type: 'number', description: 'Infill fraction 0–1 (default 0.2)' },
        wallThickness: { type: 'number', description: 'Wall thickness in mm (default 1.2)' },
      },
    },
    execute: async (args) => {
      const bodies = useStore.getState().bodies;
      const opts = {
        material: args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA',
        infill: args.infill !== undefined ? assertNumber(args.infill, 'infill') : undefined,
        wallThickness: args.wallThickness !== undefined ? assertNumber(args.wallThickness, 'wallThickness') : undefined,
      };
      let filamentLengthM = 0;
      let filamentMassG = 0;
      let printTimeMinutes = 0;
      let materialVolumeMm3 = 0;
      for (const b of bodies) {
        const est = estimatePrintJob(b, opts);
        filamentLengthM += est.filamentLengthM;
        filamentMassG += est.filamentMassG;
        printTimeMinutes += est.printTimeMinutes;
        materialVolumeMm3 += est.materialVolumeMm3;
      }
      return {
        bodyCount: bodies.length,
        filamentLengthM: Number(filamentLengthM.toFixed(2)),
        filamentMassG: Number(filamentMassG.toFixed(2)),
        printTimeMinutes: Number(printTimeMinutes.toFixed(1)),
        materialVolumeCm3: Number((materialVolumeMm3 / 1000).toFixed(2)),
      };
    },
  });

  registerTool({
    name: 'estimate_hollow_savings',
    description: 'Estimate material saved by hollowing (shelling) a body to a wall thickness.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        wallThickness: { type: 'number', description: 'Wall thickness in mm (default 1.2)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const r = estimateHollowSavings(
        body,
        args.wallThickness !== undefined ? assertNumber(args.wallThickness, 'wallThickness') : undefined,
      );
      return {
        bodyId: body.id,
        solidCm3: Number((r.solidVolumeMm3 / 1000).toFixed(2)),
        shellCm3: Number((r.shellVolumeMm3 / 1000).toFixed(2)),
        savedCm3: Number((r.savedVolumeMm3 / 1000).toFixed(2)),
        savedPercent: Number(r.savedPercent.toFixed(1)),
      };
    },
  });

  registerTool({
    name: 'estimate_print_cost',
    description: 'Estimate the cost of a print: material (mass × price/kg) plus optional machine time.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        material: { type: 'string', enum: MATERIALS, description: 'Material (defaults to PLA)' },
        infill: { type: 'number', description: 'Infill fraction 0–1 (default 0.2)' },
        pricePerKg: { type: 'number', description: 'Filament price per kg (default 25)' },
        hourlyRate: { type: 'number', description: 'Machine/labour rate per hour (default 0)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const est = estimatePrintCost(body, {
        material: args.material !== undefined ? assertEnum(args.material, MATERIALS, 'material') : 'PLA',
        infill: args.infill !== undefined ? assertNumber(args.infill, 'infill') : undefined,
        pricePerKg: args.pricePerKg !== undefined ? assertNumber(args.pricePerKg, 'pricePerKg') : undefined,
        hourlyRate: args.hourlyRate !== undefined ? assertNumber(args.hourlyRate, 'hourlyRate') : undefined,
      });
      return {
        bodyId: body.id,
        massG: est.filamentMassG,
        materialCost: est.materialCost,
        machineCost: est.machineCost,
        totalCost: est.totalCost,
      };
    },
  });

  registerTool({
    name: 'recommend_orientation',
    description: 'Recommend a build orientation that minimizes support material for a body.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        thresholdDeg: { type: 'number', description: 'Overhang support-angle threshold (default 45)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const report = recommendOrientation(body, {
        thresholdDeg: args.thresholdDeg !== undefined ? assertNumber(args.thresholdDeg, 'thresholdDeg') : undefined,
      });
      return {
        bodyId: body.id,
        best: {
          orientation: report.best.label,
          supportArea: Number(report.best.supportArea.toFixed(2)),
          supportVolume: Number(report.best.supportVolume.toFixed(2)),
          supportFaces: report.best.supportFaces,
          buildHeight: Number(report.best.buildHeight.toFixed(2)),
          bedContactArea: Number(report.best.bedContactArea.toFixed(2)),
        },
        ranked: report.candidates.map((c) => ({
          orientation: c.label,
          supportArea: Number(c.supportArea.toFixed(2)),
          supportVolume: Number(c.supportVolume.toFixed(2)),
        })),
      };
    },
  });

  registerTool({
    name: 'check_print_readiness',
    description:
      'Assess whether a body is ready to 3D print: watertight, fits the build volume, plus support/stability/warp warnings.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        thresholdDeg: { type: 'number', description: 'Overhang support-angle threshold (default 45)' },
        buildVolume: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Printer build volume in mm (optional)',
        },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const report = assessPrintReadiness(body, {
        thresholdDeg: args.thresholdDeg !== undefined ? assertNumber(args.thresholdDeg, 'thresholdDeg') : undefined,
        buildVolume: args.buildVolume !== undefined ? assertVec3(args.buildVolume, 'buildVolume') : undefined,
      });
      return {
        bodyId: body.id,
        ready: report.ready,
        issues: report.issues,
      };
    },
  });

  // Scene management
  registerTool({
    name: 'delete_body',
    description: 'Remove a body from the scene by id (applies to directly-created bodies).',
    parameters: {
      type: 'object',
      properties: { bodyId: { type: 'string', description: 'Body ID to remove' } },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const id = assertString(args.bodyId, 'bodyId');
      const before = useStore.getState().bodies.length;
      useStore.getState().removeDirectBody(id);
      const after = useStore.getState().bodies.length;
      // Nothing was removed — either the id doesn't exist or it belongs to a
      // feature-tree body (only directly-created bodies are removable here).
      // Report the miss honestly instead of "success" with removed: 0.
      if (after === before) {
        const exists = useStore.getState().bodies.some((b) => b.id === id);
        return {
          success: false,
          reason: exists
            ? `Body "${id}" is produced by the feature tree — remove its feature instead`
            : `Body "${id}" not found`,
        };
      }
      return { success: true, removed: before - after };
    },
  });

  registerTool({
    name: 'clear_scene',
    description: 'Remove all bodies and features, resetting the scene to empty.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      useStore.getState().clearScene();
      return { success: true };
    },
  });

  registerTool({
    name: 'get_dimensions',
    description: 'Get a body\'s overall size: X/Y/Z bounding-box extents and the diagonal (mm).',
    parameters: {
      type: 'object',
      properties: { bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' } },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const bb = computeBoundingBox(body);
      const x = bb.max.x - bb.min.x;
      const y = bb.max.y - bb.min.y;
      const z = bb.max.z - bb.min.z;
      return {
        bodyId: body.id,
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        z: Number(z.toFixed(3)),
        diagonal: Number(Math.hypot(x, y, z).toFixed(3)),
      };
    },
  });

  registerTool({
    name: 'measure_distance',
    description: 'Measure between two bodies: centroid distance, bounding-box gap, exact minimum surface clearance, and whether they interfere (overlap).',
    parameters: {
      type: 'object',
      properties: {
        bodyIdA: { type: 'string', description: 'First body ID' },
        bodyIdB: { type: 'string', description: 'Second body ID' },
      },
      required: ['bodyIdA', 'bodyIdB'],
    },    execute: async (args) => {
      const a = resolveBody(assertString(args.bodyIdA, 'bodyIdA'));
      const b = resolveBody(assertString(args.bodyIdB, 'bodyIdB'));
      const ca = computeCentroid(a);
      const cb = computeCentroid(b);
      const centroidDistance = Math.hypot(cb.x - ca.x, cb.y - ca.y, cb.z - ca.z);
      const bbA = computeBoundingBox(a);
      const bbB = computeBoundingBox(b);
      const axisGap = (minA: number, maxA: number, minB: number, maxB: number) =>
        Math.max(0, minA - maxB, minB - maxA);
      const gx = axisGap(bbA.min.x, bbA.max.x, bbB.min.x, bbB.max.x);
      const gy = axisGap(bbA.min.y, bbA.max.y, bbB.min.y, bbB.max.y);
      const gz = axisGap(bbA.min.z, bbA.max.z, bbB.min.z, bbB.max.z);
      const interfere = bodiesInterfere(a, b);
      return {
        centroidDistance: Number(centroidDistance.toFixed(3)),
        boundingBoxGap: Number(Math.hypot(gx, gy, gz).toFixed(3)),
        surfaceClearance: Number(minDistanceBetweenBodies(a, b).toFixed(3)),
        interfere,
        // Overlap volume (mm³) when they interfere — SolidWorks-style.
        interferenceVolumeMm3: interfere ? Number(interferenceVolume(a, b).toFixed(1)) : 0,
      };
    },
  });

  registerTool({
    name: 'measure_face_area',
    description:
      'Area (mm²) and centroid of ONE face of a body (use list_faces for face ids). ' +
      'Omit faceId to get every face area; a triangle-fan over the face vertex loop (Newell-verified).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
        faceId: { type: 'string', description: 'Face id from list_faces (optional — all faces when omitted)' },
      },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const body = resolveBody(assertString(args.bodyId, 'bodyId'));
      if (args.faceId !== undefined) {
        const r = faceAreaAndCentroid(body, assertString(args.faceId, 'faceId'));
        if (!r) throw new Error(`Face ${String(args.faceId)} not found on body ${body.id}`);
        return {
          faceId: args.faceId,
          areaMm2: Number(r.area.toFixed(3)),
          centroid: { x: Number(r.centroid.x.toFixed(3)), y: Number(r.centroid.y.toFixed(3)), z: Number(r.centroid.z.toFixed(3)) },
        };
      }
      const faces = listFaces(body).map((f) => ({
        faceId: f.id,
        areaMm2: Number(f.area.toFixed(3)),
      }));
      return { totalAreaMm2: Number(faces.reduce((s, f) => s + f.areaMm2, 0).toFixed(3)), faces };
    },
  });

  registerTool({
    name: 'describe_scene',
    description: 'Summarize the whole scene: body count, names, total volume, and combined bounding box.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const { bodies } = useStore.getState();
      if (bodies.length === 0) return { bodyCount: 0 };
      let totalVolumeMm3 = 0;
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const b of bodies) {
        totalVolumeMm3 += Math.abs(computeVolume(b));
        const bb = computeBoundingBox(b);
        min.x = Math.min(min.x, bb.min.x); min.y = Math.min(min.y, bb.min.y); min.z = Math.min(min.z, bb.min.z);
        max.x = Math.max(max.x, bb.max.x); max.y = Math.max(max.y, bb.max.y); max.z = Math.max(max.z, bb.max.z);
      }
      return {
        bodyCount: bodies.length,
        names: bodies.map((b) => b.name),
        totalVolumeCm3: Number((totalVolumeMm3 / 1000).toFixed(3)),
        boundingBox: { min, max },
      };
    },
  });

  // Query tools
  registerTool({
    name: 'list_bodies',
    description: 'List all bodies in the scene with their IDs and names',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const store = useStore.getState();
      return store.bodies.map((b) => ({ id: b.id, name: b.name, vertices: b.vertices.length, faces: b.faces.length }));
    },
  });

  registerTool({
    name: 'get_body_info',
    description: 'Get detailed information about a specific body',
    parameters: {
      type: 'object',
      properties: { bodyId: { type: 'string', description: 'ID of the body' } },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const bb = computeBoundingBox(body);
      return {
        id: body.id,
        name: body.name,
        vertices: body.vertices.length,
        faces: body.faces.length,
        edges: body.edges.length,
        volumeCm3: Number((Math.abs(computeVolume(body)) / 1000).toFixed(3)),
        surfaceAreaMm2: Number(computeSurfaceArea(body).toFixed(2)),
        dimensions: {
          x: Number((bb.max.x - bb.min.x).toFixed(3)),
          y: Number((bb.max.y - bb.min.y).toFixed(3)),
          z: Number((bb.max.z - bb.min.z).toFixed(3)),
        },
      };
    },
  });

  registerTool({
    name: 'set_view',
    description: 'Change the viewport camera angle',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['top', 'front', 'right', 'iso'], description: 'View direction' },
      },
      required: ['direction'],
    },
    execute: async (args) => {
      const direction = assertEnum(args.direction, ['top', 'front', 'right', 'iso'] as const, 'direction');
      useStore.getState().setViewDirection(direction);
      return { success: true, direction };
    },
  });

  registerTool({
    name: 'select_face_at_viewport',
    description:
      'Select the CAD face under a point of the viewport image you were shown. ' +
      'x/y are normalized 0..1 of THAT image, origin top-left, y down (the image ' +
      "center is 0.5,0.5). Use it when the user refers to a visible face ('shell " +
      "this wall'): pick the face, then pass the returned faceId to shell/fillet " +
      'as faceIds. If a crop region was captured, coordinates are mapped to the ' +
      'full viewport automatically. Call it BEFORE any modifying tool (face ids ' +
      'regenerate after edits) and after any set_view. On a miss, adjust the ' +
      'point and retry at most once. additive=true keeps previously picked faces ' +
      '(multi-face shell), default replaces.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Normalized x (0..1) in the image you were shown' },
        y: { type: 'number', description: 'Normalized y (0..1, 0 = top) in the image you were shown' },
        additive: { type: 'boolean', description: 'Add to the current face selection instead of replacing it' },
      },
      required: ['x', 'y'],
    },
    execute: async (args) => {
      const x = assertNumber(args.x, 'x');
      const y = assertNumber(args.y, 'y');
      const additive = args.additive === true;
      // A cropped vision capture shows only part of the viewport — map the
      // image-space point back into full-viewport space before picking.
      const region = useStore.getState().visionRegion;
      const full = region && region.w > 0.01 && region.h > 0.01
        ? { x: region.x + x * region.w, y: region.y + y * region.h }
        : { x, y };
      const hit = await new Promise<{ faceId: string; bodyId: string } | null>((resolve) => {
        // dispatchEvent is synchronous; the timeout covers a missing listener
        // (viewport not mounted) instead of hanging the tool loop.
        const timer = setTimeout(() => resolve(null), 2000);
        window.dispatchEvent(new CustomEvent('scenelab:pick-face', {
          detail: {
            xNorm: full.x,
            yNorm: full.y,
            additive,
            resolve: (v: { faceId: string; bodyId: string } | null) => {
              clearTimeout(timer);
              resolve(v);
            },
          },
        }));
      });
      if (!hit) {
        throw new Error(
          'No face found at those viewport coordinates — adjust x/y toward the face center and retry once',
        );
      }
      return { success: true, faceId: hit.faceId, bodyId: hit.bodyId };
    },
  });

  registerTool({
    name: 'select_face',
    description:
      'Directly select a known face id on a body (ids from list_faces). ' +
      'Selects the body first, then the face — exactly what face-scoped tools need.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body that owns the face' },
        faceId: { type: 'string', description: 'Face id from list_faces' },
      },
      required: ['bodyId', 'faceId'],
    },
    execute: async (args) => {
      const bodyId = assertString(args.bodyId, 'bodyId');
      const faceId = assertString(args.faceId, 'faceId');
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === bodyId);
      if (!body) throw new Error(`Body ${bodyId} not found`);
      if (!body.faces.some((f) => f.id === faceId)) throw new Error(`Face ${faceId} not found on body ${bodyId}`);
      if (!store.selectedIds.includes(bodyId)) store.selectObject(bodyId);
      const current = useStore.getState().selectedFaceIds;
      useStore.getState().setSelectedFaceIds(
        current.includes(faceId) ? current : [...current, faceId],
      );
      return { success: true, faceId, bodyId };
    },
  });

  registerTool({
    name: 'clear_face_selection',
    description: 'Clear the picked-face selection (after finishing face-scoped operations)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      useStore.getState().setSelectedFaceIds([]);
      return { success: true };
    },
  });

  registerTool({
    name: 'select_body',
    description: 'Select bodies by id in the viewport (the user sees the highlight). Use describe_scene/list tools for ids.',
    parameters: {
      type: 'object',
      properties: {
        bodyIds: { type: 'array', items: { type: 'string' }, description: 'Body ids to select' },
      },
      required: ['bodyIds'],
    },
    execute: async (args) => {
      if (!Array.isArray(args.bodyIds)) throw new Error('bodyIds must be an array');
      const ids = args.bodyIds.map((id) => assertString(id, 'bodyIds[]'));
      const store = useStore.getState();
      const valid = ids.filter((id) => store.bodies.some((b) => b.id === id));
      if (valid.length !== ids.length) {
        const missing = ids.filter((id) => !valid.includes(id));
        throw new Error(`Body ids not found: ${missing.join(', ')}`);
      }
      store.setSelectedIds(valid);
      return { success: true, selectedIds: valid };
    },
  });

  registerTool({
    name: 'set_projection',
    description: 'Switch between perspective and orthographic camera projection',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['perspective', 'orthographic'], description: 'Projection mode' },
      },
      required: ['mode'],
    },
    execute: async (args) => {
      const mode = assertEnum(args.mode, ['perspective', 'orthographic'] as const, 'mode');
      useStore.getState().setProjection(mode);
      return { success: true, mode };
    },
  });

  registerTool({
    name: 'set_workspace',
    description:
      "Switch the active workspace: 'model' (3D scene), 'sketch' (2D sketch editing — what " +
      "draw_* tools need), 'drawing' (drawing sheet), 'cam' (machining). Sketch tools draw " +
      "into the current sketch regardless, but switching shows the user the right view.",
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['model', 'sketch', 'drawing', 'cam'], description: 'Workspace to activate' },
      },
      required: ['mode'],
    },
    execute: async (args) => {
      const mode = assertEnum(args.mode, ['model', 'sketch', 'drawing', 'cam'] as const, 'mode');
      useStore.getState().setWorkspace(mode);
      return { success: true, workspace: useStore.getState().workspace };
    },
  });

  registerTool({
    name: 'set_body_hidden',
    description:
      'Hide or show a body in the viewport (it stays in the scene and the tree — undoable). ' +
      'Use it to get a body out of the way instead of deleting it.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
        hidden: { type: 'boolean', description: 'true = hide, false = show' },
      },
      required: ['bodyId', 'hidden'],
    },
    execute: async (args) => {
      const bodyId = assertString(args.bodyId, 'bodyId');
      const hidden = assertBoolean(args.hidden, 'hidden');
      const st = useStore.getState();
      if (!st.bodies.some((b) => b.id === bodyId)) {
        return { success: false, reason: `Body "${bodyId}" not found` };
      }
      const isHidden = st.hiddenIds.includes(bodyId);
      if (isHidden === hidden) {
        // Already in the desired state — no toggle, no junk undo entry.
        return { success: true, bodyId, hidden, changed: false };
      }
      // The store only exposes a toggle (toggleBodyVisibility) — call it exactly once.
      useStore.getState().toggleBodyVisibility(bodyId);
      return { success: true, bodyId, hidden, changed: true };
    },
  });

  registerTool({
    name: 'rename_body',
    description:
      'Rename a body (direct bodies only — feature-tree bodies take their name from their ' +
      'feature). Use meaningful names before list_bodies/measure calls in multi-body scenes.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
        name: { type: 'string', description: 'New name (non-empty)' },
      },
      required: ['bodyId', 'name'],
    },
    execute: async (args) => {
      const bodyId = assertString(args.bodyId, 'bodyId');
      const name = assertString(args.name, 'name').trim();
      const st = useStore.getState();
      const body = st.bodies.find((b) => b.id === bodyId);
      if (!body) return { success: false, reason: `Body "${bodyId}" not found` };
      if (!name) return { success: false, reason: 'Name must not be empty' };
      if (body.name === name) return { success: true, bodyId, name, changed: false };
      // renameBody only touches DIRECT bodies (false for tree-produced ones).
      const ok = st.renameBody(bodyId, name);
      if (!ok) {
        return {
          success: false,
          reason: `Body "${bodyId}" is produced by the feature tree — rename its feature instead (or convert it)`,
        };
      }
      return { success: true, bodyId, name, changed: true };
    },
  });

  // CAM tools
  registerTool({
    name: 'suggest_feeds_speeds',
    description: 'Recommend spindle RPM and feed rate for a CAM tool cutting a given workpiece material.',
    parameters: {
      type: 'object',
      properties: {
        toolId: { type: 'string', description: 'Tool id from the library (e.g. em-6mm, bm-3mm)' },
        material: { type: 'string', enum: WORK_MATERIALS, description: 'Workpiece material' },
      },
      required: ['toolId', 'material'],
    },
    execute: async (args) => {
      const toolId = assertString(args.toolId, 'toolId');
      const tool = getCamTool(toolId);
      if (!tool) throw new Error(`Tool "${toolId}" not found in the library`);
      const fs = computeFeedsAndSpeeds(tool, assertEnum(args.material, WORK_MATERIALS, 'material'));
      return {
        tool: tool.name,
        material: args.material,
        spindleRpm: fs.spindleRpm,
        feedRate: fs.feedRate,
        plungeRate: fs.plungeRate,
        surfaceSpeed: fs.surfaceSpeed,
        chipLoad: fs.chipLoad,
      };
    },
  });

  registerTool({
    name: 'add_drawing_note',
    description:
      'Add a text note to the drawing sheet (title-block-style remark, finish callout, assembly instruction). ' +
      'x/y are optional sheet coordinates in the 800×600 drawing space (origin top-left); omitted positions ' +
      'stack the notes down the left margin so consecutive calls never overlap.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note text (single line)' },
        x: { type: 'number', description: 'Optional sheet x (0..800)' },
        y: { type: 'number', description: 'Optional sheet y (0..600+)' },
      },
      required: ['text'],
    },
    execute: async (args) => {
      const text = assertString(args.text, 'text').trim();
      if (!text) throw new Error('Note text must not be empty');
      const st = useStore.getState();
      const n = st.drawingNotes.length;
      const x = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : 40;
      const y = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : 540 + (n % 8) * 18;
      const note = { id: makeNoteId(), x, y, text };
      st.addDrawingNote(note);
      return { success: true, noteId: note.id, x: note.x, y: note.y };
    },
  });

  registerTool({
    name: 'export_drawing',
    description:
      'Save the DRAWING SHEET of the current scene as an SVG file download — the four standard ' +
      'views (Front, Top, Right, Iso — the same projections as the Drawing workspace) with ' +
      'auto-dimensions, the active section view, detail views and text notes. add_drawing_note ' +
      'adds notes first; the section comes from the drawing workspace control. SVG only: sheet ' +
      'PNG/PDF and viewport PNG are canvas renders available from the UI export buttons.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['svg'], description: 'Output format (SVG only)' },
        filename: { type: 'string', description: 'File name (default drawing.svg; path separators are stripped)' },
      },
    },
    execute: async (args) => {
      const format = args.format !== undefined ? assertEnum(args.format, ['svg'] as const, 'format') : 'svg';
      const st = useStore.getState();
      if (st.bodies.length === 0) {
        return { success: false, reason: 'No bodies in the scene — the drawing sheet would be empty' };
      }
      // Views assembly replicated from DrawingCanvas.tsx (the `views` memo and
      // handleExportSVG): section cut at the mid-plane of the combined bounds
      // along the active axis, then the four standard views at the canvas's
      // projection scale of 50.
      const sectionAxis = st.drawingSectionAxis;
      const section: SectionPlane | undefined = (() => {
        if (sectionAxis === 'off') return undefined;
        let min = Infinity;
        let max = -Infinity;
        for (const b of st.bodies) {
          for (const v of b.vertices) {
            const c = sectionAxis === 'x' ? v.x : sectionAxis === 'y' ? v.y : v.z;
            min = Math.min(min, c);
            max = Math.max(max, c);
          }
        }
        const normal =
          sectionAxis === 'x' ? { x: 1, y: 0, z: 0 } : sectionAxis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        return { normal, offset: (min + max) / 2 };
      })();
      // Same localized view-title suffix the canvas shows (store-side lookup —
      // the toastText pattern; no React hook context inside a tool).
      const sectionLabel = translations[st.locale]?.['drawing.section'] ?? translations['en']!['drawing.section'];
      const suffix = sectionAxis === 'off' ? '' : ` — ${sectionLabel} ${sectionAxis.toUpperCase()}`;
      const views = [
        projectBodies(st.bodies, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, `Front${suffix}`, section), // Front
        projectBodies(st.bodies, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, `Top${suffix}`, section), // Top
        projectBodies(st.bodies, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, `Right${suffix}`, section), // Right
        projectBodies(st.bodies, { x: 0.577, y: 0.577, z: 0.577 }, { x: 0, y: 1, z: 0 }, 50, `Iso${suffix}`, section), // Iso
      ];
      // handleExportSVG verbatim: 800×600 sheet + the stored details and notes.
      const svg = exportDrawingSVG(views, DRAWING_SHEET_W, DRAWING_SHEET_H, {
        details: st.drawingDetails,
        notes: st.drawingNotes,
      });
      const requested = args.filename !== undefined ? sanitizeFilename(assertString(args.filename, 'filename')) : '';
      const filename = withExtension(requested || 'drawing', 'svg');
      downloadFile(svg, filename);
      // TextEncoder bytes (svg.length counts UTF-16 code units — CJK notes
      // would understate the real size).
      return { success: true, format, filename, bytes: new TextEncoder().encode(svg).length, viewCount: views.length };
    },
  });

  // ── Compound / convenience tools ─────────────────────────────────────

  registerTool({
    name: 'sketch_rectangle_and_extrude',
    description: 'Create a rectangular sketch on the ground plane and extrude it in one step. Returns the body ID.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Rectangle width (mm) along X' },
        depth: { type: 'number', description: 'Rectangle depth (mm) along Z' },
        height: { type: 'number', description: 'Extrude height (mm) along Y' },
        name: { type: 'string', description: 'Optional body name' },
      },
      required: ['width', 'depth', 'height'],
    },
    execute: async (args) => {
      const w = assertNumber(args.width, 'width');
      const d = assertNumber(args.depth, 'depth');
      const h = assertNumber(args.height, 'height');
      const store = useStore.getState();
      const body = createBox(w, h, d);
      if (typeof args.name === 'string') body.name = args.name;
      store.addDirectBodies([body]);
      return { success: true, bodyId: body.id, name: body.name };
    },
  });

  registerTool({
    name: 'analyze_symmetry',
    description: 'Check if a body is symmetric about the X, Y, and/or Z axes (within tolerance).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
        tolerance: { type: 'number', description: 'Tolerance in mm (default 0.1)' },
      },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === assertString(args.bodyId, 'bodyId'));
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const tol = typeof args.tolerance === 'number' ? args.tolerance : 0.1;
      const checkSymmetry = (axis: 'x' | 'y' | 'z'): boolean => {
        for (const v of body.vertices) {
          const reflected = { ...v };
          reflected[axis] = -reflected[axis];
          // Check if the reflected point exists in the body.
          const found = body.vertices.some((ov) =>
            Math.abs(ov.x - reflected.x) < tol &&
            Math.abs(ov.y - reflected.y) < tol &&
            Math.abs(ov.z - reflected.z) < tol,
          );
          if (!found) return false;
        }
        return true;
      };
      return {
        bodyId: body.id,
        symmetricX: checkSymmetry('x'),
        symmetricY: checkSymmetry('y'),
        symmetricZ: checkSymmetry('z'),
      };
    },
  });

  registerTool({
    name: 'get_bounding_box',
    description: 'Get the axis-aligned bounding box of a body (min, max, size, center).',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
      },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === assertString(args.bodyId, 'bodyId'));
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const v of body.vertices) {
        min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
        max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
      }
      return {
        bodyId: body.id,
        min,
        max,
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
        center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
      };
    },
  });

  registerTool({
    name: 'set_body_appearance',
    description: 'Set a body\'s color, opacity, and material in one call.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID' },
        color: { type: 'number', description: 'Hex color (e.g. 0xff0000 for red)' },
        opacity: { type: 'number', description: 'Opacity 0-1' },
        material: { type: 'string', description: 'Material key from the materials library' },
      },
      required: ['bodyId'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const bodyId = assertString(args.bodyId, 'bodyId');
      const body = store.bodies.find((b) => b.id === bodyId);
      if (!body) throw new Error(`Body "${bodyId}" not found`);
      if (typeof args.color === 'number') store.setBodyColor(bodyId, args.color);
      if (typeof args.opacity === 'number') store.setBodyOpacity(bodyId, Math.max(0, Math.min(1, args.opacity)));
      if (typeof args.material === 'string') store.setBodyMaterial(bodyId, args.material);
      return { success: true, bodyId };
    },
  });

  registerTool({
    name: 'create_sketch_on_plane',
    description: 'Start a sketch on a standard plane (xy, xz, or yz) and draw a shape. Returns sketch entity IDs for constraints/extrude.',
    parameters: {
      type: 'object',
      properties: {
        plane: { type: 'string', enum: ['xy', 'xz', 'yz'], description: 'Sketch plane' },
        shape: {
          type: 'string',
          enum: ['line', 'rectangle', 'circle'],
          description: 'Shape to draw',
        },
        params: {
          type: 'object',
          description: 'Shape parameters: line={x1,y1,x2,y2}, rectangle={x1,y1,x2,y2}, circle={cx,cy,r}',
        },
      },
      required: ['plane', 'shape', 'params'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const plane = assertEnum(args.plane, ['xy', 'xz', 'yz'] as const, 'plane');
      const shape = assertEnum(args.shape, ['line', 'rectangle', 'circle'] as const, 'shape');
      const p = (args.params ?? {}) as Record<string, number>;
      // Create a sketch on the plane.
      const { createSketch } = await import('../../lib/sketch/engine');
      const sketch = createSketch(plane);
      const engine = await import('../../lib/sketch/engine');
      switch (shape) {
        case 'line':
          engine.addLine(sketch, p.x1 ?? 0, p.y1 ?? 0, p.x2 ?? 10, p.y2 ?? 0);
          break;
        case 'rectangle':
          engine.addRectangle(sketch, p.x1 ?? 0, p.y1 ?? 0, p.x2 ?? 10, p.y2 ?? 5);
          break;
        case 'circle':
          engine.addCircle(sketch, p.cx ?? 0, p.cy ?? 0, p.r ?? 5);
          break;
      }
      store.setSketchPlaneId(plane);
      store.setCurrentSketch(sketch);
      store.setSketchActive(true);
      store.setWorkspace('sketch');
      return { success: true, plane, shape, entityCount: sketch.entities.size };
    },
  });

  registerTool({
    name: 'sweep',
    description: 'Sweep a 2D circular profile along a 3D path to create a tube/pipe body.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Profile circle radius (mm)' },
        path: {
          type: 'array',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          description: 'Path points (at least 2)',
        },
        name: { type: 'string', description: 'Body name' },
      },
      required: ['radius', 'path'],
    },
    execute: async (args) => {
      const r = assertNumber(args.radius, 'radius');
      if (!(r > 0)) throw new Error('Radius must be positive');
      const path = (args.path as { x: number; y: number; z: number }[]).map((p) => ({
        x: assertNumber(p.x, 'x'), y: assertNumber(p.y, 'y'), z: assertNumber(p.z, 'z'),
      }));
      if (path.length < 2) throw new Error('Path needs at least 2 points');
      // Create a circular profile in the XY plane.
      const segments = 16;
      const profile: { x: number; y: number }[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        profile.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
      }
      const { sweepBody } = await import('../../lib/geometry/operations');
      const body = sweepBody(profile, path);
      if (typeof args.name === 'string') body.name = args.name;
      useStore.getState().addDirectBodies([body]);
      return { success: true, bodyId: body.id, name: body.name };
    },
  });

  // Beginner parts library + starter projects (TinkerCAD-style gallery).
  registerTool({
    name: 'insert_library_part',
    description: `Insert a prebuilt part from the parts library at a staggered plate position. Valid part ids: ${LIBRARY_PARTS.map((p) => p.id).join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Library part id (see the description for the valid list)' },
      },
      required: ['part_id'],
    },
    execute: async (args) => {
      const id = assertString(args.part_id, 'part_id');
      const bodyId = useStore.getState().insertLibraryPart(id);
      if (!bodyId) {
        throw new Error(`Unknown part id "${id}". Valid ids: ${LIBRARY_PARTS.map((p) => p.id).join(', ')}`);
      }
      return { success: true, bodyId, partId: id };
    },
  });
  registerTool({
    name: 'load_sample_project',
    description: `Replace the scene with a starter sample project (asks to discard unsaved changes). Valid ids: ${SAMPLE_PROJECTS.map((s) => s.id).join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        sample_id: { type: 'string', description: 'Sample id (see the description for the valid list)' },
      },
      required: ['sample_id'],
    },
    execute: async (args) => {
      const id = assertString(args.sample_id, 'sample_id');
      // loadSampleProject awaits a USER confirm dialog when the project is
      // dirty — inside the tool loop that hangs the whole agent turn. Guard:
      // refuse up front instead of popping the dialog.
      if (useStore.getState().projectDirty) {
        return {
          success: false,
          reason: 'project has unsaved changes — save or discard first (the sample load would need a user confirmation)',
        };
      }
      const ok = await loadSampleProject(id);
      if (!ok) throw new Error(`Unknown sample id "${id}"`);
      return { success: true, sampleId: id };
    },
  });
}
