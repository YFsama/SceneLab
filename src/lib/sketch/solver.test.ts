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

  it('horizontal aligns to the fixed endpoint, not the average', () => {
    const entities = new Map<string, SketchEntity>();
    // p1 fixed at y=3; p2 free at y=9. Horizontal must bring p2 to y=3, not 6.
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 3 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 9 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('fix', { id: 'fix', type: 'fixed', entityIds: ['p1'] });
    constraints.set('h', { id: 'h', type: 'horizontal', entityIds: ['l1'] });

    const result = solveConstraints(entities, constraints);
    expect(result.get('p1')!.y).toBeCloseTo(3, 6);
    expect(result.get('p2')!.y).toBeCloseTo(3, 6); // snapped to the datum, not 6
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

  it('should set a circle radius via the radius constraint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c', { id: 'c', type: 'circle', centerId: 'cc', radius: 4 });
    entities.set('cc', { id: 'cc', type: 'point', x: 0, y: 0 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('r', { id: 'r', type: 'radius', entityIds: ['c'], value: 9 });

    solveConstraints(entities, constraints);
    const circle = entities.get('c')!;
    expect(circle.type === 'circle' && circle.radius).toBe(9);
  });

  it('converges a skewed quad to a rectangle under combined h/v constraints', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 1 });
    entities.set('p3', { id: 'p3', type: 'point', x: 11, y: 8 });
    entities.set('p4', { id: 'p4', type: 'point', x: 1, y: 7 });
    entities.set('bottom', { id: 'bottom', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('right', { id: 'right', type: 'line', p1Id: 'p2', p2Id: 'p3' });
    entities.set('top', { id: 'top', type: 'line', p1Id: 'p3', p2Id: 'p4' });
    entities.set('left', { id: 'left', type: 'line', p1Id: 'p4', p2Id: 'p1' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('h1', { id: 'h1', type: 'horizontal', entityIds: ['bottom'] });
    constraints.set('h2', { id: 'h2', type: 'horizontal', entityIds: ['top'] });
    constraints.set('v1', { id: 'v1', type: 'vertical', entityIds: ['left'] });
    constraints.set('v2', { id: 'v2', type: 'vertical', entityIds: ['right'] });

    const r = solveConstraints(entities, constraints, 200);
    const p = (id: string) => r.get(id)!;
    expect(p('p1').y).toBeCloseTo(p('p2').y, 4); // bottom horizontal
    expect(p('p3').y).toBeCloseTo(p('p4').y, 4); // top horizontal
    expect(p('p1').x).toBeCloseTo(p('p4').x, 4); // left vertical
    expect(p('p2').x).toBeCloseTo(p('p3').x, 4); // right vertical
  });

  it('should make two circles concentric (shared center)', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'circle', centerId: 'p1', radius: 5 });
    entities.set('c2', { id: 'c2', type: 'circle', centerId: 'p2', radius: 8 });
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 4 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('cc', { id: 'cc', type: 'concentric', entityIds: ['c1', 'c2'] });

    const result = solveConstraints(entities, constraints);
    const a = result.get('p1')!;
    const b = result.get('p2')!;
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.x).toBeCloseTo(5, 6); // midpoint of the two centers
    expect(a.y).toBeCloseTo(2, 6);
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

describe('multiple constraints on same entity', () => {
  it('horizontal + vertical on the same line makes it a point', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('c2', { id: 'c2', type: 'vertical', entityIds: ['line1'] });

    const result = solveConstraints(entities, constraints);
    // Both constraints force the line to be a single point.
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });

  it('distance + horizontal on a line', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('c2', { id: 'c2', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });

    const result = solveConstraints(entities, constraints);
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    // Horizontal: same Y.
    expect(p1.y).toBeCloseTo(p2.y, 4);
    // Distance: 10 units apart.
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    expect(dist).toBeCloseTo(10, 2);
  });

  it('fixed + distance: fixed point stays, other moves', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 0 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'fixed', entityIds: ['p1'] });
    constraints.set('c2', { id: 'c2', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });

    const result = solveConstraints(entities, constraints);
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    // p1 is fixed at (0,0).
    expect(p1.x).toBeCloseTo(0, 6);
    expect(p1.y).toBeCloseTo(0, 6);
    // p2 moves to distance 10.
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeCloseTo(10, 2);
  });

  it('parallel + equal length on two lines', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 5 });
    entities.set('p4', { id: 'p4', type: 'point', x: 8, y: 7 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('l2', { id: 'l2', type: 'line', p1Id: 'p3', p2Id: 'p4' });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'parallel', entityIds: ['l1', 'l2'] });
    constraints.set('c2', { id: 'c2', type: 'equal', entityIds: ['l1', 'l2'] });

    const result = solveConstraints(entities, constraints);
    // Both lines should have similar length after equal constraint.
    const d1 = Math.hypot(
      (result.get('p2')!.x - result.get('p1')!.x),
      (result.get('p2')!.y - result.get('p1')!.y),
    );
    const d2 = Math.hypot(
      (result.get('p4')!.x - result.get('p3')!.x),
      (result.get('p4')!.y - result.get('p3')!.y),
    );
    expect(d1).toBeCloseTo(d2, 2);
  });

  it('radius constraint on an arc', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('center', { id: 'center', type: 'point', x: 0, y: 0 });
    entities.set('arc1', { id: 'arc1', type: 'arc', centerId: 'center', radius: 5, startAngle: 0, endAngle: Math.PI });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'radius', entityIds: ['arc1'], value: 10 });

    solveConstraints(entities, constraints);
    // Arc radius should be updated to 10.
    const arc = entities.get('arc1') as { radius: number };
    expect(arc.radius).toBeCloseTo(10, 4);
  });

  it('concentric constraint moves circle center', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'point', x: 0, y: 0 });
    entities.set('c2', { id: 'c2', type: 'point', x: 10, y: 5 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c1', radius: 3 });
    entities.set('circle2', { id: 'circle2', type: 'circle', centerId: 'c2', radius: 5 });

    const constraints = new Map<string, SketchConstraint>();
    constraints.set('cstr', { id: 'cstr', type: 'concentric', entityIds: ['circle1', 'circle2'] });

    const result = solveConstraints(entities, constraints);
    // Both centers should converge.
    const p1 = result.get('c1')!;
    const p2 = result.get('c2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });

  it('no constraints leaves points unchanged', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 5, y: 10 });
    entities.set('p2', { id: 'p2', type: 'point', x: 20, y: 30 });
    const constraints = new Map<string, SketchConstraint>();
    const result = solveConstraints(entities, constraints);
    expect(result.get('p1')!.x).toBeCloseTo(5, 6);
    expect(result.get('p1')!.y).toBeCloseTo(10, 6);
    expect(result.get('p2')!.x).toBeCloseTo(20, 6);
    expect(result.get('p2')!.y).toBeCloseTo(30, 6);
  });

  it('fixed point stays fixed even with other constraints', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'fixed', entityIds: ['p1'] });
    constraints.set('c2', { id: 'c2', type: 'horizontal', entityIds: ['line1'] });
    const result = solveConstraints(entities, constraints);
    // p1 is fixed at (0,0).
    expect(result.get('p1')!.x).toBeCloseTo(0, 6);
    expect(result.get('p1')!.y).toBeCloseTo(0, 6);
    // p2 should move to same Y as p1 (horizontal constraint).
    expect(result.get('p2')!.y).toBeCloseTo(0, 4);
  });

  it('equal constraint makes two lines the same length', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 5 });
    entities.set('p4', { id: 'p4', type: 'point', x: 3, y: 5 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('l2', { id: 'l2', type: 'line', p1Id: 'p3', p2Id: 'p4' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c', { id: 'c', type: 'equal', entityIds: ['l1', 'l2'] });
    const result = solveConstraints(entities, constraints);
    const d1 = Math.hypot(result.get('p2')!.x - result.get('p1')!.x, result.get('p2')!.y - result.get('p1')!.y);
    const d2 = Math.hypot(result.get('p4')!.x - result.get('p3')!.x, result.get('p4')!.y - result.get('p3')!.y);
    expect(d1).toBeCloseTo(d2, 2);
  });

  it('perpendicular constraint makes two lines 90°', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 0 });
    entities.set('p4', { id: 'p4', type: 'point', x: 5, y: 5 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('l2', { id: 'l2', type: 'line', p1Id: 'p3', p2Id: 'p4' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c', { id: 'c', type: 'perpendicular', entityIds: ['l1', 'l2'] });
    const result = solveConstraints(entities, constraints);
    const d1 = { x: result.get('p2')!.x - result.get('p1')!.x, y: result.get('p2')!.y - result.get('p1')!.y };
    const d2 = { x: result.get('p4')!.x - result.get('p3')!.x, y: result.get('p4')!.y - result.get('p3')!.y };
    const dot = d1.x * d2.x + d1.y * d2.y;
    expect(Math.abs(dot)).toBeLessThan(1); // approximately perpendicular
  });

  it('distance constraint with fixed endpoint', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 0 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'fixed', entityIds: ['p1'] });
    constraints.set('c2', { id: 'c2', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });
    const result = solveConstraints(entities, constraints);
    expect(result.get('p1')!.x).toBeCloseTo(0, 6);
    expect(result.get('p1')!.y).toBeCloseTo(0, 6);
    const dist = Math.hypot(result.get('p2')!.x - result.get('p1')!.x, result.get('p2')!.y - result.get('p1')!.y);
    expect(dist).toBeCloseTo(10, 2);
  });

  it('horizontal + vertical on a line collapses to a point', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('c2', { id: 'c2', type: 'vertical', entityIds: ['line1'] });
    const result = solveConstraints(entities, constraints);
    // Both constraints force the line to be a single point.
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });

  it('radius constraint updates circle radius', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('center', { id: 'center', type: 'point', x: 0, y: 0 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'center', radius: 5 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'radius', entityIds: ['circle1'], value: 10 });
    solveConstraints(entities, constraints);
    expect((entities.get('circle1') as { radius: number }).radius).toBeCloseTo(10, 4);
  });

  it('concentric constraint merges circle centers', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'point', x: 0, y: 0 });
    entities.set('c2', { id: 'c2', type: 'point', x: 10, y: 5 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c1', radius: 3 });
    entities.set('circle2', { id: 'circle2', type: 'circle', centerId: 'c2', radius: 5 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('cstr', { id: 'cstr', type: 'concentric', entityIds: ['circle1', 'circle2'] });
    const result = solveConstraints(entities, constraints);
    const p1 = result.get('c1')!;
    const p2 = result.get('c2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });

  it('equal constraint on two circles equalizes radii', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'point', x: 0, y: 0 });
    entities.set('c2', { id: 'c2', type: 'point', x: 10, y: 0 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c1', radius: 3 });
    entities.set('circle2', { id: 'circle2', type: 'circle', centerId: 'c2', radius: 7 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c', { id: 'c', type: 'equal', entityIds: ['circle1', 'circle2'] });
    solveConstraints(entities, constraints);
    const r1 = (entities.get('circle1') as { radius: number }).radius;
    const r2 = (entities.get('circle2') as { radius: number }).radius;
    expect(r1).toBeCloseTo(r2, 4);
  });

  it('horizontal + distance constrains line to exact length', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('c2', { id: 'c2', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });
    const result = solveConstraints(entities, constraints);
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    // Horizontal: same Y.
    expect(p1.y).toBeCloseTo(p2.y, 4);
    // Distance: 10 units apart.
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    expect(dist).toBeCloseTo(10, 2);
  });

  it('fixed point stays fixed with vertical constraint on line', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'fixed', entityIds: ['p1'] });
    constraints.set('c2', { id: 'c2', type: 'vertical', entityIds: ['line1'] });
    const result = solveConstraints(entities, constraints);
    expect(result.get('p1')!.x).toBeCloseTo(0, 6);
    expect(result.get('p1')!.y).toBeCloseTo(0, 6);
    // p2 should move to same X as p1 (vertical constraint).
    expect(result.get('p2')!.x).toBeCloseTo(0, 4);
  });

  it('radius constraint on a circle updates the radius', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c', { id: 'c', type: 'point', x: 0, y: 0 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c', radius: 3 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('cr', { id: 'cr', type: 'radius', entityIds: ['circle1'], value: 7 });
    solveConstraints(entities, constraints);
    expect((entities.get('circle1') as { radius: number }).radius).toBeCloseTo(7, 4);
  });

  it('concentric constraint merges circle centers', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'point', x: 0, y: 0 });
    entities.set('c2', { id: 'c2', type: 'point', x: 10, y: 5 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c1', radius: 3 });
    entities.set('circle2', { id: 'circle2', type: 'circle', centerId: 'c2', radius: 5 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('cc', { id: 'cc', type: 'concentric', entityIds: ['circle1', 'circle2'] });
    const result = solveConstraints(entities, constraints);
    const p1 = result.get('c1')!;
    const p2 = result.get('c2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });

  it('equal constraint on two circles equalizes radii', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('c1', { id: 'c1', type: 'point', x: 0, y: 0 });
    entities.set('c2', { id: 'c2', type: 'point', x: 10, y: 0 });
    entities.set('circle1', { id: 'circle1', type: 'circle', centerId: 'c1', radius: 3 });
    entities.set('circle2', { id: 'circle2', type: 'circle', centerId: 'c2', radius: 7 });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('eq', { id: 'eq', type: 'equal', entityIds: ['circle1', 'circle2'] });
    solveConstraints(entities, constraints);
    const r1 = (entities.get('circle1') as { radius: number }).radius;
    const r2 = (entities.get('circle2') as { radius: number }).radius;
    expect(r1).toBeCloseTo(r2, 4);
  });

  it('fixed + equal: fixed point stays, other moves to match length', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 10, y: 0 });
    entities.set('p3', { id: 'p3', type: 'point', x: 0, y: 5 });
    entities.set('p4', { id: 'p4', type: 'point', x: 3, y: 5 });
    entities.set('l1', { id: 'l1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    entities.set('l2', { id: 'l2', type: 'line', p1Id: 'p3', p2Id: 'p4' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'fixed', entityIds: ['p1'] });
    constraints.set('c2', { id: 'c2', type: 'equal', entityIds: ['l1', 'l2'] });
    const result = solveConstraints(entities, constraints);
    // p1 stays fixed at (0,0).
    expect(result.get('p1')!.x).toBeCloseTo(0, 6);
    expect(result.get('p1')!.y).toBeCloseTo(0, 6);
    // Both lines should have similar length.
    const d1 = Math.hypot(result.get('p2')!.x - result.get('p1')!.x, result.get('p2')!.y - result.get('p1')!.y);
    const d2 = Math.hypot(result.get('p4')!.x - result.get('p3')!.x, result.get('p4')!.y - result.get('p3')!.y);
    expect(d1).toBeCloseTo(d2, 2);
  });

  it('horizontal + vertical + distance on a line', () => {
    const entities = new Map<string, SketchEntity>();
    entities.set('p1', { id: 'p1', type: 'point', x: 0, y: 0 });
    entities.set('p2', { id: 'p2', type: 'point', x: 5, y: 5 });
    entities.set('line1', { id: 'line1', type: 'line', p1Id: 'p1', p2Id: 'p2' });
    const constraints = new Map<string, SketchConstraint>();
    constraints.set('c1', { id: 'c1', type: 'horizontal', entityIds: ['line1'] });
    constraints.set('c2', { id: 'c2', type: 'vertical', entityIds: ['line1'] });
    constraints.set('c3', { id: 'c3', type: 'distance', entityIds: ['p1', 'p2'], value: 10 });
    const result = solveConstraints(entities, constraints);
    // Horizontal + vertical collapses to a point; distance is irrelevant.
    const p1 = result.get('p1')!;
    const p2 = result.get('p2')!;
    expect(p1.x).toBeCloseTo(p2.x, 4);
    expect(p1.y).toBeCloseTo(p2.y, 4);
  });
});
