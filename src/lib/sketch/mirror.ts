// Sketch Mirror (SolidWorks' sketch MIRROR parity): reflect the selected
// entities about a line entity — the infinite axis through its two endpoint
// points — and ADD the reflected copies; the originals stay put. Mirrored
// LINES share junction point ids among the copies (the engine's
// addLineBetween convention — offset's loop copies and the rectangle tool's
// frame build the same shape), and a copy endpoint landing on an existing
// point reuses its id, so a half profile drawn against the axis closes into
// one chained profile. Circles/arcs copy about their mirrored centre with a
// fresh centre point (offset/trim convention — centres are not junctions).
// Construction flags carry. The mirror line itself, when selected, is
// skipped: it is the axis, so reflecting it about itself is a no-op copy.
//
// Like trim/offset this MUTATES the passed sketch; the store re-publishes it.
import type { Sketch, SketchEntity, Vec2 } from './types';
import { addPoint, addLineBetween, addCircle, addArc } from './engine';

/** Junction-identity precision — the same 6-decimal position-key convention
 * as trim.ts/offset.ts (freehand segments never share point ids). */
const posKey = (p: Vec2): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
/** Below this length an axis (or a line to copy) has no usable direction. */
const MIN_LEN = 1e-9;
/** A circle/arc copy must keep at least this radius (mm), like offset. */
const MIN_RADIUS = 1e-9;

/**
 * Resolve the mirror axis line for a selection — the toolbar's interaction
 * rule for SolidWorks' sketch MIRROR (pure; the toolbar renders the state):
 *  1. exactly one line IN the selection → that line is the axis;
 *  2. no line in the selection → the sketch's ONLY line, when there is
 *     exactly one, is used automatically (toast-free);
 *  3. anything else → null: the axis is ambiguous (2+ lines selected, or no
 *     line selected and 0/2+ lines in the sketch) or the selection is empty /
 *     entirely stale ids — the UI then disables with the "mirror about line"
 *     hint (multi-select entities + a mirror line).
 */
export function resolveMirrorAxis(
  sketch: Sketch | null,
  selectionIds: readonly string[],
): string | null {
  if (!sketch) return null;
  const valid = selectionIds.filter((id) => sketch.entities.has(id));
  if (valid.length === 0) return null;
  const selectedLines = valid.filter((id) => sketch.entities.get(id)?.type === 'line');
  if (selectedLines.length === 1) return selectedLines[0]!;
  if (selectedLines.length > 1) return null; // which one is the axis?
  const sketchLines = [...sketch.entities.values()]
    .filter((e) => e.type === 'line')
    .map((e) => e.id);
  return sketchLines.length === 1 ? sketchLines[0]! : null;
}

/**
 * Reflect the given entities of `sketch` about the line `mirrorLineId` (its
 * two endpoint points, extended to an infinite axis) and add the copies.
 * Returns the new entity ids (selection order; a rectangle entity copies as
 * its 4 edge lines), or null — WITHOUT mutating — when the axis is missing /
 * not a line / degenerate, or when nothing mirrorable remains after skipping
 * unknown ids, the axis itself, and unresolvable entities (skip-and-continue:
 * SOME valid ids mirror, only NONE refuses).
 *
 * Store action contract — implemented in store/app.ts as
 * `mirrorSelectedSketch(mirrorLineId: string): boolean`:
 * 1. `const sketch = get().currentSketch;` — return false when there is none.
 * 2. Targets = `selectedSketchIds` when non-empty, else `[selectedSketchId]`
 *    when set, else return false (the same selection resolution as
 *    offsetSelectedSketch / trimSketchAt).
 * 3. `pushSketchUndo()` FIRST, so the mirror is one Ctrl+Z step.
 * 4. `const newIds = mirrorSketchEntities(sketch, targets, mirrorLineId);`
 * 5. On null (refused — the engine mutated nothing): drop the just-pushed
 *    snapshot, `set((s) => ({ sketchUndoStack: s.sketchUndoStack.slice(0, -1) }))`,
 *    and return false.
 * 6. On success: `set({ currentSketch: { ...sketch }, selectedSketchId:
 *    newIds[0] ?? null, selectedSketchIds: newIds, projectDirty: true })` —
 *    the copies become the selection — and return true.
 */
export function mirrorSketchEntities(
  sketch: Sketch,
  entityIds: readonly string[],
  mirrorLineId: string,
): string[] | null {
  // --- Axis resolution (pure reads — a refusal must not mutate) -----------
  const axis = sketch.entities.get(mirrorLineId);
  if (axis?.type !== 'line') return null;
  const aP = sketch.entities.get(axis.p1Id);
  const bP = sketch.entities.get(axis.p2Id);
  if (aP?.type !== 'point' || bP?.type !== 'point') return null;
  const a = { x: aP.x, y: aP.y };
  const axisLen = Math.hypot(bP.x - a.x, bP.y - a.y);
  if (axisLen < MIN_LEN) return null; // degenerate axis — no direction to reflect about
  const dir = { x: (bP.x - a.x) / axisLen, y: (bP.y - a.y) / axisLen };
  // Angles reflect to their conjugate about the axis direction angle.
  const axisAngle = Math.atan2(dir.y, dir.x);

  const pointOf = (pid: string): Vec2 | null => {
    const p = sketch.entities.get(pid);
    return p?.type === 'point' ? { x: p.x, y: p.y } : null;
  };
  /** Reflection isometry about the infinite line through `a` along `dir`. */
  const reflect = (p: Vec2): Vec2 => {
    const vx = p.x - a.x;
    const vy = p.y - a.y;
    const t = vx * dir.x + vy * dir.y;
    return { x: a.x + 2 * t * dir.x - vx, y: a.y + 2 * t * dir.y - vy };
  };
  const reflectAngle = (phi: number): number => 2 * axisAngle - phi;

  // --- Selection filtering: skip the axis / unknown / unresolvable ids ----
  // (skip-and-continue — only an empty remainder refuses).
  const targets: SketchEntity[] = [];
  const seen = new Set<string>();
  for (const id of entityIds) {
    if (id === mirrorLineId) continue; // the axis itself — never copied
    const e = sketch.entities.get(id);
    if (!e || seen.has(e.id)) continue; // unknown id — skipped
    let ok = true;
    if (e.type === 'line') {
      const p1 = pointOf(e.p1Id);
      const p2 = pointOf(e.p2Id);
      // A zero-length line has no direction to mirror — its copy would be a
      // degenerate both-ends-same-point line (see the junction note below).
      ok = !!p1 && !!p2 && Math.hypot(p2.x - p1.x, p2.y - p1.y) >= MIN_LEN;
    } else if (e.type === 'circle' || e.type === 'arc') {
      ok = !!pointOf(e.centerId) && e.radius > MIN_RADIUS;
    } else if (e.type === 'rectangle') {
      ok = [e.p1Id, e.p2Id, e.p3Id, e.p4Id].every((pid) => !!pointOf(pid));
    }
    if (!ok) continue;
    seen.add(e.id);
    targets.push(e);
  }
  if (targets.length === 0) return null;

  // --- Copies (mutation starts here) ---------------------------------------
  // Junction sharing, offset.ts pass #14c convention: every original point id
  // maps to ONE copy point id, so two selected lines that shared a corner
  // still share one after mirroring. A fresh copy position that coincides
  // with an existing point (e.g. an endpoint ON the axis is its own
  // reflection) reuses that id — trim.ts's position-key stitching, which
  // chains copies into existing geometry.
  const copyPointIds = new Map<string, string>();
  const createdIds = new Set<string>();
  const byPos = new Map<string, string>();
  for (const e of sketch.entities.values()) {
    if (e.type === 'point') byPos.set(posKey(e), e.id);
  }
  const mirroredPointId = (pid: string): string => {
    const cached = copyPointIds.get(pid);
    if (cached) return cached;
    const m = reflect(pointOf(pid)!); // resolvable — validated in the filter pass
    const key = posKey(m);
    let id = byPos.get(key);
    if (!id) {
      id = addPoint(sketch, m.x, m.y).id;
      byPos.set(key, id);
      createdIds.add(id);
    }
    copyPointIds.set(pid, id);
    return id;
  };

  const newIds: string[] = [];
  for (const e of targets) {
    switch (e.type) {
      case 'point': {
        // The copy IS the (possibly reused) mirrored point entity. Only a
        // point we created ourselves gets the construction flag — a reused
        // id belongs to existing geometry and must not be re-flagged.
        const pid = mirroredPointId(e.id);
        if (e.construction && createdIds.has(pid)) {
          const copy = sketch.entities.get(pid);
          if (copy?.type === 'point') copy.construction = true;
        }
        newIds.push(pid);
        break;
      }
      case 'line': {
        const p1 = mirroredPointId(e.p1Id);
        const p2 = mirroredPointId(e.p2Id);
        if (p1 === p2) break; // defensive: unreachable after the zero-length filter
        const copy = addLineBetween(sketch, p1, p2);
        if (e.construction) copy.construction = true;
        newIds.push(copy.id);
        break;
      }
      case 'circle': {
        const c = reflect(pointOf(e.centerId)!);
        const copy = addCircle(sketch, c.x, c.y, e.radius);
        if (e.construction) copy.construction = true;
        newIds.push(copy.id);
        break;
      }
      case 'arc': {
        const c = reflect(pointOf(e.centerId)!);
        // WINDING: reflection reverses orientation — the image of the walk
        // start→end sweeps the OPPOSITE way (each angle φ maps to 2θ−φ, so
        // end−start flips sign). We keep the copy's sweep SIGN the same as
        // the original by swapping the two image angles (newStart =
        // reflect(end), newEnd = reflect(start)); the traced point set is
        // identical either way (it is exactly the mirror image of the
        // original span — both parameterizations cover it), and every arc
        // consumer here normalizes or walks the signed sweep
        // (ViewportCanvas's EllipseCurve preview, tree.ts profile
        // extraction), so the copy then behaves exactly like the original.
        const copy = addArc(
          sketch,
          c.x,
          c.y,
          e.radius,
          reflectAngle(e.endAngle),
          reflectAngle(e.startAngle),
        );
        if (e.construction) copy.construction = true;
        newIds.push(copy.id);
        break;
      }
      case 'rectangle': {
        // Legacy rectangle entities (deserialized files) copy as their 4
        // edge lines between the mirrored corners — the shape the rect tool
        // builds (addRectangle), like offset's rectangle branch.
        const corners = [e.p1Id, e.p2Id, e.p3Id, e.p4Id].map(mirroredPointId);
        for (let i = 0; i < 4; i++) {
          const copy = addLineBetween(sketch, corners[i]!, corners[(i + 1) % 4]!);
          if (e.construction) copy.construction = true;
          newIds.push(copy.id);
        }
        break;
      }
    }
  }
  // Coincident selected points share one copy point (byPos) — dedupe those.
  return [...new Set(newIds)];
}
