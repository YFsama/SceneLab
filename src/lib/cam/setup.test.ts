import { describe, it, expect } from 'vitest';
import { defaultCamSetup, generateOperationToolpath } from './setup';
import type { CAMOperation } from './setup';
import { createBox, createCylinder, createTube } from '../geometry/brep';
import type { ToolDefinition, CAMParameters } from './types';

const tool: ToolDefinition = {
  id: 'em-6mm', name: '6mm Endmill', diameter: 6, flutes: 2, type: 'endmill',
  fluteLength: 20, overallLength: 50, material: 'carbide',
};

const params: CAMParameters = {
  feedRate: 1000, plungeRate: 500, spindleSpeed: 10000,
  depthOfCut: 20, stepover: 3, stockTop: 20, stockBottom: 0,
};

const op = (over: Partial<CAMOperation>): CAMOperation => ({
  id: 'op-1',
  name: 'Test op',
  enabled: true,
  type: 'pocket',
  bodyId: 'body-1',
  toolId: tool.id,
  params,
  ...over,
});

describe('defaultCamSetup', () => {
  it('returns a bounding-box stock with 2 mm margin and no operations', () => {
    const setup = defaultCamSetup();
    expect(setup.stock).toEqual({ mode: 'bounding-box', margin: 2 });
    expect(setup.safeZAboveStock).toBe(5);
    expect(setup.operations).toEqual([]);
  });
});

describe('generateOperationToolpath', () => {
  it('pockets inside the body silhouette', () => {
    const tp = generateOperationToolpath(
      op({ type: 'pocket' }),
      createCylinder(15, 20, 32),
      tool,
    );
    expect(tp.operation).toBe('pocket');
    expect(tp.cuttingMoves.length).toBeGreaterThan(0);
    for (const p of tp.cuttingMoves) {
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(15 - 3 + 0.05);
    }
  });

  it('contours the body with cutter compensation', () => {
    const tp = generateOperationToolpath(
      op({ type: 'contour' }),
      createCylinder(15, 20, 32),
      tool,
    );
    expect(tp.operation).toBe('contour');
    for (const p of tp.cuttingMoves) {
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(18, 1);
    }
  });

  it('faces the stock top level by level', () => {
    const tp = generateOperationToolpath(
      op({ type: 'face', params: { ...params, depthOfCut: 5 } }),
      createBox(30, 20, 20),
      tool,
    );
    expect(tp.operation).toBe('face');
    const levels = [...new Set(tp.cuttingMoves.map((p) => p.y.toFixed(3)))];
    expect(levels).toHaveLength(4); // ceil(20/5)
  });

  it('drills op-provided holes when present', () => {
    const tp = generateOperationToolpath(
      op({ type: 'drill', holes: [{ x: 2, z: -3, depth: 12 }] }),
      createBox(30, 20, 20),
      tool,
    );
    expect(tp.operation).toBe('drill');
    expect(tp.cuttingMoves).toHaveLength(1);
    expect(tp.cuttingMoves[0]!.x).toBeCloseTo(2, 6);
    expect(tp.cuttingMoves[0]!.z).toBeCloseTo(-3, 6);
    expect(tp.cuttingMoves[0]!.y).toBeCloseTo(20 - 12, 6);
  });

  it('auto-detects circular holes when the list is empty', () => {
    const tp = generateOperationToolpath(op({ type: 'drill' }), createTube(15, 6, 20, 32), tool);
    expect(tp.cuttingMoves).toHaveLength(1);
    // The tube's ⌀12 through hole at the centre.
    expect(tp.cuttingMoves[0]!.x).toBeCloseTo(0, 6);
    expect(tp.cuttingMoves[0]!.z).toBeCloseTo(0, 6);
    expect(tp.cuttingMoves[0]!.y).toBeCloseTo(0, 6); // stockTop 20 − depth 20
  });

  it('THROWS on an undrilled body instead of guessing a centre hole (pass-29 review #8)', () => {
    // A plain box has no circular holes: the old fallback drilled one
    // unrequested full-depth hole through the middle of the part. The
    // generator must refuse — resolveCamToolpath's try/catch then drops the
    // op from the cache and the panel's stale flag surfaces it.
    expect(() => generateOperationToolpath(op({ type: 'drill' }), createBox(30, 20, 20), tool))
      .toThrowError(/no circular holes/);
    // …and the message names both remedies.
    expect(() => generateOperationToolpath(op({ type: 'drill' }), createBox(30, 20, 20), tool))
      .toThrowError(/pin holes explicitly|check the body/);
  });
});
