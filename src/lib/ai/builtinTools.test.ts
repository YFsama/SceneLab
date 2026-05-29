import { describe, it, expect, beforeEach } from 'vitest';
import { registerBuiltinTools } from './builtinTools';
import { getTool, getAllTools, clearTools } from './toolRegistry';
import { useStore } from '../../store/app';
import { createBox } from '../geometry';
import { createSketch, addRectangle } from '../sketch/engine';

describe('registerBuiltinTools registration', () => {
  it('registers the full tool set with no name collisions', () => {
    clearTools();
    registerBuiltinTools();
    const tools = getAllTools();
    // Guard against tools silently disappearing.
    expect(tools.length).toBeGreaterThanOrEqual(42);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // unique
    // A representative sample across every category must be present.
    for (const n of [
      // primitives
      'create_box', 'create_cylinder', 'create_sphere', 'create_cone', 'create_torus', 'create_wedge',
      // sketch/features
      'create_sketch', 'draw_line', 'draw_circle', 'extrude', 'revolve', 'fillet', 'chamfer', 'shell',
      'linear_array', 'circular_array', 'mirror',
      // transform / scene
      'move_body', 'rotate_body', 'scale_body', 'arrange_on_plate', 'delete_body', 'clear_scene',
      'describe_scene', 'measure_distance', 'list_bodies',
      // mesh io / repair
      'import_mesh', 'export_body', 'repair_mesh', 'find_holes',
      // print analysis / optimization
      'estimate_mass', 'analyze_stability', 'analyze_printability', 'check_print_readiness',
      'estimate_print_cost', 'estimate_print_job', 'recommend_orientation', 'orient_for_print',
      'scale_to_fit',
      // cam / view
      'suggest_feeds_speeds', 'set_view',
    ]) {
      expect(names).toContain(n);
    }
    clearTools();
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
      overhangs: { facesNeedingSupport: number };
      mass: { material: string; grams: number };
      buildVolume: { fits: boolean } | null;
      stability: { stable: boolean };
    };
    expect(result.mass.material).toBe('PETG');
    expect(result.buildVolume?.fits).toBe(true);
    expect(result.stability.stable).toBe(true);
    expect(typeof result.overhangs.facesNeedingSupport).toBe('number');
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
    const result = (await tool.execute({ bodyId: box.id })) as { vertices: number };
    expect(result.vertices).toBe(8);
  });

  it('export_body emits STL by default and OBJ on request', async () => {
    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] });
    const tool = getTool('export_body')!;
    const stl = (await tool.execute({})) as { format: string; content: string; bytes: number };
    expect(stl.format).toBe('stl');
    expect(stl.content).toMatch(/^solid /);
    expect(stl.bytes).toBeGreaterThan(0);

    const obj = (await tool.execute({ format: 'obj' })) as { content: string };
    expect(obj.content).toContain('v ');
    expect(obj.content).toMatch(/^f /m);
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

  it('throws a clear error when the body is missing', async () => {
    const tool = getTool('estimate_mass')!;
    await expect(tool.execute({ bodyId: 'nope' })).rejects.toThrow('not found');
  });
});
