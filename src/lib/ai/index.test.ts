import { describe, it, expect } from 'vitest';
import {
  registerTool, unregisterTool, getTool, getAllTools, getToolDefinitions, clearTools,
  isString, isNumber, isBoolean, isVec3, isStringArray,
  assertString, assertNumber, assertBoolean, assertEnum, assertVec3, assertStringArray,
} from './index';

describe('AI module exports', () => {
  it('should export registerTool', () => {
    expect(typeof registerTool).toBe('function');
  });

  it('should export unregisterTool', () => {
    expect(typeof unregisterTool).toBe('function');
  });

  it('should export getTool', () => {
    expect(typeof getTool).toBe('function');
  });

  it('should export getAllTools', () => {
    expect(typeof getAllTools).toBe('function');
  });

  it('should export getToolDefinitions', () => {
    expect(typeof getToolDefinitions).toBe('function');
  });

  it('should export clearTools', () => {
    expect(typeof clearTools).toBe('function');
  });

  it('should export type guards', () => {
    expect(typeof isString).toBe('function');
    expect(typeof isNumber).toBe('function');
    expect(typeof isBoolean).toBe('function');
    expect(typeof isVec3).toBe('function');
    expect(typeof isStringArray).toBe('function');
  });

  it('should export assert functions', () => {
    expect(typeof assertString).toBe('function');
    expect(typeof assertNumber).toBe('function');
    expect(typeof assertBoolean).toBe('function');
    expect(typeof assertEnum).toBe('function');
    expect(typeof assertVec3).toBe('function');
    expect(typeof assertStringArray).toBe('function');
  });

  it('should register and retrieve a tool', () => {
    clearTools();
    registerTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      execute: async () => 'result',
    });

    const tool = getTool('test_tool');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('test_tool');

    clearTools();
  });

  it('should get all tools', () => {
    clearTools();
    registerTool({ name: 'a', description: '', parameters: {}, execute: async () => {} });
    registerTool({ name: 'b', description: '', parameters: {}, execute: async () => {} });

    expect(getAllTools().length).toBe(2);
    clearTools();
  });

  it('should get tool definitions', () => {
    clearTools();
    registerTool({ name: 'test', description: 'desc', parameters: { type: 'object' }, execute: async () => {} });

    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0]?.name).toBe('test');
    expect(defs[0]?.description).toBe('desc');

    clearTools();
  });
});
