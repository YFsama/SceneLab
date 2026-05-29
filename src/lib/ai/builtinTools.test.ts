import { describe, it, expect, beforeEach } from 'vitest';
import { registerBuiltinTools } from './builtinTools';
import { getTool, clearTools } from './toolRegistry';
import { useStore } from '../../store/app';
import { createBox } from '../geometry';

describe('builtin analysis tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.setState({ bodies: [createBox(10, 10, 10)], directBodies: [] }); // 1 cm³
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

  it('repair_mesh welds and replaces a direct body', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const tool = getTool('repair_mesh')!;
    const result = (await tool.execute({ bodyId: box.id })) as { vertices: number };
    expect(result.vertices).toBe(8);
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

  it('throws a clear error when the body is missing', async () => {
    const tool = getTool('estimate_mass')!;
    await expect(tool.execute({ bodyId: 'nope' })).rejects.toThrow('not found');
  });
});
