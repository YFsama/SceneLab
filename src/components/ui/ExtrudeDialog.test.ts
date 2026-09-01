import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store/app';
import { FeatureTree } from '../../lib/features/tree';
import { createSketch, addRectangle } from '../../lib/sketch/engine';
import { computeVolume, findBoundaryLoops } from '../../lib/geometry/brep';

// Real coverage for the flows the ExtrudeDialog drives: the dialog collects a
// distance + symmetric flag and calls performExtrude — test that store action
// (and its sweep sibling) end to end. Previously this file re-implemented the
// clamp locally and tested the copy.

describe('performExtrude (what the dialog submits to)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      currentSketch: null,
      sketchActive: false,
    });
  });

  const rectangleSketch = () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 5);
    return sketch;
  };

  it('extrudes the current sketch into a parametric feature and a body', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(8, false);
    const s = useStore.getState();
    expect(s.sketchActive).toBe(false);
    expect(s.workspace).toBe('model');
    const types = s.featureTree.features.map((f) => f.type);
    expect(types).toContain('sketch');
    expect(types).toContain('extrude');
    expect(s.bodies).toHaveLength(1);
    expect(computeVolume(s.bodies[0]!)).toBeCloseTo(10 * 5 * 8, 0);
  });

  it('symmetric extrude centers the profile on the sketch plane', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(10, true);
    const body = useStore.getState().bodies[0]!;
    const ys = body.vertices.map((v) => v.y);
    expect(Math.min(...ys)).toBeCloseTo(-5, 3);
    expect(Math.max(...ys)).toBeCloseTo(5, 3);
  });

  it('non-positive distance is refused (no features added)', () => {
    useStore.getState().setCurrentSketch(rectangleSketch());
    useStore.getState().performExtrude(0, false);
    expect(useStore.getState().featureTree.features).toHaveLength(0);
  });
});

describe('performSweep (twisted extrude)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      directBodies: [],
      bodies: [],
      objectIds: [],
      currentSketch: null,
    });
  });

  it('sweeps the sketch profile into a sweep feature with twist', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, -5, -5, 5, 5);
    useStore.getState().setCurrentSketch(sketch);
    useStore.getState().performSweep(20, 90);
    const s = useStore.getState();
    const sweep = s.featureTree.features.find((f) => f.type === 'sweep');
    expect(sweep && sweep.type === 'sweep' && sweep.params.twist).toBeCloseTo(Math.PI / 2, 5);
    expect(s.bodies).toHaveLength(1);
    const body = s.bodies[0]!;
    // The path is subdivided so the 90° twist applies gradually; a bilinear
    // sweep through rotated rings constricts the section, landing between the
    // untwisted prism volume (2000) and a conservative lower bound.
    const volume = computeVolume(body);
    expect(volume).toBeGreaterThan(1500);
    expect(volume).toBeLessThanOrEqual(2000 + 1e-6);
    // Watertight despite the twist.
    expect(findBoundaryLoops(body).loops.length).toBe(0);
  });
});
