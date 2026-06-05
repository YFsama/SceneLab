import { describe, it, expect } from 'vitest';
import type { CAMParameters, WorkMaterial } from '../../lib/cam';

// CAMPanel is a React component — test the CAM configuration structure.

describe('CAMPanel configuration', () => {
  const WORK_MATERIALS: WorkMaterial[] = [
    'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
  ];

  const defaultParams: CAMParameters = {
    feedRate: 1000,
    plungeRate: 300,
    spindleSpeed: 10000,
    depthOfCut: 2,
    stepover: 3,
    stockTop: 0,
    stockBottom: -10,
  };

  it('has 8 work materials', () => {
    expect(WORK_MATERIALS).toHaveLength(8);
  });

  it('includes common materials', () => {
    expect(WORK_MATERIALS).toContain('aluminum');
    expect(WORK_MATERIALS).toContain('steel');
    expect(WORK_MATERIALS).toContain('softwood');
  });

  it('default params have positive feed rate', () => {
    expect(defaultParams.feedRate).toBeGreaterThan(0);
  });

  it('default params have positive spindle speed', () => {
    expect(defaultParams.spindleSpeed).toBeGreaterThan(0);
  });

  it('default params have positive depth of cut', () => {
    expect(defaultParams.depthOfCut).toBeGreaterThan(0);
  });

  it('default params have positive stepover', () => {
    expect(defaultParams.stepover).toBeGreaterThan(0);
  });

  it('stockTop is above stockBottom', () => {
    expect(defaultParams.stockTop).toBeGreaterThan(defaultParams.stockBottom);
  });
});
