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
    case 'radius':
      return applyRadius(constraint, entities);
    case 'concentric':
      return applyConcentric(constraint, points, entities);
    case 'fixed':
      return 0; // Handled by anchoring points before the solve loop.
    case 'tangent':
      return applyTangent(constraint, points, entities);
    case 'symmetric':
      return applySymmetric(constraint, points, entities);
  }
}

/**
 * Tangency between a line and a circle/arc: the circle centre must sit exactly
 * one radius away from the infinite line. The line slides (perpendicular to
 * itself) to satisfy it — circles keep their radius, the less destructive edit.
 */
function applyTangent(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;
  const e1 = entities.get(id1);
  const e2 = entities.get(id2);
  if (!e1 || !e2) return 0;

  const line = e1.type === 'line' ? e1 : e2.type === 'line' ? e2 : null;
  const round = (e: SketchEntity): (SketchEntity & { radius: number; centerId: string }) | null =>
    e.type === 'circle' || e.type === 'arc' ? e : null;
  const circle = round(e1) ?? round(e2);
  if (!line || !circle) return 0;

  const eps = getLineEndpoints(line.id, entities, points);
  const c = points.get(circle.centerId);
  if (!eps || !c) return 0;
  const [a1, a2] = eps;

  const dx = a2.x - a1.x;
  const dy = a2.y - a1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-10) return 0;
  // Unit normal of the line.
  const nx = -dy / len;
  const ny = dx / len;
  // Signed distance from the centre to the infinite line (along the normal).
  const d = (c.x - a1.x) * nx + (c.y - a1.y) * ny;
  // Keep the circle on the same side it already occupies: the target signed
  // distance is ±radius, matching the sign of d.
  const t = d - Math.sign(d) * circle.radius;
  if (Math.abs(t) < 1e-12) return 0;
  // Translate the line along its normal (half each end per iteration →
  // geometric relaxation; a single free end pivots instead).
  let maxDelta = 0;
  if (!a1.fixed && !a2.fixed) {
    a1.x += nx * t / 2; a1.y += ny * t / 2;
    a2.x += nx * t / 2; a2.y += ny * t / 2;
    maxDelta = Math.abs(t) / 2;
  } else if (!a1.fixed) {
    a1.x += nx * t; a1.y += ny * t;
    maxDelta = Math.abs(t);
  } else if (!a2.fixed) {
    a2.x += nx * t; a2.y += ny * t;
    maxDelta = Math.abs(t);
  }
  return maxDelta;
}

/**
 * Symmetry of two entities about a line: their midpoints' average must lie ON
 * the mirror line and the join between them must be perpendicular to it. Each
 * iteration nudges both symmetrically (half-steps so it relaxes like the other
 * constraints instead of overshooting).
 */
function applySymmetric(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  // [a, b, line] — a and b are points (or entities resolved to their first point).
  const [ida, idb, idl] = constraint.entityIds;
  if (!ida || !idb || !idl) return 0;

  const resolve = (id: string): SolverPoint | undefined => {
    const e = entities.get(id);
    if (!e) return undefined;
    if (e.type === 'point') return points.get(e.id);
    const pid = (e.type === 'line' ? e.p1Id : e.type === 'circle' || e.type === 'arc' ? e.centerId : undefined);
    return pid ? points.get(pid) : undefined;
  };
  const pa = resolve(ida);
  const pb = resolve(idb);
  const line = entities.get(idl);
  if (!pa || !pb || !line || line.type !== 'line') return 0;
  const eps = getLineEndpoints(idl, entities, points);
  if (!eps) return 0;
  const [l1, l2] = eps;
  const tx = l2.x - l1.x;
  const ty = l2.y - l1.y;
  const tlen = Math.hypot(tx, ty);
  if (tlen < 1e-10) return 0;
  const ux = tx / tlen;
  const uy = ty / tlen;

  let maxDelta = 0;
  // 1) Land the pair's midpoint on the mirror line.
  const mx = (pa.x + pb.x) / 2;
  const my = (pa.y + pb.y) / 2;
  const along = (mx - l1.x) * ux + (my - l1.y) * uy;
  const px = l1.x + ux * along;
  const py = l1.y + uy * along;
  const ddx = (px - mx) / 2;
  const ddy = (py - my) / 2;
  if (!pa.fixed) { pa.x += ddx; pa.y += ddy; maxDelta = Math.max(maxDelta, Math.hypot(ddx, ddy)); }
  if (!pb.fixed) { pb.x += ddx; pb.y += ddy; maxDelta = Math.max(maxDelta, Math.hypot(ddx, ddy)); }

  // 2) Make the join perpendicular to the mirror line (remove tangential skew).
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const vt = (vx * ux + vy * uy) / 4; // quarter each end
  if (!pa.fixed) { pa.x += ux * vt; pa.y += uy * vt; }
  if (!pb.fixed) { pb.x -= ux * vt; pb.y -= uy * vt; }
  maxDelta = Math.max(maxDelta, Math.abs(vt));
  return maxDelta;
}

/** Make two circles/arcs share a center by snapping their center points together. */
function applyConcentric(
  constraint: SketchConstraint,
  points: Map<string, SolverPoint>,
  entities: Map<string, SketchEntity>,
): number {
  const [id1, id2] = constraint.entityIds;
  if (!id1 || !id2) return 0;
  const e1 = entities.get(id1);
  const e2 = entities.get(id2);
  const centerId = (e?: SketchEntity): string | undefined =>
    e && (e.type === 'circle' || e.type === 'arc') ? e.centerId : undefined;
  const c1 = centerId(e1);
  const c2 = centerId(e2);
  if (!c1 || !c2) return 0;
  // Reuse the coincident point-snap on the two center points.
  return applyCoincident({ ...constraint, entityIds: [c1, c2] }, points);
}

/** Set a circle/arc's radius to the constraint value (an absolute dimension). */
function applyRadius(constraint: SketchConstraint, entities: Map<string, SketchEntity>): number {
  const target = constraint.value;
  if (target === undefined || target <= 0) return 0;
  const [id] = constraint.entityIds;
  if (!id) return 0;
  const e = entities.get(id);
  if (!e || (e.type !== 'circle' && e.type !== 'arc')) return 0;
  const delta = Math.abs(e.radius - target);
  e.radius = target;
  return delta;
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

  // Snap to the anchored y when any endpoint is fixed (so the line aligns to
  // the datum, not a drifting average); otherwise use the mean.
  const targetY = sharedTarget(involved, (p) => p.y);
  for (const p of involved) {
    if (!p.fixed) {
      const delta = Math.abs(p.y - targetY);
      maxDelta = Math.max(maxDelta, delta);
      p.y = targetY;
    }
  }

  return maxDelta;
}

/** Target coordinate for an alignment: mean of fixed points if any, else mean of all. */
function sharedTarget(pts: SolverPoint[], coord: (p: SolverPoint) => number): number {
  const fixed = pts.filter((p) => p.fixed);
  const pool = fixed.length > 0 ? fixed : pts;
  return pool.reduce((s, p) => s + coord(p), 0) / pool.length;
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

  const targetX = sharedTarget(involved, (p) => p.x);
  for (const p of involved) {
    if (!p.fixed) {
      const delta = Math.abs(p.x - targetX);
      maxDelta = Math.max(maxDelta, delta);
      p.x = targetX;
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

    // Scale each line toward the average length about the right pivot: the
    // anchored endpoint if one is fixed (so it stays put and the length is
    // corrected in one step), otherwise the midpoint. A fully fixed line is
    // left untouched.
    const d1 = scaleLineToLength(eps1[0], eps1[1], avgLen, len1);
    const d2 = scaleLineToLength(eps2[0], eps2[1], avgLen, len2);
    return Math.max(d1, d2);
  }

  // Equal radius for circles/arcs (any combination)
  const radiusOf = (e: SketchEntity): number | null =>
    e.type === 'circle' || e.type === 'arc' ? e.radius : null;
  const r1 = radiusOf(e1);
  const r2 = radiusOf(e2);
  if (r1 !== null && r2 !== null) {
    const avgR = (r1 + r2) / 2;
    const delta = Math.abs(r1 - r2) / 2;
    if (e1.type === 'circle' || e1.type === 'arc') e1.radius = avgR;
    if (e2.type === 'circle' || e2.type === 'arc') e2.radius = avgR;
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

/**
 * Scale segment a–b to `targetLen` about the correct pivot: the fixed endpoint
 * if exactly one is anchored (keeping it put), otherwise the midpoint. Returns
 * the length error corrected (0 if both endpoints are fixed).
 */
function scaleLineToLength(a: SolverPoint, b: SolverPoint, targetLen: number, currentLen: number): number {
  if (a.fixed && b.fixed) return 0;
  let px: number;
  let py: number;
  if (a.fixed) {
    px = a.x;
    py = a.y;
  } else if (b.fixed) {
    px = b.x;
    py = b.y;
  } else {
    px = (a.x + b.x) / 2;
    py = (a.y + b.y) / 2;
  }
  const scale = targetLen / currentLen;
  if (!a.fixed) {
    a.x = px + (a.x - px) * scale;
    a.y = py + (a.y - py) * scale;
  }
  if (!b.fixed) {
    b.x = px + (b.x - px) * scale;
    b.y = py + (b.y - py) * scale;
  }
  return Math.abs(currentLen - targetLen);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}
