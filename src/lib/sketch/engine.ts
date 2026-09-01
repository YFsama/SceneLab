import type {
  Sketch,
  SketchEntity,
  SketchConstraint,
  SketchPoint,
  SketchLine,
  SketchCircle,
  SketchArc,
  ConstraintType,
} from './types';
import { solveConstraints } from './solver';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export function createSketch(planeId: string): Sketch {
  return {
    id: genId('sketch'),
    planeId,
    entities: new Map(),
    constraints: new Map(),
  };
}

/** Deep-ish clone of a sketch (fresh entity/constraint maps with copied values)
 * so a snapshot can be kept for undo without aliasing the live sketch. */
export function cloneSketch(s: Sketch): Sketch {
  return {
    id: s.id,
    planeId: s.planeId,
    entities: new Map([...s.entities].map(([k, v]) => [k, { ...v }])),
    constraints: new Map([...s.constraints].map(([k, v]) => [k, { ...v }])),
  };
}

export function addPoint(sketch: Sketch, x: number, y: number): SketchPoint {
  const pt: SketchPoint = { id: genId('pt'), type: 'point', x, y };
  sketch.entities.set(pt.id, pt);
  return pt;
}

export function addLine(sketch: Sketch, x1: number, y1: number, x2: number, y2: number): SketchLine {
  const p1 = addPoint(sketch, x1, y1);
  const p2 = addPoint(sketch, x2, y2);
  const line: SketchLine = { id: genId('line'), type: 'line', p1Id: p1.id, p2Id: p2.id };
  sketch.entities.set(line.id, line);
  return line;
}

/** Vertices of a regular `sides`-gon centred at (cx,cy) with circumradius `r`,
 * first vertex at the top. Pure — used for drawing and the polygon preview. */
export function polygonPoints(cx: number, cy: number, r: number, sides: number): { x: number; y: number }[] {
  const n = Math.max(3, Math.floor(sides));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Add a closed regular polygon as `sides` line segments; returns their ids. */
export function addPolygon(sketch: Sketch, cx: number, cy: number, radius: number, sides: number): string[] {
  const pts = polygonPoints(cx, cy, radius, sides);
  const ids: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    ids.push(addLine(sketch, a.x, a.y, b.x, b.y).id);
  }
  return ids;
}

export function addRectangle(
  sketch: Sketch,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { lines: SketchLine[]; points: SketchPoint[] } {
  const p1 = addPoint(sketch, x1, y1);
  const p2 = addPoint(sketch, x2, y1);
  const p3 = addPoint(sketch, x2, y2);
  const p4 = addPoint(sketch, x1, y2);

  const lines = [
    { id: genId('line'), type: 'line' as const, p1Id: p1.id, p2Id: p2.id },
    { id: genId('line'), type: 'line' as const, p1Id: p2.id, p2Id: p3.id },
    { id: genId('line'), type: 'line' as const, p1Id: p3.id, p2Id: p4.id },
    { id: genId('line'), type: 'line' as const, p1Id: p4.id, p2Id: p1.id },
  ];

  for (const line of lines) {
    sketch.entities.set(line.id, line);
  }

  return { lines, points: [p1, p2, p3, p4] };
}

export function addCircle(sketch: Sketch, cx: number, cy: number, radius: number): SketchCircle {
  const center = addPoint(sketch, cx, cy);
  const circle: SketchCircle = { id: genId('circle'), type: 'circle', centerId: center.id, radius };
  sketch.entities.set(circle.id, circle);
  return circle;
}

export function addArc(
  sketch: Sketch,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): SketchArc {
  const center = addPoint(sketch, cx, cy);
  const arc: SketchArc = {
    id: genId('arc'),
    type: 'arc',
    centerId: center.id,
    radius,
    startAngle,
    endAngle,
  };
  sketch.entities.set(arc.id, arc);
  return arc;
}

export function addConstraint(
  sketch: Sketch,
  type: ConstraintType,
  entityIds: string[],
  value?: number,
): SketchConstraint {
  const constraint: SketchConstraint = {
    id: genId('cstr'),
    type,
    entityIds,
    value,
  };
  sketch.constraints.set(constraint.id, constraint);
  return constraint;
}

/** Point ids an entity is built from (its endpoints / center). */
export function pointIdsOf(entity: SketchEntity): string[] {
  switch (entity.type) {
    case 'line':
      return [entity.p1Id, entity.p2Id];
    case 'circle':
    case 'arc':
      return [entity.centerId];
    case 'rectangle':
      return [entity.p1Id, entity.p2Id, entity.p3Id, entity.p4Id];
    case 'point':
      return [];
  }
}

/**
 * The two closest point ids of two entities. Constraints like coincident and
 * distance operate on points, but users pick whole entities (SolidWorks
 * behaviour: the nearest endpoints snap together). Circles/arcs contribute
 * their centre; points contribute themselves.
 */
export function closestPointPair(
  sketch: Sketch,
  idA: string,
  idB: string,
): [string, string] | null {
  const entityPoints = (id: string): { pid: string; x: number; y: number }[] => {
    const e = sketch.entities.get(id);
    if (!e) return [];
    if (e.type === 'point') return [{ pid: e.id, x: e.x, y: e.y }];
    return pointIdsOf(e)
      .map((pid) => {
        const p = sketch.entities.get(pid);
        return p && p.type === 'point' ? { pid, x: p.x, y: p.y } : null;
      })
      .filter((p): p is { pid: string; x: number; y: number } => p !== null);
  };

  let best: [string, string] | null = null;
  let bestDist = Infinity;
  for (const a of entityPoints(idA)) {
    for (const b of entityPoints(idB)) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < bestDist) {
        bestDist = d;
        best = [a.pid, b.pid];
      }
    }
  }
  return best;
}

export function removeEntity(sketch: Sketch, entityId: string): void {
  const entity = sketch.entities.get(entityId);
  if (!entity) return;
  sketch.entities.delete(entityId);

  // Clean up the entity's own points (e.g. a line's endpoints) so deleting a
  // line doesn't orphan its vertices. Keep a point if another entity still
  // uses it or a constraint references it directly (it may be intentional).
  for (const pid of pointIdsOf(entity)) {
    const usedByEntity = [...sketch.entities.values()].some((e) => pointIdsOf(e).includes(pid));
    const usedByConstraint = [...sketch.constraints.values()].some((c) => c.entityIds.includes(pid));
    if (!usedByEntity && !usedByConstraint) sketch.entities.delete(pid);
  }

  // Remove constraints referencing the deleted entity.
  for (const [id, c] of sketch.constraints) {
    if (c.entityIds.includes(entityId)) {
      sketch.constraints.delete(id);
    }
  }
}

export function removeConstraint(sketch: Sketch, constraintId: string): void {
  sketch.constraints.delete(constraintId);
}

export function solveSketch(sketch: Sketch): Map<string, { x: number; y: number }> {
  return solveConstraints(sketch.entities, sketch.constraints);
}

export function getEntityPoints(
  entity: SketchEntity,
  entities: Map<string, SketchEntity>,
): { x: number; y: number }[] {
  switch (entity.type) {
    case 'point':
      return [{ x: entity.x, y: entity.y }];
    case 'line': {
      const p1 = entities.get(entity.p1Id);
      const p2 = entities.get(entity.p2Id);
      if (p1?.type === 'point' && p2?.type === 'point') {
        return [
          { x: p1.x, y: p1.y },
          { x: p2.x, y: p2.y },
        ];
      }
      return [];
    }
    case 'circle':
    case 'arc': {
      const center = entities.get(entity.centerId);
      if (center?.type === 'point') {
        return [{ x: center.x, y: center.y }];
      }
      return [];
    }
    case 'rectangle': {
      const pts: { x: number; y: number }[] = [];
      for (const pid of [entity.p1Id, entity.p2Id, entity.p3Id, entity.p4Id]) {
        const p = entities.get(pid);
        if (p?.type === 'point') pts.push({ x: p.x, y: p.y });
      }
      return pts;
    }
  }
}

/**
 * Snap targets a new point can latch onto while sketching: every existing point
 * (endpoints, centres) plus the midpoint of each line — the midpoint snap is a
 * SolidWorks staple. The origin is added separately by sketchSnapPoints.
 */
export function snapTargets(sketch: Sketch): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const ent of sketch.entities.values()) {
    if (ent.type === 'point') pts.push({ x: ent.x, y: ent.y });
  }
  for (const ent of sketch.entities.values()) {
    if (ent.type === 'line') {
      const a = sketch.entities.get(ent.p1Id);
      const b = sketch.entities.get(ent.p2Id);
      if (a?.type === 'point' && b?.type === 'point') {
        pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
  }
  return pts;
}

/** Result of rectangle detection: the 4 corners and 4 line IDs. */
export interface DetectedRectangle {
  /** Corner points in order: p1→p2 (width), p2→p3 (height). */
  corners: [SketchPoint, SketchPoint, SketchPoint, SketchPoint];
  lineIds: [string, string, string, string];
  width: number;
  height: number;
}

/**
 * Detect if the given line is part of a rectangle pattern (4 connected lines
 * forming a closed loop with ~90° angles at each corner). Returns the rectangle
 * info or null if the line is not part of a rectangle.
 */
export function detectRectangle(sketch: Sketch, lineId: string): DetectedRectangle | null {
  const line = sketch.entities.get(lineId);
  if (!line || line.type !== 'line') return null;

  // Build adjacency: point → set of line IDs that reference it.
  const adj = new Map<string, string[]>();
  for (const ent of sketch.entities.values()) {
    if (ent.type === 'line') {
      for (const pid of [ent.p1Id, ent.p2Id]) {
        if (!adj.has(pid)) adj.set(pid, []);
        adj.get(pid)!.push(ent.id);
      }
    }
  }

  // Walk the chain starting from this line.
  const getEndpoints = (lid: string): [SketchPoint, SketchPoint] | null => {
    const l = sketch.entities.get(lid);
    if (!l || l.type !== 'line') return null;
    const p1 = sketch.entities.get(l.p1Id);
    const p2 = sketch.entities.get(l.p2Id);
    if (!p1 || p1.type !== 'point' || !p2 || p2.type !== 'point') return null;
    return [p1, p2];
  };

  const otherEnd = (lid: string, pid: string): string | null => {
    const l = sketch.entities.get(lid);
    if (!l || l.type !== 'line') return null;
    return l.p1Id === pid ? l.p2Id : l.p1Id;
  };

  const eps = 1e-3;
  const isRightAngle = (a: SketchPoint, b: SketchPoint, c: SketchPoint): boolean => {
    const dx1 = b.x - a.x, dy1 = b.y - a.y;
    const dx2 = c.x - b.x, dy2 = c.y - b.y;
    const dot = dx1 * dx2 + dy1 * dy2;
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
    if (l1 < eps || l2 < eps) return false;
    return Math.abs(dot) / (l1 * l2) < 0.1; // ~90° (within ~6°)
  };

  // Try to walk 4 lines forming a closed rectangle.
  const ends = getEndpoints(lineId);
  if (!ends) return null;
  const [startP, firstOther] = [ends[0], ends[1]];
  const chain: string[] = [lineId];
  const points: SketchPoint[] = [startP];
  let currentPid = firstOther.id;

  for (let step = 0; step < 3; step++) {
    const candidates = (adj.get(currentPid) ?? []).filter((lid) => lid !== chain[chain.length - 1]);
    if (candidates.length !== 1) return null; // must have exactly one continuation
    const nextLineId = candidates[0]!;
    const nextOther = otherEnd(nextLineId, currentPid);
    if (!nextOther) return null;
    const nextPt = sketch.entities.get(nextOther);
    if (!nextPt || nextPt.type !== 'point') return null;
    chain.push(nextLineId);
    points.push(sketch.entities.get(currentPid) as SketchPoint);
    currentPid = nextOther;
  }

  // The chain should close back to startP.
  if (currentPid !== startP.id) return null;
  if (chain.length !== 4) return null;

  // Check all 4 angles are ~90°.
  const p = points as [SketchPoint, SketchPoint, SketchPoint, SketchPoint];
  for (let i = 0; i < 4; i++) {
    const a = p[i]!, b = p[(i + 1) % 4]!, c = p[(i + 2) % 4]!;
    if (!isRightAngle(a, b, c)) return null;
  }

  const width = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
  const height = Math.hypot(p[2]!.x - p[1]!.x, p[2]!.y - p[1]!.y);
  return {
    corners: p,
    lineIds: chain as [string, string, string, string],
    width,
    height,
  };
}

/**
 * Resize a detected rectangle by setting new width and/or height. Moves the
 * appropriate lines to match the new dimensions, keeping p1 (first corner) fixed.
 */
export function resizeRectangle(_sketch: Sketch, rect: DetectedRectangle, newWidth: number, newHeight: number): void {
  const [p1, p2, p3, p4] = rect.corners;
  const oldW = rect.width || 1;
  const oldH = rect.height || 1;

  // Direction vectors for width (p1→p2) and height (p2→p3).
  const wDir = { x: (p2.x - p1.x) / oldW, y: (p2.y - p1.y) / oldW };
  const hDir = { x: (p3.x - p2.x) / oldH, y: (p3.y - p2.y) / oldH };

  // New corner positions, keeping p1 fixed.
  p2.x = p1.x + wDir.x * newWidth;
  p2.y = p1.y + wDir.y * newWidth;
  p3.x = p2.x + hDir.x * newHeight;
  p3.y = p2.y + hDir.y * newHeight;
  p4.x = p1.x + hDir.x * newHeight;
  p4.y = p1.y + hDir.y * newHeight;
}

/**
 * 2D corner fillet between two lines (SolidWorks sketch fillet): find the
 * corner where the (extended) lines meet, place a tangent arc of `radius`,
 * trim both lines back to their tangent points, and insert the arc. Returns
 * false when the lines are parallel, the radius can't fit inside either
 * segment, or either entity isn't a line.
 */
export function filletSketchCorner(
  sketch: Sketch,
  lineAId: string,
  lineBId: string,
  radius: number,
): boolean {
  if (!(radius > 0) || lineAId === lineBId) return false;
  const a = sketch.entities.get(lineAId);
  const b = sketch.entities.get(lineBId);
  if (a?.type !== 'line' || b?.type !== 'line') return false;
  const pt = (id: string): { x: number; y: number } | null => {
    const p = sketch.entities.get(id);
    return p?.type === 'point' ? { x: p.x, y: p.y } : null;
  };
  const a1 = pt(a.p1Id);
  const a2 = pt(a.p2Id);
  const b1 = pt(b.p1Id);
  const b2 = pt(b.p2Id);
  if (!a1 || !a2 || !b1 || !b2) return false;

  // Infinite-line intersection of A (a1→a2) and B (b1→b2).
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-12) return false; // parallel
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
  const vx = a1.x + dax * t;
  const vy = a1.y + day * t;

  // The corner endpoint of each line: the one nearest the intersection (or,
  // when the intersection lies beyond a segment, the nearer endpoint still
  // defines which side participates in the corner).
  const cornerOf = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.hypot(p1.x - vx, p1.y - vy) <= Math.hypot(p2.x - vx, p2.y - vy) ? p1 : p2;
  const farOf = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
    Math.hypot(p1.x - vx, p1.y - vy) <= Math.hypot(p2.x - vx, p2.y - vy) ? p2 : p1;
  const aCorner = cornerOf(a1, a2);
  const aFar = farOf(a1, a2);
  const bCorner = cornerOf(b1, b2);
  const bFar = farOf(b1, b2);

  // Kept directions point from the corner along each line's body.
  const dirOf = (c: { x: number; y: number }, f: { x: number; y: number }) => {
    const dx = f.x - c.x, dy = f.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const da = dirOf(aCorner, aFar);
  const db = dirOf(bCorner, bFar);
  const angle = Math.acos(Math.min(1, Math.max(-1, da.x * db.x + da.y * db.y)));
  if (angle < 1e-3 || Math.PI - angle < 1e-3) return false; // degenerate corner

  // Arc centre: on the angle bisector at r / sin(θ/2) from the corner.
  const bis = { x: da.x + db.x, y: da.y + db.y };
  const bisLen = Math.hypot(bis.x, bis.y) || 1;
  const dist = radius / Math.sin(angle / 2);
  const cx = vx + (bis.x / bisLen) * dist;
  const cy = vy + (bis.y / bisLen) * dist;

  // Tangent points: perpendicular feet from the centre onto each infinite line.
  const foot = (p: { x: number; y: number }, d: { x: number; y: number }): { x: number; y: number } => {
    const t2 = (cx - p.x) * d.x + (cy - p.y) * d.y;
    return { x: p.x + d.x * t2, y: p.y + d.y * t2 };
  };
  const t1 = foot(aCorner, da);
  const t2 = foot(bCorner, db);
  // Both tangent points must lie inside (or at the very start of) the kept
  // spans — a fillet that needs to lengthen a line is refused here.
  const within = (c: { x: number; y: number }, f: { x: number; y: number }, p: { x: number; y: number }) => {
    const segLen = Math.hypot(f.x - c.x, f.y - c.y);
    const along = (p.x - c.x) * (f.x - c.x) + (p.y - c.y) * (f.y - c.y);
    return along >= -1e-6 && along <= segLen * segLen + 1e-6;
  };
  if (!within(aCorner, aFar, t1) || !within(bCorner, bFar, t2)) return false;

  // Trim: pull each line's corner endpoint back to its tangent point, then
  // bridge with the arc (angles ordered so the sweep bulges away from V).
  const ang1 = Math.atan2(t1.y - cy, t1.x - cx);
  const ang2 = Math.atan2(t2.y - cy, t2.x - cx);
  // The arc must contain the corner direction (it bulges toward V — the
  // tangency chord always subtends <= π, so that arc is automatically the
  // minor one). Angles stay continuous: start = ang1, end walks one way.
  const angV = Math.atan2(vy - cy, vx - cx);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccwSweep = norm(ang2 - ang1);
  const cornerInCcw = norm(angV - ang1) < ccwSweep;
  const startAngle = ang1;
  const endAngle = cornerInCcw ? ang1 + ccwSweep : ang1 - (2 * Math.PI - ccwSweep);

  // Move the corner points (they may be shared by other entities — moving the
  // point trims every attached segment, which is the correct shared-vertex
  // behaviour for a sketch fillet).
  const aCornerEntity = sketch.entities.get(
    Math.hypot(a1.x - vx, a1.y - vy) <= Math.hypot(a2.x - vx, a2.y - vy) ? a.p1Id : a.p2Id,
  );
  const bCornerEntity = sketch.entities.get(
    Math.hypot(b1.x - vx, b1.y - vy) <= Math.hypot(b2.x - vx, b2.y - vy) ? b.p1Id : b.p2Id,
  );
  if (aCornerEntity?.type !== 'point' || bCornerEntity?.type !== 'point') return false;
  aCornerEntity.x = t1.x;
  aCornerEntity.y = t1.y;
  bCornerEntity.x = t2.x;
  bCornerEntity.y = t2.y;

  addArc(sketch, cx, cy, radius, startAngle, endAngle);
  return true;
}
