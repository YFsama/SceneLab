// Constraint glyph badges for the sketch viewport (Fusion/SolidWorks display
// their applied constraints as little icons on the entities — without them a
// sketch's constraints are invisible until something breaks). Pure mapping:
// constraint → anchor position in sketch space + a short glyph string.
import type { Sketch, ConstraintType } from './types';

export interface ConstraintGlyph {
  /** Anchor in sketch coordinates (entity midpoint / centre / shared point). */
  x: number;
  y: number;
  /** Short badge text (H, V, ∥, ⊥, =, ⊙, T, R, ⌀, FIX, D, SYM). */
  text: string;
}

export const CONSTRAINT_GLYPHS: Record<ConstraintType, string> = {
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  coincident: '●',
  fixed: 'FIX',
  equal: '=',
  distance: 'D',
  radius: 'R',
  concentric: '⊙',
  tangent: 'T',
  symmetric: 'SYM',
};

/**
 * One glyph per constraint, anchored at its most meaningful entity: line
 * constraints at the line's midpoint, round constraints at the centre,
 * point constraints at the point, pair constraints at the FIRST entity's
 * anchor. Constraints referencing missing entities are skipped.
 */
export function constraintGlyphs(sketch: Sketch): ConstraintGlyph[] {
  const out: ConstraintGlyph[] = [];
  const midOf = (id: string): { x: number; y: number } | null => {
    const e = sketch.entities.get(id);
    if (!e) return null;
    if (e.type === 'line') {
      const a = sketch.entities.get(e.p1Id);
      const b = sketch.entities.get(e.p2Id);
      if (a?.type === 'point' && b?.type === 'point') return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return null;
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const c = sketch.entities.get(e.centerId);
      if (c?.type === 'point') return { x: c.x, y: c.y };
      return null;
    }
    if (e.type === 'point') return { x: e.x, y: e.y };
    return null;
  };

  for (const c of sketch.constraints.values()) {
    const anchor = c.entityIds.length > 0 ? midOf(c.entityIds[0]!) : null;
    if (anchor) {
      const text = c.type === 'distance' && typeof c.value === 'number'
        ? `D${c.value.toFixed(1)}`
        : CONSTRAINT_GLYPHS[c.type];
      out.push({ x: anchor.x, y: anchor.y, text });
    }
  }
  return out;
}
