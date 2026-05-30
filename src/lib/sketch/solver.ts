import type { SketchEntity, SketchConstraint, Vec2 } from './types';

interface SolverPoint {
  x: number;
  y: number;
  fixed: boolean;
}

export function solveConstraints(
  entities: Map<string, SketchEntity>,
  constraints: Map<string, SketchConstraint>,
  maxIterations = 50,
  tolerance = 1e-6,
): Map<string, Vec2> {
  const points = new Map<string, SolverPoint>();

  // Extract all points from entities
  for (const entity of entities.values()) {
    if (entity.type === 'point') {
      points.set(entity.id, { x: entity.x, y: entity.y, fixed: false });
    }
  }

  // Anchor points named by 'fixed' constraints before solving, so every other
  // constraint resolves against them instead of drifting the whole sketch.
  for (const constraint of constraints.values()) {
    if (constraint.type === 'fixed') {
      for (const id of constraint.entityIds) {
        const p = points.get(id);
        if (p) p.fixed = true;
      }
    }
  }

  // Iterative constraint resolution
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxDelta = 0;

    for (const constraint of constraints.values()) {
      const delta = applyConstraint(constraint, points, entities);
      maxDelta = Math.max(maxDelta, delta);
    }

    if (maxDelta < tolerance) break;
  }

  const result = new Map<string, Vec2>();
  for (const [id, pt] of points) {
    result.set(id, { x: pt.x, y: pt.y });
  }
  return result;
}

function applyConstraint(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  switch (constraint.type) {
    case 'horizontal':
      return applyHorizontal(constraint, points, entities);
    case 'vertical':
      return applyVertical(constraint, points, entities);
    case 'parallel':
      return applyParallel(constraint, points, entities);
    case 'perpendicular':
      return applyPerpendicular(constraint, points, entities);
    case 'equal':
      return applyEqual(constraint, points, entities);
    case 'coincident':
      return applyCoincident(constraint, points);
    case 'distance':
      return applyDistance(constraint, points);
    case 'fixed':
      return 0; // Handled by anchoring points before the solve loop.
  }
}

function getLineEndpoints(
  lineId: string,
  entities: Map<string, SketchEntity>,
  points: Map<string, SolverPoint>,
): [SolverPoint, SolverPoint] | null {
  const entity = entities.get(lineId);
  if (!entity || entity.type !== 'line') return null;
  const p1 = points.get(entity.p1Id);
  const p2 = points.get(entity.p2Id);
  if (!p1 || !p2) return null;
  return [p1, p2];
}

function applyHorizontal(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  // Horizontal: all line endpoints share same y
  const lineIds = constraint.entityIds;
  let maxDelta = 0;

  // Collect all involved points
  const involved: SolverPoint[] = [];
  for (const id of lineIds) {
    const eps = getLineEndpoints(id, entities, points);
    if (eps) {
      involved.push(eps[0], eps[1]);
    }
  }

  if (involved.length < 2) return 0;

  // Average y
  const avgY = involved.reduce((s, p) => s + p.y, 0) / involved.length;
  for (const p of involved) {
    if (!p.fixed) {
      const delta = Math.abs(p.y - avgY);
      maxDelta = Math.max(maxDelta, delta);
      p.y = avgY;
    }
  }

  return maxDelta;
}

function applyVertical(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const lineIds = constraint.entityIds;
  let maxDelta = 0;

  const involved: SolverPoint[] = [];
  for (const id of lineIds) {
    const eps = getLineEndpoints(id, entities, points);
    if (eps) {
      involved.push(eps[0], eps[1]);
    }
  }

  if (involved.length < 2) return 0;

  const avgX = involved.reduce((s, p) => s + p.x, 0) / involved.length;
  for (const p of involved) {
    if (!p.fixed) {
      const delta = Math.abs(p.x - avgX);
      maxDelta = Math.max(maxDelta, delta);
      p.x = avgX;
    }
  }

  return maxDelta;
}

function applyParallel(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;

  const eps1 = getLineEndpoints(id1, entities, points);
  const eps2 = getLineEndpoints(id2, entities, points);
  if (!eps1 || !eps2) return 0;

  const [a1, a2] = eps1;
  const [b1, b2] = eps2;

  // Direction of line 1
  const dx1 = a2.x - a1.x;
  const dy1 = a2.y - a1.y;
  const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  if (len1 < 1e-10) return 0;

  // Project line 2 endpoints to be parallel to line 1
  const dx2 = b2.x - b1.x;
  const dy2 = b2.y - b1.y;

  // Cross product should be 0 for parallel
  const cross = dx1 * dy2 - dy1 * dx2;
  const halfCross = cross / 2;

  let maxDelta = 0;
  if (!b1.fixed && !b2.fixed) {
    // Move both endpoints equally
    const nx = -dy1 / len1;
    const ny = dx1 / len1;
    const correction = halfCross / len1;
    // Move endpoints so line 2's component perpendicular to line 1 is removed
    // (cancelling the cross product, not amplifying it).
    b1.x += nx * correction;
    b1.y += ny * correction;
    b2.x -= nx * correction;
    b2.y -= ny * correction;
    maxDelta = Math.abs(correction) * 2;
  } else if (!b1.fixed) {
    // Move only b1
    const remainingCross = dx1 * (b2.y - b1.y) - dy1 * (b2.x - b1.x);
    const nx = -dy1 / len1;
    const ny = dx1 / len1;
    const correction = remainingCross / len1;
    b1.x += nx * correction;
    b1.y += ny * correction;
    maxDelta = Math.abs(correction);
  } else if (!b2.fixed) {
    const remainingCross = dx1 * (b2.y - b1.y) - dy1 * (b2.x - b1.x);
    const nx = -dy1 / len1;
    const ny = dx1 / len1;
    const correction = remainingCross / len1;
    b2.x -= nx * correction;
    b2.y -= ny * correction;
    maxDelta = Math.abs(correction);
  }

  return maxDelta;
}

function applyPerpendicular(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;

  const eps1 = getLineEndpoints(id1, entities, points);
  const eps2 = getLineEndpoints(id2, entities, points);
  if (!eps1 || !eps2) return 0;

  const [a1, a2] = eps1;
  const [b1, b2] = eps2;

  // Unit tangent of line 1.
  const dx1 = a2.x - a1.x;
  const dy1 = a2.y - a1.y;
  const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  if (len1 < 1e-10) return 0;
  const tx = dx1 / len1;
  const ty = dy1 / len1;

  // For perpendicular lines, line 2's direction must have no component along
  // line 1's tangent — i.e. dot product 0. `dot` is that tangential component;
  // remove it by sliding line 2's endpoints along the tangent.
  const dot = (b2.x - b1.x) * tx + (b2.y - b1.y) * ty;

  let maxDelta = 0;
  if (!b1.fixed && !b2.fixed) {
    const half = dot / 2;
    b1.x += tx * half;
    b1.y += ty * half;
    b2.x -= tx * half;
    b2.y -= ty * half;
    maxDelta = Math.abs(dot);
  } else if (!b1.fixed) {
    b1.x += tx * dot;
    b1.y += ty * dot;
    maxDelta = Math.abs(dot);
  } else if (!b2.fixed) {
    b2.x -= tx * dot;
    b2.y -= ty * dot;
    maxDelta = Math.abs(dot);
  }

  return maxDelta;
}

function applyEqual(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;

  const e1 = entities.get(id1);
  const e2 = entities.get(id2);
  if (!e1 || !e2) return 0;

  // Equal length for lines
  if (e1.type === 'line' && e2.type === 'line') {
    const eps1 = getLineEndpoints(id1, entities, points);
    const eps2 = getLineEndpoints(id2, entities, points);
    if (!eps1 || !eps2) return 0;

    const len1 = dist(eps1[0], eps1[1]);
    const len2 = dist(eps2[0], eps2[1]);
    const avgLen = (len1 + len2) / 2;

    if (len1 < 1e-10 || len2 < 1e-10) return 0;

    // Scale each line toward average length
    const scale1 = avgLen / len1;
    const scale2 = avgLen / len2;

    const mid1 = midpoint(eps1[0], eps1[1]);
    const mid2 = midpoint(eps2[0], eps2[1]);

    let maxDelta = 0;
    if (!eps1[0].fixed) {
      eps1[0].x = mid1.x + (eps1[0].x - mid1.x) * scale1;
      eps1[0].y = mid1.y + (eps1[0].y - mid1.y) * scale1;
      maxDelta = Math.max(maxDelta, Math.abs(len1 - avgLen));
    }
    if (!eps1[1].fixed) {
      eps1[1].x = mid1.x + (eps1[1].x - mid1.x) * scale1;
      eps1[1].y = mid1.y + (eps1[1].y - mid1.y) * scale1;
    }
    if (!eps2[0].fixed) {
      eps2[0].x = mid2.x + (eps2[0].x - mid2.x) * scale2;
      eps2[0].y = mid2.y + (eps2[0].y - mid2.y) * scale2;
      maxDelta = Math.max(maxDelta, Math.abs(len2 - avgLen));
    }
    if (!eps2[1].fixed) {
      eps2[1].x = mid2.x + (eps2[1].x - mid2.x) * scale2;
      eps2[1].y = mid2.y + (eps2[1].y - mid2.y) * scale2;
    }

    return maxDelta;
  }

  // Equal radius for circles
  if (e1.type === 'circle' && e2.type === 'circle') {
    const avgR = (e1.radius + e2.radius) / 2;
    const delta = Math.abs(e1.radius - e2.radius) / 2;
    e1.radius = avgR;
    e2.radius = avgR;
    return delta;
  }

  return 0;
}

function applyCoincident(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
): number {
  // Pin two points to the same location. Operates on point IDs directly.
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;

  const p1 = points.get(id1);
  const p2 = points.get(id2);
  if (!p1 || !p2) return 0;

  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-12) return 0;

  if (!p1.fixed && !p2.fixed) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    p1.x = mx;
    p1.y = my;
    p2.x = mx;
    p2.y = my;
    return d / 2;
  } else if (!p1.fixed) {
    p1.x = p2.x;
    p1.y = p2.y;
    return d;
  } else if (!p2.fixed) {
    p2.x = p1.x;
    p2.y = p1.y;
    return d;
  }

  return 0;
}

function applyDistance(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
): number {
  const targetDist = constraint.value;
  if (targetDist === undefined) return 0;

  // Get two point IDs from constraint
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;

  const p1 = points.get(id1);
  const p2 = points.get(id2);
  if (!p1 || !p2) return 0;

  const currentDist = dist(p1, p2);
  if (currentDist < 1e-10) return 0;

  const diff = currentDist - targetDist;
  const ratio = diff / currentDist / 2;

  // Capture the separation vector before mutating either point — reading the
  // live coordinates mid-update would feed an already-moved p1 back into p2.
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;

  let maxDelta = 0;
  if (!p1.fixed && !p2.fixed) {
    // Move both endpoints toward each other (or apart) by half the error.
    p1.x -= dx * ratio;
    p1.y -= dy * ratio;
    p2.x += dx * ratio;
    p2.y += dy * ratio;
    maxDelta = Math.abs(diff) / 2;
  } else if (!p1.fixed) {
    p1.x -= dx * ratio * 2;
    p1.y -= dy * ratio * 2;
    maxDelta = Math.abs(diff);
  } else if (!p2.fixed) {
    p2.x += dx * ratio * 2;
    p2.y += dy * ratio * 2;
    maxDelta = Math.abs(diff);
  }

  return maxDelta;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
