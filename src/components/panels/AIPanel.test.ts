import { describe, it, expect } from 'vitest';
import { registerTool, getTool, getAllTools, unregisterTool, clearTools } from '../../lib/ai/toolRegistry';
import { registerBuiltinTools } from '../../lib/ai';
import type { AITool } from '../../lib/ai/types';

// Real coverage for the AI tool layer the AIPanel executes through: the
// registry contract and the builtin tool surface. Previously this file
// asserted literals about itself. AIPanel calls registerBuiltinTools() on
// mount — do the same, then snapshot the registered surface.

registerBuiltinTools();
const BUILTIN_TOOL_NAMES = getAllTools().map((t) => t.name);

function fakeTool(name: string): AITool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ ok: true }),
  };
}

describe('builtin tool surface', () => {
  it('registers a broad modeling toolset', () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(80);
    for (const expected of [
      'create_box', 'create_cylinder', 'extrude', 'revolve',
      'fillet', 'chamfer', 'shell', 'boolean_op', 'measure_face_angle',
      'import_mesh', 'export_body', 'linear_array', 'split_by_plane',
    ]) {
      expect(BUILTIN_TOOL_NAMES).toContain(expected);
    }
  });

  it('import_mesh accepts STEP content', () => {
    const tool = getTool('import_mesh')!;
    const enumProp = (tool.parameters.properties as Record<string, { enum?: string[] }>).format;
    expect(enumProp?.enum).toContain('step');
  });

  it('every builtin tool declares a JSON-schema description for the model', () => {
    for (const tool of getAllTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
    }
  });
});

describe('AI tool registry', () => {
  it('registers, retrieves and removes tools by name', () => {
    clearTools();
    registerTool(fakeTool('probe'));
    expect(getTool('probe')?.name).toBe('probe');
    expect(getAllTools()).toHaveLength(1);
    unregisterTool('probe');
    expect(getTool('probe')).toBeUndefined();
  });

  it('executing a registered tool runs its handler', async () => {
    clearTools();
    registerTool(fakeTool('runner'));
    const result = await getTool('runner')!.execute({});
    expect(result).toEqual({ ok: true });
  });
});
