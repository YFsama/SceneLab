/**
 * Pick-cycling for overlapping bodies under the cursor.
 *
 * Raycasting returns every body the ray crosses, front-to-back. A plain click
 * normally selects the front-most one, but clicking again at the same spot
 * should reach the body behind it — the "select other" interaction in
 * SolidWorks/Fusion. Given the ordered (front→back) distinct body ids under the
 * cursor and the current selection, this returns the id to select next:
 *
 *  - nothing under the cursor → undefined
 *  - exactly one body selected and it's in the list → the next one (wrapping),
 *    so repeated clicks walk through the stack and loop back to the front
 *  - otherwise → the front-most body
 */
export function pickCycle(orderedIds: string[], selectedIds: string[]): string | undefined {
  if (orderedIds.length === 0) return undefined;
  if (selectedIds.length === 1) {
    const i = orderedIds.indexOf(selectedIds[0]!);
    if (i !== -1) return orderedIds[(i + 1) % orderedIds.length];
  }
  return orderedIds[0];
}

/** De-duplicate ids preserving first (front-most) occurrence order. */
export function distinctInOrder(ids: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
