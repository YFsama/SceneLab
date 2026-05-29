import { describe, it, expect, beforeEach } from 'vitest';
import { registerBuiltinTools } from './builtinTools';
import { getTool, clearTools } from './toolRegistry';
import { useStore } from '../../store/app';
import { createBox } from '../geometry';

describe('builtin analysis tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.setState({ bodies: [createBox(10, 10, 10)] }); // 1 cm³
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

  it('recommend_orientation returns a best orientation and ranking', async () => {
    const tool = getTool('recommend_orientation')!;
    const result = (await tool.execute({})) as {
      best: { orientation: string; supportArea: number };
      ranked: Array<{ orientation: string }>;
    };
    expect(result.ranked).toHaveLength(6);
    expect(result.best.supportArea).toBe(0); // a box needs no support
  });

  it('throws a clear error when the body is missing', async () => {
    const tool = getTool('estimate_mass')!;
    await expect(tool.execute({ bodyId: 'nope' })).rejects.toThrow('not found');
  });
});
