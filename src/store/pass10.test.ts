import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree } from '../lib/features/tree';
import { createSketch, addLine, addCircle } from '../lib/sketch/engine';
import { computeBoundingBox } from '../lib/geometry';

describe('store — Pass #10 (sketch resize / section analysis / paste-in-place)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [], directBodies: [], objectIds: [], selectedIds: [],
      undoStack: [], redoStack: [],
      clipboard: [], pasteCount: 0,
      sectionAnalysis: { active: false, axis: 'z', offset: 0, flip: false },
      currentSketch: null, sketchActive: false, sketchUndoStack: [], sketchRedoStack: [],
    });
  });

  describe('resizeSketchLine', () => {
    it('resizes a line about its midpoint, keeping direction', () => {
      const sk = createSketch('xz');
      addLine(sk, 0, 0, 30, 40); // length 50
      useStore.setState({ currentSketch: sk, sketchActive: true });
      const lineId = [...sk.entities.values()].find((e) => e.type === 'line')!.id;
      expect(useStore.getState().resizeSketchLine(lineId, 100)).toBe(true);
      const updated = useStore.getState().currentSketch!;
      const line = [...updated.entities.values()].find((e) => e.id === lineId)!;
      const p1 = updated.entities.get((line as { p1Id: string }).p1Id)!;
      const p2 = updated.entities.get((line as { p2Id: string }).p2Id)!;
      const a = p1 as { x: number; y: number };
      const b = p2 as { x: number; y: number };
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(100, 6);
      // Midpoint preserved at (15, 20).
      expect((a.x + b.x) / 2).toBeCloseTo(15, 6);
      expect((a.y + b.y) / 2).toBeCloseTo(20, 6);
    });

    it('rejects invalid lengths, ids and non-lines', () => {
      const sk = createSketch('xz');
      addLine(sk, 0, 0, 10, 0);
      addCircle(sk, 5, 5, 3);
      useStore.setState({ currentSketch: sk });
      const st = useStore.getState();
      const lineId = [...sk.entities.values()].find((e) => e.type === 'line')!.id;
      const circleId = [...sk.entities.values()].find((e) => e.type === 'circle')!.id;
      expect(st.resizeSketchLine(lineId, 0)).toBe(false);
      expect(st.resizeSketchLine('missing', 10)).toBe(false);
      expect(st.resizeSketchLine(circleId, 10)).toBe(false);
    });
  });

  describe('resizeSketchCircle', () => {
    it('sets the radius, keeping the centre', () => {
      const sk = createSketch('xz');
      addCircle(sk, 2, 3, 5);
      useStore.setState({ currentSketch: sk });
      const circleId = [...sk.entities.values()].find((e) => e.type === 'circle')!.id;
      expect(useStore.getState().resizeSketchCircle(circleId, 9)).toBe(true);
      const updated = useStore.getState().currentSketch!;
      expect((updated.entities.get(circleId) as { radius: number }).radius).toBe(9);
    });

    it('rejects invalid radii and non-round entities', () => {
      const sk = createSketch('xz');
      addLine(sk, 0, 0, 10, 0);
      addCircle(sk, 0, 0, 4);
      useStore.setState({ currentSketch: sk });
      const st = useStore.getState();
      const lineId = [...sk.entities.values()].find((e) => e.type === 'line')!.id;
      const circleId = [...sk.entities.values()].find((e) => e.type === 'circle')!.id;
      expect(st.resizeSketchCircle(circleId, 0)).toBe(false);
      expect(st.resizeSketchCircle(lineId, 5)).toBe(false);
    });
  });

  describe('sectionAnalysis', () => {
    it('defaults to inactive on +Z and merges patches', () => {
      expect(useStore.getState().sectionAnalysis).toEqual({ active: false, axis: 'z', offset: 0, flip: false });
      useStore.getState().setSectionAnalysis({ active: true });
      expect(useStore.getState().sectionAnalysis).toEqual({ active: true, axis: 'z', offset: 0, flip: false });
      useStore.getState().setSectionAnalysis({ axis: 'x', offset: 12.5, flip: true });
      expect(useStore.getState().sectionAnalysis).toEqual({ active: true, axis: 'x', offset: 12.5, flip: true });
    });
  });

  describe('pasteInPlace', () => {
    it('lands copies at the originals exact positions (unlike cascading paste)', () => {
      const id = useStore.getState().addPrimitive('box');
      const original = useStore.getState().directBodies[0]!;
      const before = computeBoundingBox(original);
      useStore.getState().selectObject(id);
      useStore.getState().copySelected();
      useStore.setState({ selectedIds: [] });

      const newIds = useStore.getState().pasteInPlace();
      expect(newIds).toHaveLength(1);
      const copy = useStore.getState().directBodies.find((b) => b.id === newIds[0])!;
      const after = computeBoundingBox(copy);
      expect(after.min.x).toBeCloseTo(before.min.x, 9);
      expect(after.min.z).toBeCloseTo(before.min.z, 9);
      expect(useStore.getState().selectedIds).toContain(newIds[0]);
    });

    it('returns an empty list with an empty clipboard', () => {
      expect(useStore.getState().pasteInPlace()).toEqual([]);
    });
  });
});

describe('store — ground shadows toggle', () => {
  it('defaults on and persists the toggle', () => {
    localStorage.removeItem('scenelab.groundShadows');
    expect(useStore.getState().groundShadows).toBe(true);
    useStore.getState().setGroundShadows(false);
    expect(useStore.getState().groundShadows).toBe(false);
    expect(localStorage.getItem('scenelab.groundShadows')).toBe('false');
    useStore.getState().setGroundShadows(true);
    expect(localStorage.getItem('scenelab.groundShadows')).toBe('true');
  });
});

describe('store — offsetSketchEntity (SolidWorks offset entity)', () => {
  beforeEach(() => {
    const sk = createSketch('xz');
    useStore.setState({
      featureTree: new FeatureTree(), bodies: [], directBodies: [], objectIds: [],
      selectedIds: [], undoStack: [], redoStack: [],
      currentSketch: sk, sketchActive: true, sketchUndoStack: [], sketchRedoStack: [],
      selectedSketchId: null, selectedSketchIds: [],
    });
  });

  it('creates the offset copy, selects it and records one sketch undo entry', () => {
    const sk = useStore.getState().currentSketch!;
    const line = addLine(sk, 0, 0, 10, 0);
    const undoLen = useStore.getState().sketchUndoStack.length;
    const newId = useStore.getState().offsetSketchEntity(line.id, 3);
    expect(newId).toBeTruthy();
    const st = useStore.getState();
    // 2 pts + line, then the copy adds 2 new pts + the offset line.
    expect(st.currentSketch!.entities.size).toBe(6);
    expect(st.selectedSketchId).toBe(newId);
    expect(st.sketchUndoStack.length).toBe(undoLen + 1);
    // Sketch undo restores the pre-offset entity set.
    st.sketchUndo();
    expect(useStore.getState().currentSketch!.entities.size).toBe(3);
  });

  it('failure leaves the sketch and undo stack untouched', () => {
    const sk = useStore.getState().currentSketch!;
    const line = addLine(sk, 0, 0, 10, 0);
    const circle = addCircle(sk, 0, 0, 4);
    const undoLen = useStore.getState().sketchUndoStack.length;
    expect(useStore.getState().offsetSketchEntity('missing', 3)).toBeNull();
    expect(useStore.getState().offsetSketchEntity(circle.id, -10)).toBeNull(); // would collapse
    expect(useStore.getState().offsetSketchEntity(line.id, 0)).toBeNull();
    // line = 2 pts + line, circle = centre pt + circle → 5, unchanged.
    expect(useStore.getState().currentSketch!.entities.size).toBe(5);
    expect(useStore.getState().sketchUndoStack.length).toBe(undoLen);
  });
});
