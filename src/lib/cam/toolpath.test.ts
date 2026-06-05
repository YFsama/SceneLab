import { describe, it, expect } from 'vitest';
import { generatePocketToolpath, generateContourToolpath, generateDrillToolpath, generateFaceToolpath } from './toolpath';
import { createBox } from '../geometry/brep';
import type { ToolDefinition, CAMParameters } from './types';

const tool: ToolDefinition = {
  id: 'em-6mm',
  name: '6mm Endmill',
  diameter: 6,
  flutes: 2,
  type: 'endmill',
};

const params: CAMParameters = {
  feedRate: 1000,
  spindleSpeed: 10000,
  stockTop: 0,
  stockBottom: -10,
  stepDown: 2,
  stepover: 3,
};

describe('generatePocketToolpath', () => {
  it('generates a toolpath with points', () => {
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: -10 }, max: { x: 50, y: 30, z: 0 } },
      tool,
      params,
    );
    expect(tp.points.length).toBeGreaterThan(0);
    expect(tp.name).toContain('Pocket');
    expect(tp.operation).toBe('pocket');
  });

  it('has both rapid and cutting moves', () => {
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: -10 }, max: { x: 50, y: 30, z: 0 } },
      tool,
      params,
    );
    const rapids = tp.points.filter((p) => p.rapid);
    const cuts = tp.points.filter((p) => !p.rapid);
    expect(rapids.length).toBeGreaterThan(0);
    expect(cuts.length).toBeGreaterThan(0);
  });

  it('starts with a rapid to safe Z', () => {
    const tp = generatePocketToolpath(
      { min: { x: 0, y: 0, z: -10 }, max: { x: 50, y: 30, z: 0 } },
      tool,
      params,
    );
    expect(tp.points[0]!.rapid).toBe(true);
    expect(tp.points[0]!.z).toBeGreaterThan(params.stockTop);
  });
});

describe('generateContourToolpath', () => {
  it('generates a toolpath for a box body', () => {
    const box = createBox(50, 10, 30);
    const tp = generateContourToolpath(box, tool, params);
    expect(tp.points.length).toBeGreaterThan(0);
    expect(tp.operation).toBe('contour');
  });

  it('has cutting moves along the contour', () => {
    const box = createBox(50, 10, 30);
    const tp = generateContourToolpath(box, tool, params);
    const cuts = tp.points.filter((p) => !p.rapid);
    expect(cuts.length).toBeGreaterThan(0);
  });
});

describe('generateDrillToolpath', () => {
  it('generates a drill cycle for holes', () => {
    const tp = generateDrillToolpath(
      [{ x: 10, y: 20, depth: 15 }, { x: 30, y: 20, depth: 15 }],
      tool,
      params,
    );
    expect(tp.points.length).toBeGreaterThan(0);
    expect(tp.operation).toBe('drill');
  });

  it('plunges to correct depth (stockTop - depth)', () => {
    const tp = generateDrillToolpath(
      [{ x: 10, y: 20, depth: 15 }],
      tool,
      params,
    );
    // stockTop (0) - depth (15) = -15
    const minZ = Math.min(...tp.points.map((p) => p.z));
    expect(minZ).toBeCloseTo(-15, 1);
  });
});

describe('generateFaceToolpath', () => {
  it('generates a facing toolpath', () => {
    const tp = generateFaceToolpath(
      { min: { x: 0, y: 0, z: -5 }, max: { x: 50, y: 30, z: 0 } },
      tool,
      params,
    );
    expect(tp.points.length).toBeGreaterThan(0);
    expect(tp.operation).toBe('face');
  });

  it('covers the full area with zigzag passes', () => {
    const tp = generateFaceToolpath(
      { min: { x: 0, y: 0, z: -5 }, max: { x: 50, y: 30, z: 0 } },
      tool,
      params,
    );
    const cuts = tp.points.filter((p) => !p.rapid);
    expect(cuts.length).toBeGreaterThan(10);
  });
});
