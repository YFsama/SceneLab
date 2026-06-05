import { describe, it, expect, beforeEach } from 'vitest';
import { registerTool, unregisterTool, getTool, getAllTools, getToolDefinitions, clearTools } from './toolRegistry';

describe('toolRegistry', () => {
  beforeEach(() => {
    clearTools();
  });

  it('registerTool adds a tool', () => {
    registerTool({ name: 'test.tool', description: 'Test tool', parameters: {}, execute: async () => ({}) });
    expect(getTool('test.tool')).toBeDefined();
    expect(getTool('test.tool')!.description).toBe('Test tool');
  });

  it('unregisterTool removes a tool', () => {
    registerTool({ name: 'test.tool', description: 'Test tool', parameters: {}, execute: async () => ({}) });
    unregisterTool('test.tool');
    expect(getTool('test.tool')).toBeUndefined();
  });

  it('getTool returns undefined for unknown tool', () => {
    expect(getTool('unknown')).toBeUndefined();
  });

  it('getAllTools returns all registered tools', () => {
    registerTool({ name: 'a', description: 'A', parameters: {}, execute: async () => ({}) });
    registerTool({ name: 'b', description: 'B', parameters: {}, execute: async () => ({}) });
    expect(getAllTools()).toHaveLength(2);
  });

  it('getToolDefinitions returns name, description, parameters', () => {
    registerTool({ name: 'test', description: 'Test', parameters: { x: { type: 'number' } }, execute: async () => ({}) });
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('test');
    expect(defs[0]!.description).toBe('Test');
    expect(defs[0]!.parameters).toEqual({ x: { type: 'number' } });
  });

  it('clearTools removes all tools', () => {
    registerTool({ name: 'a', description: 'A', parameters: {}, execute: async () => ({}) });
    registerTool({ name: 'b', description: 'B', parameters: {}, execute: async () => ({}) });
    clearTools();
    expect(getAllTools()).toHaveLength(0);
  });

  it('registerTool with same name overwrites previous', () => {
    registerTool({ name: 'tool', description: 'V1', parameters: {}, execute: async () => ({}) });
    registerTool({ name: 'tool', description: 'V2', parameters: {}, execute: async () => ({}) });
    expect(getTool('tool')!.description).toBe('V2');
  });

  it('unregisterTool is a no-op for unknown tool', () => {
    unregisterTool('unknown');
    expect(getAllTools()).toHaveLength(0);
  });
});
