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

export function removeEntity(sketch: Sketch, entityId: string): void {
  sketch.entities.delete(entityId);
  // Remove constraints referencing this entity
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
