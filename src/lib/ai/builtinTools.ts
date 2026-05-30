import { registerTool } from './toolRegistry';
import { useStore } from '../../store/app';
import { createSketch } from '../sketch/engine';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyCircularArray, applyMirror, weldVertices, translateBody, rotateBody, scaleBody, scaleBodyToTarget } from '../geometry/operations';
import { createBox, createBoundingBoxBody, createCylinder, createSphere, createCone, createTorus, createWedge, findBoundaryLoops, computeBoundingBox, computeVolume, computeCentroid, computeSurfaceArea } from '../geometry/brep';
import { importSTLAscii, importOBJ, exportSTLAscii, exportOBJ } from '../io';
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
          enum: ['horizontal', 'vertical', 'parallel', 'perpendicular', 'coincident', 'equal', 'distance'],
          description: 'Constraint type',
        },
        entityIds: { type: 'array', items: { type: 'string' }, description: 'Entity IDs the constraint applies to' },
        value: { type: 'number', description: 'Target value (for distance constraints)' },
      },
      required: ['type', 'entityIds'],
    },
    execute: async (args) => {
      const type = assertEnum(args.type, ['horizontal', 'vertical', 'parallel', 'perpendicular', 'coincident', 'equal', 'distance'] as const, 'type');
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
    name: 'export_body',
    description: 'Export a body as STL (ASCII) or OBJ text — the printable/downloadable mesh.',
    parameters: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'Body ID (defaults to the first body)' },
        format: { type: 'string', enum: ['stl', 'obj'], description: 'Output format (default stl)' },
      },
    },
    execute: async (args) => {
      const body = resolveBody(args.bodyId);
      const format = args.format !== undefined ? assertEnum(args.format, ['stl', 'obj'] as const, 'format') : 'stl';
      const content = format === 'obj' ? exportOBJ(body) : exportSTLAscii(body);
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
      const result = weldVertices(body, tol);
      useStore.getState().replaceBody(body.id, result);
      return { success: true, bodyId: result.id, vertices: result.vertices.length };
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
          supportFaces: report.best.supportFaces,
          buildHeight: Number(report.best.buildHeight.toFixed(2)),
          bedContactArea: Number(report.best.bedContactArea.toFixed(2)),
        },
        ranked: report.candidates.map((c) => ({
          orientation: c.label,
          supportArea: Number(c.supportArea.toFixed(2)),
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
    description: 'Measure the distance between two bodies: centroid distance and the gap between their bounding boxes.',
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
      return {
        centroidDistance: Number(centroidDistance.toFixed(3)),
        boundingBoxGap: Number(Math.hypot(gx, gy, gz).toFixed(3)),
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
}
