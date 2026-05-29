import { describe, it, expect } from 'vitest';
import {
  getAllTools, getTool, addCustomTool, removeCustomTool,
  generatePocketToolpath, generateContourToolpath, generateDrillToolpath, generateFaceToolpath,
  generateGCode, generateMultiToolGCode, estimateMachiningTime,
} from './index';

describe('CAM module exports', () => {
  it('should export tool library functions', () => {
    expect(typeof getAllTools).toBe('function');
    expect(typeof getTool).toBe('function');
    expect(typeof addCustomTool).toBe('function');
    expect(typeof removeCustomTool).toBe('function');
  });

  it('should export toolpath generators', () => {
    expect(typeof generatePocketToolpath).toBe('function');
    expect(typeof generateContourToolpath).toBe('function');
    expect(typeof generateDrillToolpath).toBe('function');
    expect(typeof generateFaceToolpath).toBe('function');
  });

  it('should export G-code functions', () => {
    expect(typeof generateGCode).toBe('function');
    expect(typeof generateMultiToolGCode).toBe('function');
    expect(typeof estimateMachiningTime).toBe('function');
  });

  it('should get default tools', () => {
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]?.name).toBeDefined();
    expect(tools[0]?.diameter).toBeGreaterThan(0);
  });

  it('should get tool by id', () => {
    const tool = getTool('em-6mm');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('6mm End Mill');
    expect(tool?.diameter).toBe(6);
  });

  it('should return undefined for unknown tool', () => {
    const tool = getTool('nonexistent');
    expect(tool).toBeUndefined();
  });

  it('should generate pocket toolpath', () => {
    const tool = getTool('em-6mm')!;
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 0 } },
      tool,
      { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -10 },
    );
    expect(tp.name).toContain('Pocket');
    expect(tp.operation).toBe('pocket');
  });

  it('should generate G-code', () => {
    const tool = getTool('em-6mm')!;
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
      tool,
      { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -5 },
    );
    const gcode = generateGCode(tp);
    expect(gcode).toContain('G90');
    expect(gcode).toContain('G21');
    expect(gcode).toContain('M3');
    expect(gcode).toContain('M5');
    expect(gcode).toContain('M2');
  });

  it('should estimate machining time', () => {
    const tool = getTool('em-6mm')!;
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
      tool,
      { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -5 },
    );
    const time = estimateMachiningTime(tp);
    expect(time).toBeGreaterThan(0);
  });

  it('estimateMachiningTime stays finite when the feed rate is zero', () => {
    const tool = getTool('em-6mm')!;
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
      tool,
      { feedRate: 0, plungeRate: 0, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -5 },
    );
    const time = estimateMachiningTime(tp);
    expect(Number.isFinite(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(0);
  });
});
