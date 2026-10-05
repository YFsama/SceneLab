import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAllTools,
  getTool,
  clearCustomTools,
  addCustomTool,
  removeCustomTool,
} from './toolLibrary';
import type { ToolDefinition } from './types';

describe('toolLibrary', () => {
  beforeEach(() => {
    // Clean up any custom tools added in previous tests (memory + storage).
    clearCustomTools();
    localStorage.removeItem('scenelab.customTools');
  });

  it('has 9 default tools', () => {
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(9);
  });

  it('getTool returns a tool by id', () => {
    const tool = getTool('em-6mm');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('6mm End Mill');
    expect(tool!.diameter).toBe(6);
  });

  it('getTool returns undefined for unknown id', () => {
    expect(getTool('unknown')).toBeUndefined();
  });

  it('includes endmill, ballmill, vbit, drill types', () => {
    const tools = getAllTools();
    const types = new Set(tools.map((t) => t.type));
    expect(types.has('endmill')).toBe(true);
    expect(types.has('ballmill')).toBe(true);
    expect(types.has('vbit')).toBe(true);
    expect(types.has('drill')).toBe(true);
  });

  it('addCustomTool adds a new tool', () => {
    const custom: ToolDefinition = {
      id: 'custom-1',
      name: 'Custom Tool',
      type: 'endmill',
      diameter: 8,
      fluteLength: 25,
      overallLength: 70,
      flutes: 4,
      material: 'carbide',
    };
    addCustomTool(custom);
    expect(getTool('custom-1')).toBeDefined();
    expect(getTool('custom-1')!.name).toBe('Custom Tool');
  });

  it('addCustomTool upserts by id', () => {
    const custom: ToolDefinition = {
      id: 'custom-2',
      name: 'V1',
      type: 'endmill',
      diameter: 8,
      fluteLength: 25,
      overallLength: 70,
      flutes: 4,
      material: 'carbide',
    };
    addCustomTool(custom);
    expect(getTool('custom-2')!.name).toBe('V1');
    addCustomTool({ ...custom, name: 'V2' });
    expect(getTool('custom-2')!.name).toBe('V2');
  });

  it('removeCustomTool removes a custom tool', () => {
    const custom: ToolDefinition = {
      id: 'custom-3',
      name: 'Temp',
      type: 'endmill',
      diameter: 5,
      fluteLength: 15,
      overallLength: 50,
      flutes: 2,
      material: 'carbide',
    };
    addCustomTool(custom);
    expect(getTool('custom-3')).toBeDefined();
    removeCustomTool('custom-3');
    expect(getTool('custom-3')).toBeUndefined();
  });

  it('removeCustomTool is a no-op for unknown id', () => {
    const before = getAllTools().length;
    removeCustomTool('unknown');
    expect(getAllTools().length).toBe(before);
  });

  it('all tools have required fields', () => {
    for (const tool of getAllTools()) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.type).toBeTruthy();
      expect(tool.diameter).toBeGreaterThan(0);
      expect(tool.fluteLength).toBeGreaterThan(0);
      expect(tool.overallLength).toBeGreaterThan(0);
      expect(tool.flutes).toBeGreaterThan(0);
      expect(tool.material).toBeTruthy();
    }
  });

  describe('persistence', () => {
    const custom = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
      id: 'custom-persist', name: 'Persisted 8mm', type: 'endmill',
      diameter: 8, fluteLength: 25, overallLength: 70, flutes: 4, material: 'carbide',
      ...over,
    });

    it('addCustomTool writes the list to localStorage (scenelab.customTools)', () => {
      addCustomTool(custom());
      const raw = localStorage.getItem('scenelab.customTools');
      expect(raw).toBeTruthy();
      const stored = JSON.parse(raw!) as ToolDefinition[];
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe('custom-persist');
      expect(stored[0]!.diameter).toBe(8);
    });

    it('survives a module reload — the round-trip (defensive load)', async () => {
      addCustomTool(custom({ id: 'custom-rt', name: 'Round Trip' }));
      // A fresh module instance = what a page reload sees: the boot loader
      // reads the same storage.
      vi.resetModules();
      const fresh = await import('./toolLibrary');
      expect(fresh.getTool('custom-rt')!.name).toBe('Round Trip');
      expect(fresh.getCustomTools()).toHaveLength(1);
    });

    it('removeCustomTool updates the persisted list too', () => {
      addCustomTool(custom());
      removeCustomTool('custom-persist');
      const stored = JSON.parse(localStorage.getItem('scenelab.customTools')!) as ToolDefinition[];
      expect(stored).toHaveLength(0);
    });

    it('a corrupted payload degrades to zero customs instead of crashing', async () => {
      localStorage.setItem('scenelab.customTools', '{"oops":true');
      vi.resetModules();
      const fresh = await import('./toolLibrary');
      expect(fresh.getCustomTools()).toEqual([]);
      expect(fresh.getAllTools().length).toBeGreaterThanOrEqual(9);

      // Same for shape-invalid entries: valid ones survive, garbage is dropped.
      localStorage.setItem(
        'scenelab.customTools',
        JSON.stringify([
          custom({ id: 'ok-one', name: 'OK' }),
          { id: 'bad-diameter', name: 'Bad', type: 'endmill', diameter: -3, flutes: 2, fluteLength: 5, overallLength: 40, material: 'carbide' },
          'not-even-an-object',
        ]),
      );
      vi.resetModules();
      const fresh2 = await import('./toolLibrary');
      expect(fresh2.getCustomTools().map((t) => t.id)).toEqual(['ok-one']);
    });
  });
});
