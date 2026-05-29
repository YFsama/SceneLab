import { describe, it, expect } from 'vitest';
import { solveConstraints } from './solver';
import type { SketchEntity, SketchConstraint } from './types';

describe('solveConstraints', () => {
  it('should return points unchanged with no constraints', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    const result = solveConstraints(entities, constraints);

    expect(result.get('p1')?.x).toBeCloseTo(0);
    expect(result.get('p1')?.y).toBeCloseTo(0);
    expect(result.get('p2')?.x).toBeCloseTo(10);
    expect(result.get('p2')?.y).toBeCloseTo(0);
  });

  it('should apply horizontal constraint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });

    const result = solveConstraints(entities, constraints);

    // Both points should have same Y
    expect(result.get('p1')?.y).toBeCloseTo(result.get('p2')?.y ?? 0);
  });

  it('should apply vertical constraint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 10 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'vertical', entityIds: ['line1'] });

    const result = solveConstraints(entities, constraints);

    // Both points should have same X
    expect(result.get('p1')?.x).toBeCloseTo(result.get('p2')?.x ?? 0);
  });

  it('should apply distance constraint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 0 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });

    const result = solveConstraints(entities, constraints);

    const dx = (result.get('p2')?.x ?? 0) - (result.get('p1')?.x ?? 0);
    const dy = (result.get('p2')?.y ?? 0) - (result.get('p1')?.y ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy);
    expect(dist).toBeCloseTo(10, 0);
  });

  it('should apply equal constraint between two lines', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 5 });
    entities.set('p4', { id: 'p4', type: 'point', x: 3, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('line2', { id: 'line2', type: 'line', p1Id: 'p3', p2Id: 'p4' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'equal', entityIds: ['line1', 'line2'] });

    const result = solveConstraints(entities, constraints);

    // Both lines should have same length
    const len1 = Math.sqrt(
      ((result.get('p2')?.x ?? 0) - (result.get('p1')?.x ?? 0)) ** 2 +
      ((result.get('p2')?.y ?? 0) - (result.get('p1')?.y ?? 0)) ** 2,
    );
    const len2 = Math.sqrt(
      ((result.get('p4')?.x ?? 0) - (result.get('p3')?.x ?? 0)) ** 2 +
      ((result.get('p4')?.y ?? 0) - (result.get('p3')?.y ?? 0)) ** 2,
    );
    expect(len1).toBeCloseTo(len2, 0);
  });
});
