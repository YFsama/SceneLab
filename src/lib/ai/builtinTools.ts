import { registerTool } from './toolRegistry';
import { useStore } from '../../store/app';
import { createSketch } from '../sketch/engine';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyGridArray, applyCircularArray, applyMirror, weldVertices, translateBody, rotateBody, scaleBody, scaleBodyToTarget, resizeBody, centerBody, convexHullBody } from '../geometry/operations';
import { minDistanceBetweenBodies, bodiesInterfere, interferenceVolume, computeSceneMassProperties } from '../geometry/measure';
import { booleanOp, hollowBody, mirrorMerge } from '../geometry/boolean';
import { listFaces, angleBetweenFaces } from '../geometry/query';
import { listDimensions } from '../sketch/dimensions';
import { createBox, createBoundingBoxBody, createCylinder, createSphere, createCone, createTorus, createWedge, createPrism, createTube, createCoil, createFrustumTube, findBoundaryLoops, computeBoundingBox, computeVolume, computeCentroid, computeSurfaceArea, computeMassProperties, computePrincipalMoments, computeMomentOfInertiaAboutAxis, computePendulumPeriod } from '../geometry/brep';
import { importSTLAscii, importOBJ, exportSTLAscii, exportOBJ, export3MF } from '../io';
import { exportSTEP } from '../io/step';
import { assertNumber, assertBoolean, assertEnum, assertString, assertVec3 } from './validate';
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
      const sides = Math.max(3, Math.floor(assertNumber(args.sides, 'sides')));
      useStore.getState().addSketchPolygon(
        assertNumber(args.cx, 'cx'),
        assertNumber(args.cy, 'cy'),
        assertNumber(args.radius, 'radius'),
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
      store.performExtrude(
        assertNumber(args.distance, 'distance'),
        args.symmetric !== undefined ? assertBoolean(args.symmetric, 'symmetric') : false,
      );
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
      const angleDeg = args.angleDeg !== undefined ? assertNumber(args.angleDeg, 'angleDeg') : 360;
      useStore.getState().performRevolve((angleDeg * Math.PI) / 180);
      return { success: true };
    },
  });

  registerTool({
    name: 'fillet',
    description: 'Apply fillet (rounded edges) to selected edges of a body',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to fillet' },
        edgeIds: { type: 'array', items: { type: 'string' }, description: 'Edge IDs to fillet' },
        radius: { type: 'number', description: 'Fillet radius in mm' },
      },
      required: ['bodyId', 'radius'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const edgeIds = (args.edgeIds as string[]) ?? body.edges.map((e) => e.id);
      const result = applyFillet(body, edgeIds, args.radius as number);
      store.replaceBody(body.id, result);
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'chamfer',
    description: 'Apply chamfer (beveled edges) to selected edges of a body',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        edgeIds: { type: 'array', items: { type: 'string' }, description: 'Edge IDs to chamfer' },
        distance: { type: 'number', description: 'Chamfer distance in mm' },
      },
      required: ['bodyId', 'distance'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const edgeIds = (args.edgeIds as string[]) ?? body.edges.map((e) => e.id);
      const result = applyChamfer(body, edgeIds, args.distance as number);
      store.replaceBody(body.id, result);
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'shell',
    description: 'Hollow out a body by removing faces and offsetting inward',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body' },
        faceIds: { type: 'array', items: { type: 'string' }, description: 'Face IDs to remove (open faces)' },
        thickness: { type: 'number', description: 'Wall thickness in mm' },
      },
      required: ['bodyId', 'thickness'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const faceIds = (args.faceIds as string[]) ?? [body.faces[0]?.id ?? ''];
      const result = applyShell(body, faceIds, args.thickness as number);
      store.replaceBody(body.id, result);
      return { success: true, bodyId: result.id };
    },
  });

  registerTool({
    name: 'linear_array',
    description: 'Create a linear array (pattern) of a body',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to array' },
        direction: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          description: 'Array direction vector',
        },
        count: { type: 'number', description: 'Number of instances' },
        spacing: { type: 'number', description: 'Spacing between instances in mm' },
      },
      required: ['bodyId', 'direction', 'count', 'spacing'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const results = applyLinearArray(body, assertVec3(args.direction, 'direction'), assertNumber(args.count, 'count'), assertNumber(args.spacing, 'spacing'));
      store.addDirectBodies(results);
      return { success: true, count: results.length };
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
      useStore.getState().replaceBody(body.id, result);
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
    description: 'Create a 2-direction grid pattern (SolidWorks linear pattern with a second direction) of a body.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'ID of the body to pattern' },
        direction1: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'First direction' },
        count1: { type: 'number', description: 'Instances along direction 1' },
        spacing1: { type: 'number', description: 'Spacing along direction 1 (mm)' },
        direction2: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, description: 'Second direction' },
        count2: { type: 'number', description: 'Instances along direction 2' },
        spacing2: { type: 'number', description: 'Spacing along direction 2 (mm)' },
      },
      required: ['bodyId', 'direction1', 'count1', 'spacing1', 'direction2', 'count2', 'spacing2'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const results = applyGridArray(
        body,
        assertVec3(args.direction1, 'direction1'),
        assertNumber(args.count1, 'count1'),
        assertNumber(args.spacing1, 'spacing1'),
        assertVec3(args.direction2, 'direction2'),
        assertNumber(args.count2, 'count2'),
        assertNumber(args.spacing2, 'spacing2'),
      );
      store.addDirectBodies(results);
      return { success: true, count: results.length };
    },
  });

  registerTool({
    name: 'circular_array',
    description: 'Create a circular array (pattern) of a body around an axis',
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
        count: { type: 'number', description: 'Number of instances' },
      },
      required: ['bodyId', 'axis', 'count'],
    },
    execute: async (args) => {
      const store = useStore.getState();
      const body = store.bodies.find((b) => b.id === args.bodyId);
      if (!body) throw new Error(`Body "${args.bodyId}" not found`);
      const axisArg = (args.axis ?? {}) as { origin?: unknown; direction?: unknown };
      const axis = { origin: assertVec3(axisArg.origin, 'axis.origin'), direction: assertVec3(axisArg.direction, 'axis.direction') };
      const results = applyCircularArray(body, axis, assertNumber(args.count, 'count'));
      store.addDirectBodies(results);
      return { success: true, count: results.length };
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
    description: 'Mirror a body across a plane',
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
      const result = applyMirror(body, plane);
      store.addDirectBody(result);
      return { success: true, bodyId: result.id };
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
    description: 'Export a body as STL (ASCII), OBJ, 3MF, or STEP text. STEP is a CAD exchange format (AP203 faceted B-rep).',
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
      return { bodyId: body.id, format, bytes: content.length, content };
    },
  });

  registerTool({
    name: 'import_mesh',
    description: 'Import an ASCII STL or OBJ mesh from text and add it to the scene (format auto-detected).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The STL (ASCII) or OBJ file contents' },
        format: { type: 'string', enum: ['stl', 'obj'], description: 'Override format detection' },
      },
      required: ['content'],
    },
    execute: async (args) => {
      const content = assertString(args.content, 'content');
      let format = args.format !== undefined ? assertEnum(args.format, ['stl', 'obj'] as const, 'format') : undefined;
      if (!format) {
        const head = content.trimStart().slice(0, 200).toLowerCase();
        format = head.startsWith('solid') && content.includes('facet') ? 'stl' : 'obj';
      }
      const body = format === 'stl' ? importSTLAscii(content) : importOBJ(content);
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
      store.clearScene();
      useStore.getState().addDirectBodies(r.bodies);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, result.body);
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
      useStore.getState().replaceBody(body.id, result);
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
      useStore.getState().replaceBody(body.id, seated);
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
      useStore.getState().replaceBody(body.id, hull);
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
      useStore.getState().replaceBody(body.id, centered);
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
    },
    execute: async (args) => {
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
      const store = useStore.getState();
      store.setViewDirection(args.direction as 'top' | 'front' | 'right' | 'iso');
      return { success: true };
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
      const store = useStore.getState();
      store.setProjection(args.mode as 'perspective' | 'orthographic');
      return { success: true, mode: args.mode };
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
}
