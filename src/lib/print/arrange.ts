import type { SolidBody } from '../geometry/types';
import { computeBoundingBox, translateBody } from '../geometry';

export interface ArrangeResult {
  /** The bodies translated into non-overlapping grid slots, seated on the bed. */
  bodies: SolidBody[];
  /** Whether every body fits within the bed footprint. */
  fits: boolean;
  /** Footprint actually used (mm). */
  usedX: number;
  usedZ: number;
}

/**
 * Lay bodies out on the build plate with shelf (row) packing: place them
 * left-to-right, wrap to a new row when the bed width is exceeded, and seat each
 * on the bed (min Y = 0). Items are kept `spacing` mm apart. Reports whether the
 * arrangement fits inside bedX × bedZ.
 *
 * Bodies are packed in order of decreasing depth (Next-Fit Decreasing Height) so
 * each row groups similar depths and wastes less of the bed — a large
 * improvement over packing in arbitrary order. Pass `sort: false` to keep the
 * given order.
 */
export function arrangeOnPlate(
  bodies: SolidBody[],
  bedX: number,
  bedZ: number,
  spacing = 5,
  sort = true,
): ArrangeResult {
  const placed: SolidBody[] = [];
  let cursorX = 0;
  let cursorZ = 0;
  let rowDepth = 0;
  let usedX = 0;

  const order = sort
    ? [...bodies].sort((a, b) => {
        const da = computeBoundingBox(a);
        const db = computeBoundingBox(b);
        return db.max.z - db.min.z - (da.max.z - da.min.z);
      })
    : bodies;

  for (const body of order) {
    const bb = computeBoundingBox(body);
    const w = bb.max.x - bb.min.x;
    const d = bb.max.z - bb.min.z;

    // Wrap to a new row if this body would overflow the bed width.
    if (cursorX > 0 && cursorX + w > bedX) {
      cursorX = 0;
      cursorZ += rowDepth + spacing;
      rowDepth = 0;
    }

    placed.push(
      translateBody(body, { x: cursorX - bb.min.x, y: -bb.min.y, z: cursorZ - bb.min.z }),
    );

    cursorX += w + spacing;
    rowDepth = Math.max(rowDepth, d);
    usedX = Math.max(usedX, cursorX - spacing);
  }

  const usedZ = cursorZ + rowDepth;
  return { bodies: placed, fits: usedX <= bedX + 1e-9 && usedZ <= bedZ + 1e-9, usedX, usedZ };
}
