import type { Sketch, SketchEntity, SketchPoint } from './types';

/**
 * Sketch dimensioning (尺寸标注) — measured ("driven") dimensions read off a
 * sketch's current geometry. These report what the geometry currently is, which
 * the properties panel can display and the AI can query; pairing a value with a
 * 'distance'/'radius' constraint turns it into a driving dimension.
 */

export type DimensionKind = 'length' | 'distance' | 'radius' | 'diameter' | 'angle';

export interface Dimension {
  kind: DimensionKind;
  /** Ids of the entities the dimension is measured over. */
  entityIds: string[];
  /** Measured value — mm for lengths/distances/radii, degrees for angles. */
  value: number;
  /** Human-readable label, e.g. "L1: 10.00 mm" / "∠: 90.0°". */
  label: string;
}

/**
 * Live size readout for the shape currently being dragged in a sketch — shown
 * next to the cursor (SolidWorks shows W×H / radius / length as you draw). The
 * `end` should already reflect any inference (e.g. a line's H/V snap). Returns
 * an empty string for tools without a meaningful drag dimension.
 */
export function previewDimensionLabel(
  tool: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  sides = 6,
): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  switch (tool) {
    case 'line':
      return Math.hypot(dx, dy).toFixed(1);
    case 'rect':
      return `${Math.abs(dx).toFixed(1)} × ${Math.abs(dy).toFixed(1)}`;
    case 'circle':
    case 'arc':
      return `R${Math.hypot(dx, dy).toFixed(1)}`;
    case 'polygon':
      return `R${Math.hypot(dx, dy).toFixed(1)} · ${sides}`;
    default:
      return '';
  }
}

function point(sketch: Sketch, id: string): SketchPoint | null {
  const e = sketch.entities.get(id);
  return e?.type === 'point' ? e : null;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

const fmtLen = (v: number) => `${v.toFixed(2)} mm`;
const fmtAng = (v: number) => `${v.toFixed(1)}°`;

/** Distance between two sketch points; null if either id is not a point. */
export function measurePointDistance(sketch: Sketch, p1Id: string, p2Id: string): Dimension | null {
  const a = point(sketch, p1Id);
  const b = point(sketch, p2Id);
  if (!a || !b) return null;
  const value = dist(a.x, a.y, b.x, b.y);
  return { kind: 'distance', entityIds: [p1Id, p2Id], value, label: `D: ${fmtLen(value)}` };
}

/** Length of a line; null if the id is not a line with valid endpoints. */
export function measureLineLength(sketch: Sketch, lineId: string): Dimension | null {
  const e = sketch.entities.get(lineId);
  if (e?.type !== 'line') return null;
  const a = point(sketch, e.p1Id);
  const b = point(sketch, e.p2Id);
  if (!a || !b) return null;
  const value = dist(a.x, a.y, b.x, b.y);
  return { kind: 'length', entityIds: [lineId], value, label: `L: ${fmtLen(value)}` };
}

/** Radius (or diameter) of a circle/arc; null if the id is not a circle or arc. */
export function measureRadius(sketch: Sketch, id: string, asDiameter = false): Dimension | null {
  const e = sketch.entities.get(id);
  if (e?.type !== 'circle' && e?.type !== 'arc') return null;
  const value = asDiameter ? e.radius * 2 : e.radius;
  return {
    kind: asDiameter ? 'diameter' : 'radius',
    entityIds: [id],
    value,
    label: `${asDiameter ? '⌀' : 'R'}: ${fmtLen(value)}`,
  };
}

function lineDir(sketch: Sketch, lineId: string): { x: number; y: number } | null {
  const e = sketch.entities.get(lineId);
  if (e?.type !== 'line') return null;
  const a = point(sketch, e.p1Id);
  const b = point(sketch, e.p2Id);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return null;
  return { x: dx / l, y: dy / l };
}

/**
 * Angle (degrees, 0–180) between two lines, independent of their drawn
 * direction. null if either id is not a usable line.
 */
export function measureAngleBetweenLines(sketch: Sketch, lineAId: string, lineBId: string): Dimension | null {
  const da = lineDir(sketch, lineAId);
  const db = lineDir(sketch, lineBId);
  if (!da || !db) return null;
  const d = Math.max(-1, Math.min(1, Math.abs(da.x * db.x + da.y * db.y)));
  const value = (Math.acos(d) * 180) / Math.PI;
  return { kind: 'angle', entityIds: [lineAId, lineBId], value, label: `∠: ${fmtAng(value)}` };
}

/**
 * The natural ("auto") dimensions of every dimensionable entity in a sketch:
 * a length for each line, a radius for each circle/arc. Useful for a properties
 * panel listing and for the AI to read a sketch's sizes at a glance.
 */
export function listDimensions(sketch: Sketch): Dimension[] {
  const out: Dimension[] = [];
  for (const e of sketch.entities.values() as IterableIterator<SketchEntity>) {
    if (e.type === 'line') {
      const d = measureLineLength(sketch, e.id);
      if (d) out.push(d);
    } else if (e.type === 'circle' || e.type === 'arc') {
      const d = measureRadius(sketch, e.id);
      if (d) out.push(d);
    }
  }
  return out;
}
