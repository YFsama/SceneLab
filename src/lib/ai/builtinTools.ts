import { registerTool } from './toolRegistry';
import { useStore } from '../../store/app';
import { createSketch } from '../sketch/engine';
import { applyFillet, applyChamfer, applyShell, applyLinearArray, applyCircularArray, applyMirror } from '../geometry/operations';
import { assertNumber, assertBoolean, assertEnum } from './validate';
import type { Vec3, SolidBody } from '../geometry/types';
import {
  analyzePrintability,
  analyzeStability,
  estimateMass,
  estimateMassForMaterial,
  estimatePrintJob,
  recommendOrientation,
  MATERIAL_DENSITIES,
} from '../print';
import type { MaterialName } from '../print';

const MATERIALS = Object.keys(MATERIAL_DENSITIES) as MaterialName[];

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
      const store = useStore.getState();
      store.addSketchLine(
        assertNumber(args.x1, 'x1'),
        assertNumber(args.y1, 'y1'),
        assertNumber(args.x2, 'x2'),
        assertNumber(args.y2, 'y2'),
      );
      return { success: true };
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
      const store = useStore.getState();
      store.addSketchRect(
        assertNumber(args.x1, 'x1'),
        assertNumber(args.y1, 'y1'),
        assertNumber(args.x2, 'x2'),
        assertNumber(args.y2, 'y2'),
      );
      return { success: true };
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
      const store = useStore.getState();
      store.addSketchCircle(
        assertNumber(args.cx, 'cx'),
        assertNumber(args.cy, 'cy'),
        assertNumber(args.radius, 'radius'),
      );
      return { success: true };
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
      // Replace body in store
      const idx = store.bodies.indexOf(body);
      if (idx >= 0) {
        const newBodies = [...store.bodies];
        newBodies[idx] = result;
        useStore.setState({ bodies: newBodies });
      }
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
      const idx = store.bodies.indexOf(body);
      if (idx >= 0) {
        const newBodies = [...store.bodies];
        newBodies[idx] = result;
        useStore.setState({ bodies: newBodies });
      }
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
      const idx = store.bodies.indexOf(body);
      if (idx >= 0) {
        const newBodies = [...store.bodies];
        newBodies[idx] = result;
        useStore.setState({ bodies: newBodies });
      }
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
      const results = applyLinearArray(body, args.direction as Vec3, args.count as number, args.spacing as number);
      useStore.setState({ bodies: [...store.bodies, ...results] });
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
      const axis = args.axis as { origin: Vec3; direction: Vec3 };
      const results = applyCircularArray(body, axis, args.count as number);
      useStore.setState({ bodies: [...store.bodies, ...results] });
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
      const plane = args.plane as { origin: Vec3; normal: Vec3 };
      const result = applyMirror(body, plane);
      useStore.setState({ bodies: [...store.bodies, result] });
      return { success: true, bodyId: result.id };
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
        buildVolume: args.buildVolume as Vec3 | undefined,
      });
      const stability = analyzeStability(body);
      const support = report.overhangs.faces.filter((f) => f.needsSupport);
      return {
        bodyId: body.id,
        overhangs: {
          thresholdDeg: report.overhangs.thresholdDeg,
          facesNeedingSupport: support.length,
          overhangArea: Number(report.overhangs.overhangArea.toFixed(2)),
        },
        mass: { material, grams: Number(report.mass.massGrams.toFixed(3)) },
        buildVolume: report.buildVolume
          ? { fits: report.buildVolume.fits, overage: report.buildVolume.overage }
          : null,
        stability: { stable: stability.stable, tipOverMarginMm: Number(stability.marginMm.toFixed(2)) },
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
        infill: est.infill,
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
        },
        ranked: report.candidates.map((c) => ({
          orientation: c.label,
          supportArea: Number(c.supportArea.toFixed(2)),
        })),
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
      return {
        id: body.id,
        name: body.name,
        vertices: body.vertices.length,
        faces: body.faces.length,
        edges: body.edges.length,
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
}
