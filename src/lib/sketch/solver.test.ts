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

  it('converges with combined horizontal + distance constraints', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('h', { id: 'h', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('d', { id: 'd', type: 'distance', entityIds: ['p1', 'p2'], value: 20 });

    const result = solveConstraints(entities, constraints, 200);
    const a = result.get('p1')!;
    const b = result.get('p2')!;
    // Both satisfied: same Y, and the points are ~20 apart.
    expect(b.y).toBeCloseTo(a.y, 1);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(20, 0);
  });

  it('should equalize two circle radii with an equal constraint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('pc1', { id: 'pc1', type: 'point', x: 0, y: 0 });
    entities.set('pc2', { id: 'pc2', type: 'point', x: 20, y: 0 });
    entities.set('c1', { id: 'c1', type: 'circle', centerId: 'pc1', radius: 5 });
    entities.set('c2', { id: 'c2', type: 'circle', centerId: 'pc2', radius: 9 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c', { id: 'c', type: 'equal', entityIds: ['c1', 'c2'] });

    solveConstraints(entities, constraints);

    const r1 = (entities.get('c1') as { radius: number }).radius;
    const r2 = (entities.get('c2') as { radius: number }).radius;
    expect(r1).toBeCloseTo(r2, 5);
    expect(r1).toBeCloseTo(7, 5); // average of 5 and 9
  });

  it('should apply parallel constraint between two lines', () => {
    const entities = new Map<string, SketchEntity>();
    // line1 horizontal; line2 starts skewed.
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 5 });
    entities.set('p4', { id: 'p4', type: 'point', x: 10, y: 8 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('line2', { id: 'line2', type: 'line', p1Id: 'p3', p2Id: 'p4' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'parallel', entityIds: ['line1', 'line2'] });

    const result = solveConstraints(entities, constraints);

    // Parallel → the 2D cross product of the two direction vectors is ~0.
    const d1x = (result.get('p2')!.x) - (result.get('p1')!.x);
    const d1y = (result.get('p2')!.y) - (result.get('p1')!.y);
    const d2x = (result.get('p4')!.x) - (result.get('p3')!.x);
    const d2y = (result.get('p4')!.y) - (result.get('p3')!.y);
    expect(d1x * d2y - d1y * d2x).toBeCloseTo(0, 3);
  });

  it('should apply perpendicular constraint between two lines', () => {
    const entities = new Map<string, SketchEntity>();
    // line1 horizontal; line2 starts at ~45°, should be driven to vertical.
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 4, y: 0 });
    entities.set('p4', { id: 'p4', type: 'point', x: 10, y: 6 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('line2', { id: 'line2', type: 'line', p1Id: 'p3', p2Id: 'p4' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'perpendicular', entityIds: ['line1', 'line2'] });

    const result = solveConstraints(entities, constraints, 200);

    // Perpendicular → the dot product of the two direction vectors is ~0.
    const d1x = result.get('p2')!.x - result.get('p1')!.x;
    const d1y = result.get('p2')!.y - result.get('p1')!.y;
    const d2x = result.get('p4')!.x - result.get('p3')!.x;
    const d2y = result.get('p4')!.y - result.get('p3')!.y;
    expect(d1x * d2x + d1y * d2y).toBeCloseTo(0, 3);
  });

  it('equal-length with a fixed endpoint keeps the anchor and matches lengths', () => {
    const entities = new Map<string, SketchEntity>();
    // line1: p1(fixed origin)→p2(x=4) length 4. line2: p3(0,0)→p4(0,10) length 10.
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 4, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 0 });
    entities.set('p4', { id: 'p4', type: 'point', x: 0, y: 10 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('l2', { id: 'l2', type: 'line', p1Id: 'p3', p2Id: 'p4' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('fix', { id: 'fix', type: 'fixed', entityIds: ['p1'] });
    constraints.set('eq', { id: 'eq', type: 'equal', entityIds: ['l1', 'l2'] });

    const result = solveConstraints(entities, constraints, 300);

    const p1 = result.get('p1')!;
    const len1 = Math.hypot(result.get('p2')!.x - p1.x, result.get('p2')!.y - p1.y);
    const len2 = Math.hypot(result.get('p4')!.x - result.get('p3')!.x, result.get('p4')!.y - result.get('p3')!.y);
    // p1 must remain anchored at the origin.
    expect(p1.x).toBeCloseTo(0, 6);
    expect(p1.y).toBeCloseTo(0, 6);
    // Both lines converge to equal length.
    expect(len1).toBeCloseTo(len2, 3);
  });

  it('a fixed point stays put while a distance constraint moves the other', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 6, y: 0 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('fix', { id: 'fix', type: 'fixed', entityIds: ['p1'] });
    constraints.set('d', { id: 'd', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });

    const result = solveConstraints(entities, constraints, 200);

    const a = result.get('p1')!;
    const b = result.get('p2')!;
    // p1 is anchored at the origin.
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(0, 6);
    // p2 absorbs the whole correction → distance is exactly 10 (p2 at x=10).
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(10, 4);
    expect(b.x).toBeCloseTo(10, 4);
  });

  it('should apply coincident constraint between two points', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 4, y: 6 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'coincident', entityIds: ['p1', 'p2'] });

    const result = solveConstraints(entities, constraints);

    const a = result.get('p1')!;
    const b = result.get('p2')!;
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    // Both free → they meet at the midpoint (2, 3).
    expect(a.x).toBeCloseTo(2, 6);
    expect(a.y).toBeCloseTo(3, 6);
  });
});
