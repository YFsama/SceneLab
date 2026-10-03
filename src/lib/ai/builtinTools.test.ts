import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { registerBuiltinTools } from './builtinTools';
import { getTool, getAllTools, clearTools } from './toolRegistry';
import { useStore } from '../../store/app';
import { createBox, computeVolume } from '../geometry';
import { warmUpBooleanEngine } from '../geometry/boolean';
import * as io from '../io';
import type { Vec3 } from '../geometry/types';
import { createSketch, addRectangle, addLine } from '../sketch/engine';

describe('registerBuiltinTools registration', () => {
  it('registers the full tool set with no name collisions', () => {
    clearTools();
    registerBuiltinTools();
    const tools = getAllTools();
    // Guard against tools silently disappearing.
    expect(tools.length).toBeGreaterThanOrEqual(48);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // unique
    // A representative sample across every category must be present.
    for (const n of [
      // primitives
      'create_box', 'create_cylinder', 'create_sphere', 'create_cone', 'create_torus', 'create_wedge',
      'create_stock',
      // sketch/features
      'create_sketch', 'draw_line', 'draw_circle', 'draw_arc', 'add_constraint', 'extrude', 'revolve',
      'fillet', 'chamfer', 'shell', 'create_hole', 'linear_array', 'circular_array', 'mirror',
      'list_features', 'update_feature',
      // transform / scene
      'move_body', 'rotate_body', 'scale_body', 'resize_to_target', 'arrange_on_plate', 'delete_body',
      'clear_scene', 'describe_scene', 'measure_distance', 'get_dimensions', 'list_bodies',
      // mesh io / repair
      'import_mesh', 'export_body', 'export_file', 'export_drawing', 'repair_mesh', 'find_holes',
      // print analysis / optimization
      'estimate_mass', 'analyze_stability', 'analyze_printability', 'check_print_readiness',
      'estimate_print_cost', 'estimate_print_job', 'estimate_hollow_savings', 'recommend_orientation',
      'orient_for_print', 'scale_to_fit',
      // cam / view
      'suggest_feeds_speeds', 'set_view',
      // selection control (vision → face-scoped ops)
      'select_face_at_viewport', 'select_face', 'clear_face_selection', 'select_body',
      // drawing annotation
      'add_drawing_note',
      // sketch editing (Fusion 2D suite)
      'trim_sketch_entity', 'extend_sketch_entity', 'offset_sketch_entity',
      'measure_face_area',
      // takeover: history, feature control, addressing, sketch read-back, workspace
      'undo', 'redo', 'remove_feature', 'set_feature_suppressed', 'reorder_feature',
      'list_edges', 'list_sketch_entities', 'update_sketch_constraint',
      'set_workspace', 'set_body_hidden', 'rename_body',
    ]) {
      expect(names).toContain(n);
    }
    clearTools();
  });
});

describe('AI selection tools (vision face-picking loop)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box], selectedIds: [], selectedFaceIds: [] });
  });

  it('select_face_at_viewport resolves through the pick-face event and sets the face selection', async () => {
    const seen: { xNorm: number; yNorm: number; additive?: boolean }[] = [];
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        xNorm: number; yNorm: number; additive?: boolean;
        resolve: (hit: { faceId: string; bodyId: string } | null) => void;
      };
      seen.push({ xNorm: d.xNorm, yNorm: d.yNorm, additive: d.additive });
      d.resolve({ faceId: 'face_2', bodyId: 'b1' });
    };
    window.addEventListener('scenelab:pick-face', listener);
    const tool = getTool('select_face_at_viewport')!;
    const result = (await tool.execute({ x: 0.25, y: 0.75 })) as {
      success: boolean; faceId: string; bodyId: string;
    };
    window.removeEventListener('scenelab:pick-face', listener);

    expect(result).toEqual({ success: true, faceId: 'face_2', bodyId: 'b1' });
    // Image-space (0..1, y down) → NDC mapping happened in the listener, the
    // tool passes the image coordinates through.
    expect(seen).toEqual([{ xNorm: 0.25, yNorm: 0.75, additive: false }]);
  });

  it('select_face_at_viewport maps coordinates through an active crop region', async () => {
    useStore.setState({
      visionRegion: { x: 0.5, y: 0.5, w: 0.25, h: 0.5 },
    });
    let got = { x: -1, y: -1 };
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        xNorm: number; yNorm: number;
        resolve: (hit: { faceId: string; bodyId: string } | null) => void;
      };
      got = { x: d.xNorm, y: d.yNorm };
      d.resolve({ faceId: 'face_0', bodyId: 'b1' });
    };
    window.addEventListener('scenelab:pick-face', listener);
    await getTool('select_face_at_viewport')!.execute({ x: 0.5, y: 0.5 });
    window.removeEventListener('scenelab:pick-face', listener);
    useStore.setState({ visionRegion: null });
    // Center of the crop (0.5,0.5) in a region at (0.5,0.5) size (0.25,0.5)
    // is the viewport point (0.625, 0.75).
    expect(got.x).toBeCloseTo(0.625, 6);
    expect(got.y).toBeCloseTo(0.75, 6);
  });

  it('select_face_at_viewport throws when nothing answers (no viewport mounted)', async () => {
    const tool = getTool('select_face_at_viewport')!;
    await expect(tool.execute({ x: 0.5, y: 0.5 })).rejects.toThrow(/No face found/);
  });

  it('select_face picks a real face: body first, then the face id', async () => {
    const body = useStore.getState().bodies[0]!;
    const faceId = body.faces[0]!.id;
    const result = (await getTool('select_face')!.execute({ bodyId: body.id, faceId })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(useStore.getState().selectedIds).toContain(body.id);
    expect(useStore.getState().selectedFaceIds).toContain(faceId);
  });

  it('select_face rejects unknown faces and bodies', async () => {
    const body = useStore.getState().bodies[0]!;
    await expect(
      getTool('select_face')!.execute({ bodyId: body.id, faceId: 'face_999' }),
    ).rejects.toThrow(/not found/);
    await expect(
      getTool('select_face')!.execute({ bodyId: 'nope', faceId: 'face_0' }),
    ).rejects.toThrow(/not found/);
  });

  it('clear_face_selection empties the picked faces', async () => {
    useStore.setState({ selectedFaceIds: ['face_1', 'face_2'] });
    await getTool('clear_face_selection')!.execute({});
    expect(useStore.getState().selectedFaceIds).toEqual([]);
  });

  it('select_body selects valid ids and rejects unknown ones', async () => {
    const body = useStore.getState().bodies[0]!;
    const ok = (await getTool('select_body')!.execute({ bodyIds: [body.id] })) as { selectedIds: string[] };
    expect(ok.selectedIds).toEqual([body.id]);
    await expect(
      getTool('select_body')!.execute({ bodyIds: ['missing'] }),
    ).rejects.toThrow(/not found/);
  });
});

describe('builtin analysis tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    // Reset the shared store (feature tree + direct bodies) to avoid cross-test
    // pollution, then seed a 1 cm³ box for the analysis tools.
    useStore.getState().clearScene();
    useStore.setState({ bodies: [createBox(10, 10, 10)] });
  });

  it('estimate_mass returns PLA mass by default', async () => {
    const tool = getTool('estimate_mass')!;
    const result = (await tool.execute({})) as { massGrams: number; density: number };
    expect(result.density).toBe(1.24);
    expect(result.massGrams).toBeCloseTo(1.24, 2);
  });

  it('estimate_mass honors a chosen material', async () => {
    const tool = getTool('estimate_mass')!;
    const result = (await tool.execute({ material: 'ABS' })) as { massGrams: number };
    expect(result.massGrams).toBeCloseTo(1.04, 2);
  });

  it('analyze_stability reports a centered box as stable', async () => {
    const tool = getTool('analyze_stability')!;
    const result = (await tool.execute({})) as { stable: boolean; footprintArea: number };
    expect(result.stable).toBe(true);
    expect(result.footprintArea).toBeCloseTo(100, 0);
  });

  it('analyze_printability returns a combined report', async () => {
    const tool = getTool('analyze_printability')!;
    const result = (await tool.execute({
      material: 'PETG',
      buildVolume: { x: 200, y: 200, z: 200 },
    })) as {
      overhangs: { facesNeedingSupport: number; worstAngleDeg: number };
      mass: { material: string; grams: number };
      buildVolume: { fits: boolean } | null;
      stability: { stable: boolean };
      recommendedOrientation: { orientation: string };
    };
    expect(result.mass.material).toBe('PETG');
    expect(result.buildVolume?.fits).toBe(true);
    expect(result.stability.stable).toBe(true);
    expect(typeof result.overhangs.facesNeedingSupport).toBe('number');
    expect(result.overhangs.worstAngleDeg).toBe(90); // a box has no overhangs
    expect(typeof result.recommendedOrientation.orientation).toBe('string');
  });

  it('estimate_print_job returns filament and time figures', async () => {
    useStore.setState({ bodies: [createBox(20, 20, 20)] });
    const tool = getTool('estimate_print_job')!;
    const result = (await tool.execute({ infill: 1, material: 'PLA' })) as {
      filamentMassG: number;
      printTimeMinutes: number;
      infill: number;
    };
    expect(result.infill).toBe(1);
    expect(result.filamentMassG).toBeCloseTo(8 * 1.24, 0); // solid 8 cm³ PLA
    expect(result.printTimeMinutes).toBeGreaterThan(0);
  });

  it('estimate_scene_print_job sums across all bodies', async () => {
    useStore.setState({ bodies: [createBox(20, 20, 20), createBox(20, 20, 20)], directBodies: [] });
    const tool = getTool('estimate_scene_print_job')!;
    const result = (await tool.execute({ infill: 1, material: 'PLA' })) as {
      bodyCount: number;
      filamentMassG: number;
    };
    expect(result.bodyCount).toBe(2);
    // Two solid 8 cm³ PLA boxes ≈ 2 × 8 × 1.24 g.
    expect(result.filamentMassG).toBeCloseTo(2 * 8 * 1.24, 0);
  });

  it('estimate_hollow_savings reports shell savings', async () => {
    useStore.setState({ bodies: [createBox(20, 20, 20)], directBodies: [] });
    const tool = getTool('estimate_hollow_savings')!;
    const result = (await tool.execute({ wallThickness: 1.2 })) as { savedPercent: number };
    expect(result.savedPercent).toBeCloseTo(64, 0);
  });

  it('estimate_print_cost returns material and total cost', async () => {
    useStore.setState({ bodies: [createBox(20, 20, 20)], directBodies: [] });
    const tool = getTool('estimate_print_cost')!;
    const result = (await tool.execute({ infill: 1, pricePerKg: 25 })) as {
      materialCost: number;
      totalCost: number;
    };
    expect(result.materialCost).toBeCloseTo(0.25, 2); // 9.92 g PLA @ 25/kg
    expect(result.totalCost).toBeCloseTo(0.25, 2);
  });

  it('recommend_orientation returns a best orientation and ranking', async () => {
    const tool = getTool('recommend_orientation')!;
    const result = (await tool.execute({})) as {
      best: { orientation: string; supportArea: number };
      ranked: Array<{ orientation: string }>;
    };
    expect(result.ranked).toHaveLength(6);
    expect(result.best.supportArea).toBe(0); // a box needs no support
  });

  it('draw_line returns an entity id, then add_constraint uses it', async () => {
    useStore.getState().setCurrentSketch(createSketch('xy'));
    const line = getTool('draw_line')!;
    const a = (await line.execute({ x1: 0, y1: 0, x2: 10, y2: 0 })) as { entityId: string };
    const b = (await line.execute({ x1: 0, y1: 5, x2: 10, y2: 5 })) as { entityId: string };
    expect(a.entityId).toBeTruthy();
    await getTool('add_constraint')!.execute({ type: 'horizontal', entityIds: [a.entityId, b.entityId] });
    expect(useStore.getState().currentSketch!.constraints.size).toBe(1);
  });

  it('draw_arc adds an arc entity to the current sketch', async () => {
    useStore.getState().setCurrentSketch(createSketch('xy'));
    const tool = getTool('draw_arc')!;
    await tool.execute({ cx: 0, cy: 0, radius: 5, startAngle: 0, endAngle: 90 });
    const sketch = useStore.getState().currentSketch!;
    expect(Array.from(sketch.entities.values()).some((e) => e.type === 'arc')).toBe(true);
  });

  it('create_box adds a box body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [] });
    const tool = getTool('create_box')!;
    const result = (await tool.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Box');
    expect(bodies[0]?.id).toBe(result.bodyId);
  });

  it('create_cylinder adds a cylinder body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [], directBodies: [] });
    const tool = getTool('create_cylinder')!;
    await tool.execute({ radius: 5, height: 20 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Cylinder');
  });

  it('create_sphere adds a sphere body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [], directBodies: [] });
    const tool = getTool('create_sphere')!;
    await tool.execute({ radius: 8 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Sphere');
  });

  it('create_cone adds a cone body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [], directBodies: [] });
    const tool = getTool('create_cone')!;
    await tool.execute({ radiusBottom: 5, radiusTop: 0, height: 12 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Cone');
  });

  it('create_torus adds a torus body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [], directBodies: [] });
    const tool = getTool('create_torus')!;
    await tool.execute({ majorRadius: 10, minorRadius: 3 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Torus');
  });

  it('create_stock adds a margin-enclosing stock block', async () => {
    const part = createBox(10, 10, 10);
    useStore.setState({ bodies: [part], directBodies: [part] });
    const tool = getTool('create_stock')!;
    await tool.execute({ bodyId: part.id, margin: 2 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.name === 'Stock')).toBe(true);
  });

  it('create_wedge adds a wedge body to the scene', async () => {
    useStore.setState({ bodies: [], objectIds: [], directBodies: [] });
    const tool = getTool('create_wedge')!;
    await tool.execute({ width: 10, height: 6, depth: 4 });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Wedge');
  });

  it('suggest_feeds_speeds returns RPM and feed for a library tool', async () => {
    const tool = getTool('suggest_feeds_speeds')!;
    const result = (await tool.execute({ toolId: 'em-6mm', material: 'aluminum' })) as {
      spindleRpm: number;
      feedRate: number;
      surfaceSpeed: number;
    };
    expect(result.surfaceSpeed).toBe(300); // aluminium, carbide
    expect(result.spindleRpm).toBeGreaterThan(0);
    expect(result.feedRate).toBeGreaterThan(0);
  });

  it('suggest_feeds_speeds errors on an unknown tool id', async () => {
    const tool = getTool('suggest_feeds_speeds')!;
    await expect(tool.execute({ toolId: 'nope', material: 'steel' })).rejects.toThrow('not found');
  });

  it('check_print_readiness reports ready for a fitting box', async () => {
    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] });
    const tool = getTool('check_print_readiness')!;
    const result = (await tool.execute({ buildVolume: { x: 200, y: 200, z: 200 } })) as {
      ready: boolean;
      issues: unknown[];
    };
    expect(result.ready).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('check_print_readiness flags an oversized box', async () => {
    useStore.setState({ bodies: [createBox(300, 300, 300)], directBodies: [] });
    const tool = getTool('check_print_readiness')!;
    const result = (await tool.execute({ buildVolume: { x: 200, y: 200, z: 200 } })) as {
      ready: boolean;
      issues: Array<{ code: string }>;
    };
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'too-big')).toBe(true);
  });

  it('scale_to_fit shrinks an oversized direct body in place', async () => {
    const big = createBox(300, 300, 300);
    useStore.setState({ bodies: [big], directBodies: [big] });
    const tool = getTool('scale_to_fit')!;
    await tool.execute({ bodyId: big.id, buildVolume: { x: 200, y: 200, z: 200 } });
    const bodies = useStore.getState().bodies;
    expect(bodies).toHaveLength(1);
    // The (rescaled) body now fits within 200mm.
    const xs = bodies[0]!.vertices.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(200 + 1e-6);
  });

  it('orient_for_print reports the applied orientation', async () => {
    const box = createBox(10, 20, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('orient_for_print')!;
    const result = (await tool.execute({ bodyId: box.id })) as { rotated: boolean; orientation: string };
    expect(typeof result.orientation).toBe('string');
    expect(result.rotated).toBe(true);
  });

  it('arrange_on_plate lays out all bodies without dropping any', async () => {
    const boxes = [createBox(10, 10, 10), createBox(10, 10, 10), createBox(10, 10, 10), createBox(10, 10, 10)];
    useStore.setState({ bodies: boxes, directBodies: boxes });
    const tool = getTool('arrange_on_plate')!;
    const result = (await tool.execute({ bedX: 25, bedZ: 25 })) as { count: number; fits: boolean };
    expect(result.count).toBe(4);
    expect(result.fits).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(4);
  });

  it('move_body rejects a malformed offset vector', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('move_body')!;
    await expect(tool.execute({ bodyId: box.id, offset: { x: 1, y: 2 } })).rejects.toThrow('Vec3');
    await expect(tool.execute({ bodyId: box.id, offset: { x: 1, y: 2, z: Infinity } })).rejects.toThrow('Vec3');
  });

  it('resize_to_target scales a body to a target axis size', async () => {
    const box = createBox(10, 20, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('resize_to_target')!;
    await tool.execute({ bodyId: box.id, axis: 'y', target: 40 });
    const ys = useStore.getState().bodies[0]!.vertices.map((v) => v.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 3);
  });

  it('scale_body scales volume by factor³ about the center', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('scale_body')!;
    await tool.execute({ bodyId: box.id, factor: 2 });
    const scaled = useStore.getState().bodies[0]!;
    const xs = scaled.vertices.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 5); // 10 → 20
  });

  it('scale_body rejects a non-finite factor', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('scale_body')!;
    await expect(tool.execute({ bodyId: box.id, factor: Infinity })).rejects.toThrow('number');
  });

  it('move_body translates a direct body in place', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('move_body')!;
    await tool.execute({ bodyId: box.id, offset: { x: 100, y: 0, z: 0 } });
    const moved = useStore.getState().bodies[0]!;
    const xs = moved.vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(95, 5); // -5 + 100
  });

  it('rotate_body rotates in place, preserving volume', async () => {
    const box = createBox(10, 20, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const before = box.vertices.length;
    const tool = getTool('rotate_body')!;
    await tool.execute({ bodyId: box.id, axis: { x: 0, y: 0, z: 1 }, angleDeg: 90 });
    const rotated = useStore.getState().bodies[0]!;
    expect(rotated.vertices).toHaveLength(before);
    // After a 90° turn about Z, the part's X extent becomes the old Y extent (20).
    const xs = rotated.vertices.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 3);
  });

  it('repair_mesh welds and replaces a direct body', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('repair_mesh')!;
    const result = (await tool.execute({ bodyId: box.id })) as { vertices: number; watertight: boolean; holesAfter: number };
    expect(result.vertices).toBe(8);
    // A welded box is closed — repair reports it watertight.
    expect(result.watertight).toBe(true);
    expect(result.holesAfter).toBe(0);
  });

  it('export_body validates STL by default and OBJ on request without inlining content', async () => {
    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] });
    const tool = getTool('export_body')!;
    const stl = (await tool.execute({})) as { format: string; preview: string; bytes: number; content?: string };
    expect(stl.format).toBe('stl');
    expect(stl.preview).toMatch(/^solid /);
    expect(stl.bytes).toBeGreaterThan(0);
    expect(stl.content).toBeUndefined(); // content must never be inlined

    const obj = (await tool.execute({ format: 'obj' })) as { preview: string; content?: string };
    expect(obj.preview).toContain('v ');
    expect(obj.content).toBeUndefined();

    const tmf = (await tool.execute({ format: '3mf' })) as { format: string; preview: string; content?: string };
    expect(tmf.format).toBe('3mf');
    expect(tmf.preview).toContain('<model');
    expect(tmf.content).toBeUndefined();
  });

  it('import_mesh loads an OBJ string into the scene', async () => {
    useStore.setState({ bodies: [], directBodies: [] });
    const obj = ['o tri', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n');
    const tool = getTool('import_mesh')!;
    const result = (await tool.execute({ content: obj })) as { faces: number; vertices: number };
    expect(result.faces).toBe(1);
    expect(result.vertices).toBe(3);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('import_mesh auto-detects ASCII STL', async () => {
    useStore.setState({ bodies: [], directBodies: [] });
    const stl = [
      'solid s',
      ' facet normal 0 0 1',
      '  outer loop',
      '   vertex 0 0 0',
      '   vertex 1 0 0',
      '   vertex 0 1 0',
      '  endloop',
      ' endfacet',
      'endsolid s',
    ].join('\n');
    const tool = getTool('import_mesh')!;
    const result = (await tool.execute({ content: stl })) as { faces: number };
    expect(result.faces).toBe(1);
  });

  it('find_holes reports zero holes for a watertight box', async () => {
    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] });
    const tool = getTool('find_holes')!;
    const result = (await tool.execute({})) as { holeCount: number; boundaryEdges: number };
    expect(result.holeCount).toBe(0);
    expect(result.boundaryEdges).toBe(0);
  });

  it('revolve turns the current sketch into a body', async () => {
    useStore.setState({ bodies: [], directBodies: [] });
    const sketch = createSketch('xy');
    addRectangle(sketch, 2, 0, 4, 2);
    useStore.getState().setCurrentSketch(sketch);
    const tool = getTool('revolve')!;
    await tool.execute({ angleDeg: 360 });
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('delete_body removes a direct body', async () => {
    const a = createBox(5, 5, 5);
    const b = createBox(5, 5, 5);
    useStore.setState({ bodies: [a, b], directBodies: [a, b] });
    const tool = getTool('delete_body')!;
    const result = (await tool.execute({ bodyId: a.id })) as { removed: number };
    expect(result.removed).toBe(1);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('get_dimensions returns the X/Y/Z extents', async () => {
    useStore.setState({ bodies: [createBox(10, 20, 30)], directBodies: [] });
    const tool = getTool('get_dimensions')!;
    const result = (await tool.execute({})) as { x: number; y: number; z: number; diagonal: number };
    expect(result.x).toBeCloseTo(10, 3);
    expect(result.y).toBeCloseTo(20, 3);
    expect(result.z).toBeCloseTo(30, 3);
    expect(result.diagonal).toBeCloseTo(Math.hypot(10, 20, 30), 2);
  });

  it('measure_distance reports centroid distance and bbox gap', async () => {
    const a = createBox(10, 10, 10); // x ∈ [-5,5]
    const b = createBox(10, 10, 10);
    // Shift b by +20 in x → x ∈ [15,25].
    const shifted = { ...b, vertices: b.vertices.map((v) => ({ ...v, x: v.x + 20 })) };
    useStore.setState({ bodies: [a, shifted], directBodies: [] });
    const tool = getTool('measure_distance')!;
    const result = (await tool.execute({ bodyIdA: a.id, bodyIdB: shifted.id })) as {
      centroidDistance: number;
      boundingBoxGap: number;
    };
    expect(result.centroidDistance).toBeCloseTo(20, 2);
    expect(result.boundingBoxGap).toBeCloseTo(10, 2); // 15 - 5
  });

  it('describe_scene summarizes count and total volume', async () => {
    useStore.setState({ bodies: [createBox(10, 10, 10), createBox(10, 10, 10)], directBodies: [] });
    const tool = getTool('describe_scene')!;
    const result = (await tool.execute({})) as { bodyCount: number; totalVolumeCm3: number };
    expect(result.bodyCount).toBe(2);
    expect(result.totalVolumeCm3).toBeCloseTo(2, 2); // 1000 + 1000 mm³ = 2 cm³
  });

  it('clear_scene empties the scene', async () => {
    useStore.setState({ bodies: [createBox(5, 5, 5)], directBodies: [createBox(5, 5, 5)] });
    const tool = getTool('clear_scene')!;
    await tool.execute({});
    expect(useStore.getState().bodies).toHaveLength(0);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });

  it('get_body_info returns volume, surface area and dimensions', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [] });
    const tool = getTool('get_body_info')!;
    const result = (await tool.execute({ bodyId: box.id })) as {
      volumeCm3: number;
      surfaceAreaMm2: number;
      dimensions: { x: number; y: number; z: number };
    };
    expect(result.volumeCm3).toBeCloseTo(1, 2); // 1000 mm³
    expect(result.surfaceAreaMm2).toBeCloseTo(600, 0); // 6 × 100
    expect(result.dimensions.x).toBeCloseTo(10, 3);
  });

  it('end-to-end workflow: create → analyze → orient → export', async () => {
    useStore.getState().clearScene();
    const created = (await getTool('create_box')!.execute({ width: 50, height: 80, depth: 50 })) as { bodyId: string };
    expect(useStore.getState().bodies).toHaveLength(1);

    const ready = (await getTool('check_print_readiness')!.execute({
      bodyId: created.bodyId,
      buildVolume: { x: 200, y: 200, z: 200 },
    })) as { ready: boolean };
    expect(ready.ready).toBe(true);

    await getTool('orient_for_print')!.execute({});
    expect(useStore.getState().bodies).toHaveLength(1);

    const exported = (await getTool('export_body')!.execute({ format: 'stl' })) as { preview: string; content?: string };
    expect(exported.preview).toMatch(/^solid /);
    expect(exported.content).toBeUndefined();
  });

  it('throws a clear error when the body is missing', async () => {
    const tool = getTool('estimate_mass')!;
    await expect(tool.execute({ bodyId: 'nope' })).rejects.toThrow('not found');
  });
});

describe('new AI tools', () => {
  it('set_projection switches projection mode', async () => {
    const tool = getTool('set_projection')!;
    await tool.execute({ mode: 'orthographic' });
    expect(useStore.getState().projection).toBe('orthographic');
    await tool.execute({ mode: 'perspective' });
    expect(useStore.getState().projection).toBe('perspective');
  });

  it('set_view changes view direction', async () => {
    const tool = getTool('set_view')!;
    await tool.execute({ direction: 'top' });
    expect(useStore.getState().viewDirection).toBe('top');
    await tool.execute({ direction: 'iso' });
    expect(useStore.getState().viewDirection).toBe('iso');
  });

  it('sketch_rectangle_and_extrude creates a body', async () => {
    const tool = getTool('sketch_rectangle_and_extrude')!;
    const result = (await tool.execute({ width: 10, depth: 20, height: 30 })) as { success: boolean; bodyId: string };
    expect(result.success).toBe(true);
    expect(result.bodyId).toBeTruthy();
    // Clean up.
    useStore.getState().clearScene();
  });

  it('get_bounding_box returns min/max/size/center', async () => {
    // Add a body first.
    useStore.getState().addDirectBodies([{ id: 'test_bb', name: 'Test', vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: 30 }], faces: [], edges: [] }]);
    const tool = getTool('get_bounding_box')!;
    const result = (await tool.execute({ bodyId: 'test_bb' })) as { min: Vec3; max: Vec3; size: Vec3; center: Vec3 };
    expect(result.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.max).toEqual({ x: 10, y: 20, z: 30 });
    expect(result.size).toEqual({ x: 10, y: 20, z: 30 });
    expect(result.center).toEqual({ x: 5, y: 10, z: 15 });
    useStore.getState().clearScene();
  });

  it('export_body supports step format', async () => {
    useStore.getState().addDirectBodies([{ id: 'test_exp', name: 'Test', vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], faces: [{ id: 'f1', vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], normal: { x: 0, y: 0, z: 1 } }], edges: [] }]);
    const tool = getTool('export_body')!;
    const result = (await tool.execute({ bodyId: 'test_exp', format: 'step' })) as { format: string; preview: string; content?: string };
    expect(result.format).toBe('step');
    expect(result.preview).toContain('ISO-10303-21');
    expect(result.content).toBeUndefined();
    useStore.getState().clearScene();
  });
});

describe('modeling AI tools', () => {
  beforeEach(() => {
    useStore.getState().clearScene();
  });

  it('boolean_op unions two overlapping boxes', async () => {
    const tool = getTool('boolean_op')!;
    const { createBox } = await import('../geometry/brep');
    const a = createBox(10, 10, 10);
    const b = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([a, b]);
    const result = (await tool.execute({ bodyIdA: a.id, bodyIdB: b.id, op: 'union' })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('fillet applies to a body', async () => {
    const tool = getTool('fillet')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = await tool.execute({ bodyId: box.id, radius: 1 });
    expect(result).toBeDefined();
  });

  it('chamfer applies to a body', async () => {
    const tool = getTool('chamfer')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = await tool.execute({ bodyId: box.id, distance: 1 });
    expect(result).toBeDefined();
  });

  it('hollow_body creates a shell', async () => {
    const tool = getTool('hollow_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(20, 20, 20);
    useStore.getState().addDirectBodies([box]);
    useStore.getState().selectObject(box.id);
    const result = (await tool.execute({ wallThickness: 2 })) as { success: boolean; bodyId: string };
    expect(result.success).toBe(true);
    expect(result.bodyId).toBeTruthy();
  });

  it('analyze_symmetry checks axis symmetry', async () => {
    const tool = getTool('analyze_symmetry')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id })) as { symmetricX: boolean; symmetricY: boolean; symmetricZ: boolean };
    expect(typeof result.symmetricX).toBe('boolean');
    expect(typeof result.symmetricY).toBe('boolean');
    expect(typeof result.symmetricZ).toBe('boolean');
  });

  it('clear_scene removes all bodies', async () => {
    const tool = getTool('clear_scene')!;
    const { createBox } = await import('../geometry/brep');
    useStore.getState().addDirectBodies([createBox(10, 10, 10)]);
    expect(useStore.getState().bodies.length).toBeGreaterThan(0);
    await tool.execute({});
    expect(useStore.getState().bodies.length).toBe(0);
  });

  it('describe_scene returns body information', async () => {
    const tool = getTool('describe_scene')!;
    const { createBox } = await import('../geometry/brep');
    useStore.getState().addDirectBodies([createBox(10, 10, 10)]);
    const result = (await tool.execute({})) as { bodyCount: number };
    expect(result.bodyCount).toBeGreaterThan(0);
  });

  it('delete_body removes a body by ID', async () => {
    const tool = getTool('delete_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    expect(useStore.getState().bodies.length).toBe(1);
    await tool.execute({ bodyId: box.id });
    expect(useStore.getState().bodies.length).toBe(0);
  });

  it('move_body translates a body', async () => {
    const tool = getTool('move_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id, offset: { x: 50, y: 0, z: 0 } })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('rotate_body rotates a body', async () => {
    const tool = getTool('rotate_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id, axis: { x: 0, y: 0, z: 1 }, angleDeg: 90 })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('scale_body scales a body', async () => {
    const tool = getTool('scale_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id, factor: 2 })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('center_body centers a body at origin', async () => {
    const tool = getTool('center_body')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('convex_hull creates a convex hull', async () => {
    const tool = getTool('convex_hull')!;
    const { createBox } = await import('../geometry/brep');
    const box = createBox(10, 10, 10);
    useStore.getState().addDirectBodies([box]);
    const result = (await tool.execute({ bodyId: box.id })) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('list_bodies returns body information', async () => {
    const tool = getTool('list_bodies')!;
    const { createBox } = await import('../geometry/brep');
    useStore.getState().addDirectBodies([createBox(10, 10, 10)]);
    const result = await tool.execute({});
    expect(result).toBeDefined();
  });

  it('create_standard_planes adds datum planes', async () => {
    const tool = getTool('create_standard_planes')!;
    await tool.execute({});
    expect(useStore.getState().planes.length).toBe(3);
  });
});

describe('add_drawing_note tool', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().newProject();
  });

  it('adds a note with stacked default placement and returns its id', async () => {
    const r1 = (await getTool('add_drawing_note')!.execute({ text: 'Anodize after deburr' })) as { success: boolean; noteId: string; y: number };
    const r2 = (await getTool('add_drawing_note')!.execute({ text: 'Second' })) as { noteId: string; y: number };
    expect(r1.success).toBe(true);
    expect(r2.y).toBeGreaterThan(r1.y); // stacked, never overlapping
    const notes = useStore.getState().drawingNotes;
    expect(notes.map((n) => n.text)).toEqual(['Anodize after deburr', 'Second']);
    expect(notes.map((n) => n.id)).toContain(r1.noteId);
  });

  it('honors explicit sheet coordinates', async () => {
    await getTool('add_drawing_note')!.execute({ text: 'At corner', x: 700, y: 80 });
    const n = useStore.getState().drawingNotes[0]!;
    expect(n.x).toBe(700);
    expect(n.y).toBe(80);
  });

  it('rejects empty text', async () => {
    await expect(getTool('add_drawing_note')!.execute({ text: '   ' })).rejects.toThrow(/empty/i);
    expect(useStore.getState().drawingNotes).toEqual([]);
  });

  it('the edit is one undo entry (drawing sheet is history-covered)', async () => {
    await getTool('add_drawing_note')!.execute({ text: 'undo me' });
    useStore.getState().undo();
    expect(useStore.getState().drawingNotes).toEqual([]);
  });
});

describe('AI file export tools (export_file / export_drawing)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().newProject();
  });

  /** jsdom implements neither URL.createObjectURL nor the anchor download —
   * stub both so the binary Blob+anchor path (binary STL / 3MF, mirroring the
   * palette export buttons) is observable. Returns the clicked file names. */
  function observeBinaryDownloads(): { downloads: string[]; restore: () => void } {
    const downloads: string[] = [];
    const urlRef = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const prevCreate = urlRef.createObjectURL;
    const prevRevoke = urlRef.revokeObjectURL;
    URL.createObjectURL = () => 'blob:scenelab-test';
    URL.revokeObjectURL = () => undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    return {
      downloads,
      restore: () => {
        clickSpy.mockRestore();
        if (prevCreate !== undefined) URL.createObjectURL = prevCreate as typeof URL.createObjectURL;
        else delete (URL as { createObjectURL?: unknown }).createObjectURL;
        if (prevRevoke !== undefined) URL.revokeObjectURL = prevRevoke as typeof URL.revokeObjectURL;
        else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      },
    };
  }

  it('export_file stl downloads a binary STL per body without inlining content', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const { downloads, restore } = observeBinaryDownloads();
    try {
      const result = (await getTool('export_file')!.execute({ format: 'stl' })) as {
        success: boolean; bytes: number; filename: string; fileCount: number; content?: string;
      };
      expect(result.success).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.filename).toBe('scenelab.stl');
      expect(result.fileCount).toBe(1);
      expect(result.content).toBeUndefined(); // never inline the payload
      // The browser download was actually triggered (anchor with the name).
      expect(downloads).toEqual(['scenelab.stl']);
    } finally {
      restore();
    }
  });

  it('export_file with several bodies and no filename names files after the bodies (palette parity)', async () => {
    const a = createBox(10, 10, 10);
    const b = createBox(5, 5, 5);
    b.name = 'Plate'; // distinct names prove the per-body naming
    useStore.setState({ bodies: [a, b], directBodies: [a, b] });
    const { downloads, restore } = observeBinaryDownloads();
    try {
      const result = (await getTool('export_file')!.execute({ format: 'stl' })) as {
        success: boolean; bytes: number; fileCount: number; files?: { filename: string }[];
      };
      expect(result.fileCount).toBe(2);
      expect(downloads).toEqual([`${a.name}.stl`, `${b.name}.stl`]);
      expect(result.files?.map((f) => f.filename)).toEqual([`${a.name}.stl`, `${b.name}.stl`]);
    } finally {
      restore();
    }
  });

  it('export_file 3mf bundles every body into one binary package', async () => {
    const a = createBox(10, 10, 10);
    const b = createBox(5, 5, 5);
    useStore.setState({ bodies: [a, b], directBodies: [a, b] });
    const { downloads, restore } = observeBinaryDownloads();
    try {
      const result = (await getTool('export_file')!.execute({ format: '3mf' })) as {
        success: boolean; bytes: number; filename: string; fileCount: number; bodyCount: number;
      };
      expect(result.success).toBe(true);
      expect(result.fileCount).toBe(1); // one package for the whole set
      expect(result.bodyCount).toBe(2);
      expect(result.filename).toBe('scenelab.3mf');
      expect(result.bytes).toBeGreaterThan(0);
      expect(downloads).toEqual(['scenelab.3mf']);
    } finally {
      restore();
    }
  });

  it('export_file obj/step route text formats through downloadFile', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const captured: { content: string; filename: string }[] = [];
    const dlSpy = vi.spyOn(io, 'downloadFile').mockImplementation((content, filename) => {
      captured.push({ content, filename });
    });
    try {
      const obj = (await getTool('export_file')!.execute({ format: 'obj' })) as {
        success: boolean; bytes: number; filename: string; content?: string;
      };
      expect(obj.filename).toBe('scenelab.obj');
      expect(obj.bytes).toBe(captured[0]!.content.length);
      expect(obj.content).toBeUndefined();
      expect(captured[0]!.content).toContain('v '); // real OBJ text reached the downloader

      const step = (await getTool('export_file')!.execute({ format: 'step' })) as { filename: string };
      expect(step.filename).toBe('scenelab.step');
      expect(captured[1]!.content).toContain('ISO-10303-21');
    } finally {
      dlSpy.mockRestore();
    }
  });

  it('export_file sanitizes the filename (strips path traversal)', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const captured: { filename: string }[] = [];
    const dlSpy = vi.spyOn(io, 'downloadFile').mockImplementation((_content, filename) => {
      captured.push({ filename });
    });
    try {
      const result = (await getTool('export_file')!.execute({ format: 'obj', filename: '../evil' })) as {
        filename: string;
      };
      expect(result.filename).toBe('evil.obj'); // '../' stripped, canonical ext kept
      expect(captured[0]!.filename).toBe('evil.obj');
    } finally {
      dlSpy.mockRestore();
    }
  });

  it('export_file rejects an unknown format and refuses unknown bodyId / empty scenes', async () => {
    await expect(getTool('export_file')!.execute({ format: 'ply' })).rejects.toThrow(/format/i);

    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const missing = (await getTool('export_file')!.execute({ format: 'stl', bodyId: 'nope' })) as {
      success: boolean; reason?: string;
    };
    expect(missing.success).toBe(false);
    expect(missing.reason).toMatch(/not found/i);

    useStore.setState({ bodies: [], directBodies: [] });
    const empty = (await getTool('export_file')!.execute({ format: 'stl' })) as { success: boolean };
    expect(empty.success).toBe(false);
  });

  it('export_drawing downloads the sheet SVG with all four views and the stored notes', async () => {
    const box = createBox(20, 10, 30);
    useStore.setState({ bodies: [box], directBodies: [box] });
    useStore.getState().addDrawingNote({ id: 'n1', x: 40, y: 560, text: 'Tolerances: ISO 2768' });
    const captured: { content: string; filename: string }[] = [];
    const dlSpy = vi.spyOn(io, 'downloadFile').mockImplementation((content, filename) => {
      captured.push({ content, filename });
    });
    try {
      const result = (await getTool('export_drawing')!.execute({})) as {
        success: boolean; bytes: number; filename: string; viewCount: number;
      };
      expect(result.success).toBe(true);
      expect(result.filename).toBe('drawing.svg');
      expect(result.viewCount).toBe(4); // Front, Top, Right, Iso
      expect(result.bytes).toBe(captured[0]!.content.length);
      expect(result.bytes).toBeGreaterThan(0);
      const svg = captured[0]!.content;
      expect(svg).toContain('<svg');
      expect(svg).toContain('Front');
      expect(svg).toContain('Iso');
      expect(svg).toContain('Tolerances: ISO 2768'); // the note is on the sheet
    } finally {
      dlSpy.mockRestore();
    }
  });

  it('export_drawing refuses an empty scene and non-SVG formats', async () => {
    const empty = (await getTool('export_drawing')!.execute({})) as { success: boolean; reason?: string };
    expect(empty.success).toBe(false);
    expect(empty.reason).toMatch(/no bodies/i);

    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] });
    // PNG/PDF go through canvas rendering in the UI — the tool refuses them.
    await expect(getTool('export_drawing')!.execute({ format: 'pdf' })).rejects.toThrow(/format/i);
  });
});

describe('AI sketch editing tools (trim/extend/offset)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().setSketchActive(true);
    useStore.getState().setCurrentSketch(createSketch('xz'));
  });

  it('offset_sketch_entity grows a circle and returns the new id', async () => {
    const store = useStore.getState();
    const circle = store.addSketchCircle(0, 0, 10);
    const r = (await getTool('offset_sketch_entity')!.execute({ entityId: circle, distance: 2 })) as { newEntityIds: string[] };
    const copy = useStore.getState().currentSketch!.entities.get(r.newEntityIds[0]!);
    expect(copy?.type === 'circle' && copy.radius).toBeCloseTo(12, 9);
  });

  it('offset_sketch_entity throws when the offset would collapse', async () => {
    const store = useStore.getState();
    const circle = store.addSketchCircle(0, 0, 2);
    await expect(
      getTool('offset_sketch_entity')!.execute({ entityId: circle, distance: -3 }),
    ).rejects.toThrow(/refused|collapse/i);
  });

  it('trim_sketch_entity deletes an uncrossed line entirely', async () => {
    const store = useStore.getState();
    const line = store.addSketchLine(0, 0, 10, 10);
    const before = useStore.getState().currentSketch!.entities.size;
    await getTool('trim_sketch_entity')!.execute({ entityId: line, x: 5, y: 5 });
    // The line plus its two endpoints are gone.
    expect(useStore.getState().currentSketch!.entities.size).toBe(before - 3);
  });

  it('trim/extend throw without an active sketch', async () => {
    useStore.getState().setCurrentSketch(null);
    await expect(getTool('trim_sketch_entity')!.execute({ entityId: 'x', x: 0, y: 0 })).rejects.toThrow(/No active sketch/);
    await expect(getTool('extend_sketch_entity')!.execute({ entityId: 'x', x: 0, y: 0 })).rejects.toThrow(/No active sketch/);
  });

  it('extend_sketch_entity reaches the crossing boundary', async () => {
    const store = useStore.getState();
    const line = store.addSketchLine(0, 0, 5, 0);
    store.addSketchLine(10, -5, 10, 5);
    await getTool('extend_sketch_entity')!.execute({ entityId: line, x: 9, y: 0 });
    const e = useStore.getState().currentSketch!.entities.get(line);
    if (e?.type !== 'line') throw new Error('line missing');
    const p2 = useStore.getState().currentSketch!.entities.get(e.p2Id);
    expect(p2?.type === 'point' && p2.x).toBeCloseTo(10, 6);
  });
});

describe('measure_face_area tool', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.setState({ bodies: [createBox(10, 10, 10)] });
  });

  it('returns a single face area with centroid (box cap = 100 mm²)', async () => {
    const body = useStore.getState().bodies[0]!;
    const faceId = body.faces[0]!.id;
    const r = (await getTool('measure_face_area')!.execute({ bodyId: body.id, faceId })) as { areaMm2: number };
    expect(r.areaMm2).toBeCloseTo(100, 1);
  });

  it('omitting faceId lists every face plus the total (box = 600 mm²)', async () => {
    const body = useStore.getState().bodies[0]!;
    const r = (await getTool('measure_face_area')!.execute({ bodyId: body.id })) as { totalAreaMm2: number; faces: unknown[] };
    expect(r.faces.length).toBe(body.faces.length);
    expect(r.totalAreaMm2).toBeCloseTo(600, 0);
  });

  it('unknown face id throws a retryable error', async () => {
    const body = useStore.getState().bodies[0]!;
    await expect(getTool('measure_face_area')!.execute({ bodyId: body.id, faceId: 'face_9999' })).rejects.toThrow(/not found/);
  });
});

describe('create_hole tool', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    // 20 mm cube, top face at y = 20, volume 8000.
    const box = createBox(20, 20, 20);
    useStore.setState({ bodies: [box], directBodies: [box] });
  });

  it('drills a through hole at the top-face centroid by default', async () => {
    const r = (await getTool('create_hole')!.execute({ diameter: 8 })) as {
      success: boolean; bodyId: string; throughAll: boolean; depth: number | null; volumeRemoved: number;
    };
    expect(r.success).toBe(true);
    expect(r.throughAll).toBe(true);
    expect(r.depth).toBeNull();
    const ideal = Math.PI * 4 * 4 * 20; // πr²·20
    expect(r.volumeRemoved).toBeGreaterThanOrEqual(ideal * 0.9);
    expect(r.volumeRemoved).toBeLessThanOrEqual(ideal * 1.1);
    // The scene body was replaced by the drilled one.
    const holed = useStore.getState().bodies.find((b) => b.id === r.bodyId);
    expect(holed).toBeDefined();
    expect(Math.abs(computeVolume(holed!))).toBeLessThan(8000 - ideal * 0.9 + 1e-6);
  });

  it('drills a blind hole to the requested depth from an explicit centre', async () => {
    const r = (await getTool('create_hole')!.execute({ diameter: 8, depth: 5, x: 0, y: 20, z: 0 })) as {
      success: boolean; throughAll: boolean; depth: number | null; volumeRemoved: number;
    };
    expect(r.success).toBe(true);
    expect(r.throughAll).toBe(false);
    expect(r.depth).toBe(5);
    const ideal = Math.PI * 4 * 4 * 5; // πr²·5
    expect(r.volumeRemoved).toBeGreaterThanOrEqual(ideal * 0.9);
    expect(r.volumeRemoved).toBeLessThanOrEqual(ideal * 1.1);
    expect(Math.abs(computeVolume(useStore.getState().bodies[0]!))).toBeLessThan(8000);
  });

  it('rejects an unknown body with a retryable error', async () => {
    await expect(getTool('create_hole')!.execute({ bodyId: 'nope', diameter: 4 })).rejects.toThrow(/not found/);
  });

  it('rejects partial x/y/z centres and invalid sizes', async () => {
    await expect(getTool('create_hole')!.execute({ diameter: 8, x: 0 })).rejects.toThrow(/all of x, y and z/);
    await expect(getTool('create_hole')!.execute({ diameter: 0.05 })).rejects.toThrow(/rejected/i);
  });
});

describe('honest failure reporting (tools never claim success on a no-op)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().setCurrentSketch(null);
  });

  it('extrude without an active sketch returns success:false pointing at create_sketch', async () => {
    const r = (await getTool('extrude')!.execute({ distance: 5 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/create_sketch/);
  });

  it('extrude with a non-positive distance returns success:false', async () => {
    useStore.getState().setCurrentSketch(createSketch('xy'));
    const r = (await getTool('extrude')!.execute({ distance: 0 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/positive/i);
  });

  it('extrude succeeds on a real sketch and creates a body', async () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    const r = (await getTool('extrude')!.execute({ distance: 5 })) as { success: boolean };
    expect(r.success).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('revolve without an active sketch returns success:false', async () => {
    const r = (await getTool('revolve')!.execute({ angleDeg: 360 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/create_sketch/);
  });

  it('draw_* tools without an active sketch return success:false (not success with an empty id)', async () => {
    const cases = [
      ['draw_line', { x1: 0, y1: 0, x2: 1, y2: 1 }],
      ['draw_rectangle', { x1: 0, y1: 0, x2: 1, y2: 1 }],
      ['draw_circle', { cx: 0, cy: 0, radius: 2 }],
      ['draw_arc', { cx: 0, cy: 0, radius: 2, startAngle: 0, endAngle: 90 }],
    ] as const;
    for (const [name, args] of cases) {
      const r = (await getTool(name)!.execute({ ...args })) as { success: boolean; reason?: string; entityId?: string };
      expect(r.success, name).toBe(false);
      expect(r.reason, name).toMatch(/create_sketch/);
      expect(r.entityId, name).toBeUndefined();
    }
  });

  it('draw_polygon with a non-positive radius returns success:false', async () => {
    useStore.getState().setCurrentSketch(createSketch('xy'));
    const r = (await getTool('draw_polygon')!.execute({ cx: 0, cy: 0, radius: 0, sides: 6 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/positive/i);
  });

  it('add_constraint without an active sketch returns success:false', async () => {
    const r = (await getTool('add_constraint')!.execute({ type: 'horizontal', entityIds: ['e1'] })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/create_sketch/);
  });

  it('delete_body with an unknown id returns success:false', async () => {
    const r = (await getTool('delete_body')!.execute({ bodyId: 'missing-body' })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('fillet/chamfer/shell reject non-numeric radius/distance/thickness', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    await expect(getTool('fillet')!.execute({ bodyId: box.id, radius: 'big' })).rejects.toThrow('number');
    await expect(getTool('chamfer')!.execute({ bodyId: box.id, distance: null })).rejects.toThrow('number');
    await expect(getTool('shell')!.execute({ bodyId: box.id, thickness: 'thin' })).rejects.toThrow('number');
  });

  it('extrude on an open profile (no closed loop) returns success:false', async () => {
    const sketch = createSketch('xy');
    addLine(sketch, 0, 0, 10, 0); // a single open segment — no closed profile
    useStore.getState().setCurrentSketch(sketch);
    const r = (await getTool('extrude')!.execute({ distance: 5 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/no closed profile/i);
    expect(useStore.getState().bodies).toHaveLength(0);
  });

  it('fillet/chamfer/shell reject non-positive values and unknown edge/face ids without touching the body', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box], undoStack: [] });
    const cases = [
      ['fillet', { bodyId: box.id, radius: 0 }, /positive/i],
      ['fillet', { bodyId: box.id, radius: -1 }, /positive/i],
      ['fillet', { bodyId: box.id, radius: 1, edgeIds: ['edge-nope'] }, /edge-nope/],
      ['chamfer', { bodyId: box.id, distance: 0 }, /positive/i],
      ['chamfer', { bodyId: box.id, distance: 2, edgeIds: ['edge-nope'] }, /edge-nope/],
      ['shell', { bodyId: box.id, thickness: 0 }, /positive/i],
      ['shell', { bodyId: box.id, thickness: 1, faceIds: ['face-nope'] }, /face-nope/],
    ] as const;
    for (const [name, args, reasonRe] of cases) {
      const r = (await getTool(name)!.execute({ ...args })) as { success: boolean; reason?: string };
      expect(r.success, name).toBe(false);
      expect(r.reason, name).toMatch(reasonRe);
    }
    // Every case was a refused no-op: same body, no leaked undo entry.
    expect(useStore.getState().bodies[0]!.id).toBe(box.id);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('delete_body on a feature-tree body says to remove its feature instead', async () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    await getTool('extrude')!.execute({ distance: 5 });
    const treeBody = useStore.getState().bodies[0]!;
    const r = (await getTool('delete_body')!.execute({ bodyId: treeBody.id })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/feature tree/i);
    expect(useStore.getState().bodies).toHaveLength(1);
  });
});

describe('AI sketch offset keeps the toolbar loop semantics', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().setSketchActive(true);
    useStore.getState().setCurrentSketch(createSketch('xy'));
  });

  it('offsetting one line of a drawn rectangle offsets the whole loop (4 new lines)', async () => {
    const store = useStore.getState();
    // Hand-drawn 10×6 rectangle: fresh points per segment, junctions by
    // position (exactly what the freehand line tool produces).
    store.addSketchLine(0, 0, 10, 0);
    store.addSketchLine(10, 0, 10, 6);
    store.addSketchLine(10, 6, 0, 6);
    const base = store.addSketchLine(0, 6, 0, 0);
    const r = (await getTool('offset_sketch_entity')!.execute({ entityId: base, distance: 2 })) as { newEntityIds: string[] };
    // Loop offset (mitered frame), not a single bare parallel segment.
    expect(r.newEntityIds).toHaveLength(4);
    const sketch = useStore.getState().currentSketch!;
    for (const id of r.newEntityIds) {
      expect(sketch.entities.get(id)?.type).toBe('line');
    }
  });
});

describe('feature tree tools (list_features / update_feature)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().setCurrentSketch(null);
  });

  /** Sketch a 10×10 rectangle, extrude it `distance` mm, return the extrude feature id.
   * 'xz' = the ground plane: its extrude runs along world +Y (plane-aware
   * extrude sends an 'xy' sketch along world Z instead). */
  async function buildExtrudedBox(distance: number): Promise<string> {
    const sketch = createSketch('xz');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.getState().setCurrentSketch(sketch);
    const r = (await getTool('extrude')!.execute({ distance })) as { success: boolean };
    expect(r.success).toBe(true);
    const listed = (await getTool('list_features')!.execute({})) as { features: Array<{ id: string; type: string }> };
    const extrude = listed.features.find((f) => f.type === 'extrude');
    if (!extrude) throw new Error('extrude feature missing from list_features output');
    return extrude.id;
  }

  it('list_features returns the built tree in order with ids, types and summaries', async () => {
    await buildExtrudedBox(5);
    const r = (await getTool('list_features')!.execute({})) as {
      count: number;
      features: Array<{ id: string; type: string; name: string; suppressed: boolean; summary: string }>;
    };
    expect(r.count).toBe(2);
    expect(r.features.map((f) => f.type)).toEqual(['sketch', 'extrude']);
    expect(r.features.every((f) => typeof f.id === 'string' && f.id.length > 0)).toBe(true);
    expect(r.features.every((f) => f.suppressed === false)).toBe(true);
    expect(r.features[1]!.summary).toBe('5mm');
  });

  it('update_feature patches an extrude distance and the recomputed body follows', async () => {
    const featureId = await buildExtrudedBox(5);
    const before = useStore.getState().bodies[0]!;
    const ysBefore = before.vertices.map((v) => v.y);
    const heightBefore = Math.max(...ysBefore) - Math.min(...ysBefore);

    const r = (await getTool('update_feature')!.execute({ featureId, params: { distance: 20 } })) as {
      success: boolean;
      params: { distance: number };
      summary: string;
    };
    expect(r.success).toBe(true);
    expect(r.params.distance).toBe(20);
    expect(r.summary).toBe('20mm');

    // The feature itself kept the new value…
    const listed = (await getTool('list_features')!.execute({})) as { features: Array<{ id: string; summary: string }> };
    expect(listed.features.find((f) => f.id === featureId)!.summary).toBe('20mm');
    // …and the recomputed body grew by exactly the delta (20 − 5 = 15 mm).
    const after = useStore.getState().bodies[0]!;
    const ysAfter = after.vertices.map((v) => v.y);
    const heightAfter = Math.max(...ysAfter) - Math.min(...ysAfter);
    expect(heightAfter).toBeCloseTo(heightBefore + 15, 3);
  });

  it('update_feature with an unknown id returns success:false', async () => {
    await buildExtrudedBox(5);
    const r = (await getTool('update_feature')!.execute({ featureId: 'feat_missing', params: { distance: 2 } })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('update_feature refuses sketch features (they have no params)', async () => {
    await buildExtrudedBox(5);
    const listed = (await getTool('list_features')!.execute({})) as { features: Array<{ id: string; type: string }> };
    const sketchFeature = listed.features.find((f) => f.type === 'sketch')!;
    const r = (await getTool('update_feature')!.execute({ featureId: sketchFeature.id, params: { distance: 2 } })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/sketch/i);
  });
});

describe('arrange_on_plate undo contract', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.getState().setCurrentSketch(null);
  });

  it('arranging is ONE undoable step — undo restores the pre-arrange scene', async () => {
    const boxes = [createBox(10, 10, 10), createBox(10, 10, 10)];
    useStore.setState({ bodies: [...boxes], directBodies: [...boxes] });
    const idsBefore = useStore.getState().bodies.map((b) => b.id).sort();

    const r = (await getTool('arrange_on_plate')!.execute({ bedX: 100, bedZ: 100 })) as { count: number; fits: boolean };
    expect(r.count).toBe(2);
    expect(r.fits).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(2);

    // Ctrl+Z brings back the pre-arrange scene (same bodies) instead of being
    // wiped along with the whole history (the old clearScene behaviour).
    expect(useStore.getState().undo()).toBe(true);
    expect(useStore.getState().bodies.map((b) => b.id).sort()).toEqual(idsBefore);
  });
});

describe('create_hole counterbore/countersink variants', () => {
  // The counterbore path chains two boolean ops; with the cold voxel engine
  // the second one (on the drilled mesh) takes minutes. Warm the exact
  // Manifold engine first so the ops run in milliseconds.
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    const box = createBox(20, 20, 20);
    useStore.setState({ bodies: [box], directBodies: [box] });
  });

  it('drills a counterbored through hole that removes extra volume', async () => {
    const r = (await getTool('create_hole')!.execute({
      diameter: 4,
      counterbore: { diameter: 8, depth: 3 },
    })) as { success: boolean; volumeRemoved: number; counterbore?: { diameter: number; depth: number } };
    expect(r.success).toBe(true);
    expect(r.counterbore).toEqual({ diameter: 8, depth: 3 });
    // Plain ⌀4 through hole ≈ π·2²·20 ≈ 251 mm³; the ⌀8×3 recess must add
    // roughly π·(4²−2²)·3 ≈ 113 mm³ more.
    const plain = Math.PI * 2 * 2 * 20;
    expect(r.volumeRemoved).toBeGreaterThan(plain + 80);
  });

  it('rejects combining a counterbore with a countersink', async () => {
    await expect(getTool('create_hole')!.execute({
      diameter: 4,
      counterbore: { diameter: 8, depth: 2 },
      countersink: { diameter: 8, angleDeg: 90 },
    })).rejects.toThrow(/not both/i);
  });
});
