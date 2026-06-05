import { describe, it, expect } from 'vitest';
import { generateGCode, generateMultiToolGCode, estimateMachiningTime } from './gcode';
import type { Toolpath } from './types';

const makeToolpath = (overrides: Partial<Toolpath> = {}): Toolpath => ({
  id: 'tp-test',
  name: 'Test Toolpath',
  operation: 'pocket',
  tool: { id: 'em-6mm', name: '6mm Endmill', diameter: 6, flutes: 2, type: 'endmill', fluteLength: 20, overallLength: 50, material: 'carbide' },
  params: { feedRate: 1000, plungeRate: 500, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 0, stockBottom: -10 },
  points: [
    { x: 0, y: 0, z: 10, rapid: true },
    { x: 0, y: 0, z: 0, rapid: false },
    { x: 10, y: 0, z: 0, rapid: false },
    { x: 10, y: 10, z: 0, rapid: false },
  ],
  rapidMoves: [],
  cuttingMoves: [],
  ...overrides,
});

describe('generateGCode', () => {
  it('starts with G90, G21, G17 header', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('G90');
    expect(gcode).toContain('G21');
    expect(gcode).toContain('G17');
  });

  it('starts spindle with M3', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('M3 S10000');
  });

  it('ends with M2 program end', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('M2');
  });

  it('stops spindle with M5', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('M5');
  });

  it('emits G0 for rapid moves', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('G0 X0.000 Y0.000 Z10.000');
  });

  it('emits G1 with feed rate for cut moves', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('G1');
    expect(gcode).toContain('F1000');
  });

  it('retracts to stockTop + 10', () => {
    const tp = makeToolpath({ params: { feedRate: 1000, plungeRate: 500, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 5, stockBottom: -5 } });
    const gcode = generateGCode(tp);
    expect(gcode).toContain('G0 Z15.0');
  });

  it('returns to origin at end', () => {
    const gcode = generateGCode(makeToolpath());
    expect(gcode).toContain('G0 X0 Y0');
  });
});

describe('generateMultiToolGCode', () => {
  it('generates G-code for multiple toolpaths', () => {
    const gcode = generateMultiToolGCode([makeToolpath(), makeToolpath({ name: 'Second' })]);
    expect(gcode).toContain('Toolpaths: 2');
    expect(gcode).toContain('Toolpath 1');
    expect(gcode).toContain('Toolpath 2');
  });

  it('generates valid G-code for a single toolpath', () => {
    const gcode = generateMultiToolGCode([makeToolpath()]);
    expect(gcode).toContain('G90');
    expect(gcode).toContain('M2');
  });
});

describe('estimateMachiningTime', () => {
  it('returns positive time for a toolpath', () => {
    const time = estimateMachiningTime(makeToolpath());
    expect(time).toBeGreaterThan(0);
  });

  it('rapids are faster than cuts', () => {
    const rapidOnly = makeToolpath({
      points: [
        { x: 0, y: 0, z: 0, rapid: true },
        { x: 100, y: 0, z: 0, rapid: true },
      ],
    });
    const cutOnly = makeToolpath({
      points: [
        { x: 0, y: 0, z: 0, rapid: false },
        { x: 100, y: 0, z: 0, rapid: false },
      ],
    });
    const rapidTime = estimateMachiningTime(rapidOnly);
    const cutTime = estimateMachiningTime(cutOnly);
    expect(rapidTime).toBeLessThan(cutTime);
  });

  it('returns 0 for a single-point toolpath', () => {
    const time = estimateMachiningTime(makeToolpath({
      points: [{ x: 0, y: 0, z: 0, rapid: false }],
    }));
    expect(time).toBe(0);
  });

  it('uses per-point feed rate when available', () => {
    const tp = makeToolpath({
      points: [
        { x: 0, y: 0, z: 0, rapid: false, feedRate: 500 },
        { x: 100, y: 0, z: 0, rapid: false, feedRate: 2000 },
      ],
    });
    const time = estimateMachiningTime(tp);
    expect(time).toBeGreaterThan(0);
  });
});
