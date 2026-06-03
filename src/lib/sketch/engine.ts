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
