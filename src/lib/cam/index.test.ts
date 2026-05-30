import { describe, it, expect } from 'vitest';
import {
  getAllTools, getTool, addCustomTool, removeCustomTool,
  generatePocketToolpath, generateContourToolpath, generateDrillToolpath, generateFaceToolpath,
  generateGCode, generateMultiToolGCode, estimateMachiningTime,
} from './index';
import { createBox } from '../geometry';

const PARAMS = { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -5 };

describe('CAM toolpath generators (contour/drill/face)', () => {
  it('generateContourToolpath traces a body outline', () => {
    const tp = generateContourToolpath(createBox(20, 10, 20), getTool('em-6mm')!, PARAMS);
    expect(tp.operation).toBe('contour');
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    expect(generateGCode(tp)).toContain('G1');
  });

  it('generateDrillToolpath visits each hole', () => {
    const holes = [{ x: 0, y: 0, depth: 5 }, { x: 10, y: 5, depth: 5 }];
    const tp = generateDrillToolpath(holes, getTool('em-3mm')!, PARAMS);
    expect(tp.operation).toBe('drill');
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
  });

  it('drills hole depth measured from the stock top, not absolute Z', () => {
    const raised = { ...PARAMS, stockTop: 12, stockBottom: 2 };
    const tp = generateDrillToolpath([{ x: 0, y: 0, depth: 5 }], getTool('em-3mm')!, raised);
    // Plunge should reach stockTop - depth = 12 - 5 = 7, not -5.
    expect(tp.cuttingMoves[0]!.z).toBeCloseTo(7, 6);
  });

  it('generateFaceToolpath covers the stock top', () => {
    const tp = generateFaceToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 0, z: 20 } },
      getTool('em-6mm')!,
      PARAMS,
    );
    expect(tp.operation).toBe('face');
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
  });
});

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

  it('emits rapids and cuts interleaved in execution order, not batched', () => {
    const tool = getTool('em-6mm')!;
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
      tool,
      { feedRate: 1000, plungeRate: 300, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -5 },
    );
    // Each motion line in execution order, tagged by its G-code.
    const motion = generateGCode(tp)
      .split('\n')
      .map((l) => l.trim())
      // Toolpath moves carry full X/Y/Z; the footer retract/return moves don't.
      .filter((l) => (l.startsWith('G0 ') || l.startsWith('G1 ')) && /X.*Y.*Z/.test(l))
      .map((l) => l.slice(0, 2));
    // A real pocket plunges then cuts, so a G0 must be followed later by a G1
    // (interleaving). The buggy batched form put every G0 before any G1.
    const firstCut = motion.indexOf('G1');
    const lastRapid = motion.lastIndexOf('G0');
    expect(firstCut).toBeGreaterThan(-1);
    expect(lastRapid).toBeGreaterThan(firstCut); // a rapid occurs after the first cut
    // And the emitted order matches the toolpath's ordered points exactly.
    const fromPoints = tp.points.map((p) => (p.rapid ? 'G0' : 'G1'));
    expect(motion).toEqual(fromPoints);
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
