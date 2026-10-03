import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { createSketch, addLine, addCircle } from '../lib/sketch/engine';

// Store-side coverage for mirrorSelectedSketch (Fusion sketch Mirror): the
// action resolves the multi-selection, delegates the math to the REAL
// lib/sketch/mirror engine (its own suite covers the geometry), wraps it in
// one Ctrl+Z step, selects the copies and drops the snapshot on refusal.

describe('mirrorSelectedSketch', () => {
  beforeEach(() => {
    useStore.setState({
      currentSketch: null,
      selectedSketchId: null,
      selectedSketchIds: [],
      sketchUndoStack: [],
      sketchRedoStack: [],
      sketchActive: false,
      projectDirty: false,
    });
  });

  /** A vertical mirror axis at x = 2 plus one freehand line to its left. */
  function axisAndLine() {
    const sketch = createSketch('xy');
    const axis = addLine(sketch, 2, -5, 2, 5);
    const line = addLine(sketch, 0, 0, 1, 0); // 2 points + 1 line each
    useStore.getState().setCurrentSketch(sketch);
    return { sketch, axis, line };
  }

  const pointAt = (sketch: ReturnType<typeof createSketch>, id: string) => {
    const p = sketch.entities.get(id);
    expect(p?.type).toBe('point');
    return p as { id: string; x: number; y: number };
  };

  it('mirrors the multi-selection about the line, selects the copies, one undo step', () => {
    const { sketch, axis, line } = axisAndLine();
    const before = sketch.entities.size; // axis + line = 6 entities (2 pts each)
    useStore.getState().toggleSketchSelection(line.id);

    expect(useStore.getState().mirrorSelectedSketch(axis.id)).toBe(true);

    const s = useStore.getState();
    // The engine added the reflected copy: 2 fresh points + 1 line.
    expect(s.currentSketch!.entities.size).toBe(before + 3);
    // The copies became the selection.
    expect(s.selectedSketchIds).toHaveLength(1);
    expect(s.selectedSketchId).toBe(s.selectedSketchIds[0]);
    const copy = s.currentSketch!.entities.get(s.selectedSketchIds[0]!)!;
    expect(copy.type).toBe('line');
    // Reflected about x = 2: (0,0)-(1,0) becomes (4,0)-(3,0).
    if (copy.type === 'line') {
      const p1 = pointAt(s.currentSketch!, copy.p1Id);
      const p2 = pointAt(s.currentSketch!, copy.p2Id);
      expect(p1.x).toBeCloseTo(4, 6);
      expect(p1.y).toBeCloseTo(0, 6);
      expect(p2.x).toBeCloseTo(3, 6);
      expect(p2.y).toBeCloseTo(0, 6);
    }
    expect(s.projectDirty).toBe(true);
    // Exactly one sketch-undo entry; Ctrl+Z removes the copy again.
    expect(s.sketchUndoStack).toHaveLength(1);
    useStore.getState().sketchUndo();
    expect(useStore.getState().currentSketch!.entities.size).toBe(before);
  });

  it('falls back to the primary selection when the multi-selection is empty', () => {
    const { axis, line } = axisAndLine();
    useStore.getState().setSelectedSketchId(line.id);
    expect(useStore.getState().mirrorSelectedSketch(axis.id)).toBe(true);
    expect(useStore.getState().selectedSketchIds).toHaveLength(1);
  });

  it('mirrors every entity in the multi-selection (group mirror)', () => {
    const { sketch, axis } = axisAndLine();
    const circle = addCircle(sketch, 0, 2, 1); // centre (0,2) r=1, left of x=2
    useStore.getState().setCurrentSketch(sketch); // republish after the direct add
    useStore.getState().toggleSketchSelection(circle.id);
    // Find the freehand line entity (not the axis) and add it to the selection.
    const lineId = [...sketch.entities.values()].find(
      (e) => e.type === 'line' && e.id !== axis.id,
    )!.id;
    useStore.getState().toggleSketchSelection(lineId);

    expect(useStore.getState().mirrorSelectedSketch(axis.id)).toBe(true);
    const s = useStore.getState();
    expect(s.selectedSketchIds).toHaveLength(2); // mirrored circle + line
    const types = s.selectedSketchIds.map((id) => s.currentSketch!.entities.get(id)!.type);
    expect(types).toContain('circle');
    expect(types).toContain('line');
    // The circle's copy is centred at the reflected centre (4,2) with r = 1.
    const circleCopy = s.currentSketch!.entities.get(
      s.selectedSketchIds.find((id) => s.currentSketch!.entities.get(id)!.type === 'circle')!,
    )!;
    if (circleCopy.type === 'circle') {
      expect(circleCopy.radius).toBeCloseTo(1, 6);
      const c = pointAt(s.currentSketch!, circleCopy.centerId);
      expect(c.x).toBeCloseTo(4, 6);
      expect(c.y).toBeCloseTo(2, 6);
    }
  });

  it('refuses without mutating when the axis is not a line (undo entry dropped)', () => {
    const { sketch, line } = axisAndLine();
    const circle = addCircle(sketch, -4, 0, 1);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().toggleSketchSelection(line.id);
    const before = sketch.entities.size;

    expect(useStore.getState().mirrorSelectedSketch(circle.id)).toBe(false);

    const s = useStore.getState();
    expect(s.currentSketch!.entities.size).toBe(before); // nothing was added
    expect(s.sketchUndoStack).toHaveLength(0); // the pre-mirror snapshot was dropped
    expect(s.projectDirty).toBe(false);
  });

  it('returns false with no sketch, no selection, or an unknown axis', () => {
    useStore.getState().setCurrentSketch(null);
    expect(useStore.getState().mirrorSelectedSketch('whatever')).toBe(false);

    const { sketch } = axisAndLine();
    expect(useStore.getState().mirrorSelectedSketch('missing-axis')).toBe(false);
    expect(sketch.entities.size).toBe(6); // untouched

    useStore.getState().setCurrentSketch(null);
    const empty = createSketch('xy');
    addLine(empty, 0, 0, 1, 1);
    useStore.getState().setCurrentSketch(empty);
    expect(useStore.getState().mirrorSelectedSketch('axis-id')).toBe(false); // nothing selected
  });
});
