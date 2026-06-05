import { describe, it, expect, beforeEach } from 'vitest';
import { getAllTools, getTool, addCustomTool, removeCustomTool } from './toolLibrary';
import type { ToolDefinition } from './types';

describe('toolLibrary', () => {
  beforeEach(() => {
    // Clean up any custom tools added in previous tests.
    const all = getAllTools();
    for (const t of all) {
      if (!['em-6mm', 'em-3mm', 'em-1mm', 'bm-6mm', 'bm-3mm', 'vbit-60deg', 'vbit-90deg', 'drill-3mm', 'drill-5mm'].includes(t.id)) {
        removeCustomTool(t.id);
      }
    }
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
});
