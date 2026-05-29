import { describe, it, expect } from 'vitest';
import {
  FeatureTree,
  createSketchFeature,
  createExtrudeFeature,
  createFilletFeature,
  createChamferFeature,
  createShellFeature,
  createLinearArrayFeature,
  createCircularArrayFeature,
  createMirrorFeature,
} from './tree';
import { createSketch, addRectangle } from '../sketch/engine';

/** A standalone extrude feature that produces a box-like body (no parent sketch). */
function boxExtrude() {
  return createExtrudeFeature(
    {
      profile: [
        { x: -5, y: 0, z: -5 },
        { x: 5, y: 0, z: -5 },
        { x: 5, y: 0, z: 5 },
        { x: -5, y: 0, z: 5 },
      ],
      direction: { x: 0, y: 1, z: 0 },
      distance: 10,
    },
    [],
  );
}

describe('FeatureTree', () => {
  it('should start empty', () => {
    const tree = new FeatureTree();
    expect(tree.features.length).toBe(0);
    expect(tree.getLatestBodies().length).toBe(0);
  });

  it('should add features', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    tree.addFeature(feat);
    expect(tree.features.length).toBe(1);
    expect(tree.features[0]?.id).toBe(feat.id);
  });

  it('should remove features', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    tree.addFeature(feat);
    tree.removeFeature(feat.id);
    expect(tree.features.length).toBe(0);
  });

  it('should recompute and produce bodies from extrude', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);

    const sketchFeat = createSketchFeature(sketch);
    const extrudeFeat = createExtrudeFeature(
      {
        profile: [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 0, z: 10 },
          { x: 0, y: 0, z: 10 },
        ],
        direction: { x: 0, y: 1, z: 0 },
        distance: 5,
      },
      [sketchFeat.id],
    );

    tree.addFeature(sketchFeat);
    tree.addFeature(extrudeFeat);
    tree.recompute();

    const bodies = tree.getLatestBodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0]?.vertices.length).toBeGreaterThan(0);
    expect(bodies[0]?.faces.length).toBeGreaterThan(0);
  });

  it('should get feature by id', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    tree.addFeature(feat);
    expect(tree.getFeature(feat.id)).toBeDefined();
    expect(tree.getFeature('nonexistent')).toBeUndefined();
  });

  it('should get result by id', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    tree.addFeature(feat);
    tree.recompute();
    expect(tree.getResult(feat.id)).toBeDefined();
  });

  it('should handle suppressed features', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    feat.suppressed = true;
    tree.addFeature(feat);
    tree.recompute();
    // Suppressed features should not produce results
    expect(tree.getResult(feat.id)).toBeUndefined();
  });

  it('fillet consumes its parent body (output stays a single solid)', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.recompute();
    const baseEdges = tree.getResult(ext.id)!.bodies[0]!.edges.slice(0, 4).map((e) => e.id);

    const fillet = createFilletFeature(baseEdges, 0.5, [ext.id]);
    tree.addFeature(fillet);
    tree.recompute();

    const bodies = tree.getLatestBodies();
    // The extrude body is consumed by the fillet — only one body remains.
    expect(bodies.length).toBe(1);
    expect(tree.getResult(fillet.id)?.bodies.length).toBe(1);
  });

  it('chamfer and shell evaluate without error', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.recompute();
    const body = tree.getResult(ext.id)!.bodies[0]!;

    const chamfer = createChamferFeature(body.edges.slice(0, 2).map((e) => e.id), 0.5, [ext.id]);
    tree.addFeature(chamfer);
    tree.recompute();
    expect(tree.getResult(chamfer.id)?.error).toBeUndefined();
    expect(tree.getLatestBodies().length).toBe(1);

    const shell = createShellFeature(body.faces.slice(0, 1).map((f) => f.id), 1, [chamfer.id]);
    tree.addFeature(shell);
    tree.recompute();
    expect(tree.getResult(shell.id)?.error).toBeUndefined();
    // chamfer→shell chain still yields a single output solid.
    expect(tree.getLatestBodies().length).toBe(1);
  });

  it('records an error when a fillet has no parent body', () => {
    const tree = new FeatureTree();
    const fillet = createFilletFeature([], 1, ['missing']);
    tree.addFeature(fillet);
    tree.recompute();
    expect(tree.getResult(fillet.id)?.error).toContain('parent body');
  });

  it('linear array produces N instances and consumes the parent', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    const arr = createLinearArrayFeature({ x: 1, y: 0, z: 0 }, 4, 20, [ext.id]);
    tree.addFeature(arr);
    tree.recompute();
    expect(tree.getResult(arr.id)?.bodies.length).toBe(4);
    // Original is consumed; the 4 instances are the only output.
    expect(tree.getLatestBodies().length).toBe(4);
  });

  it('circular array produces N instances', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    const arr = createCircularArrayFeature(
      { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
      6,
      [ext.id],
    );
    tree.addFeature(arr);
    tree.recompute();
    expect(tree.getLatestBodies().length).toBe(6);
  });

  it('mirror keeps the original by default, drops it when asked', () => {
    const plane = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } };

    const keep = new FeatureTree();
    const e1 = boxExtrude();
    keep.addFeature(e1);
    keep.addFeature(createMirrorFeature(plane, [e1.id])); // keepOriginal default true
    keep.recompute();
    expect(keep.getLatestBodies().length).toBe(2);

    const drop = new FeatureTree();
    const e2 = boxExtrude();
    drop.addFeature(e2);
    drop.addFeature(createMirrorFeature(plane, [e2.id], false));
    drop.recompute();
    expect(drop.getLatestBodies().length).toBe(1);
  });
});

describe('createSketchFeature', () => {
  it('should create a sketch feature', () => {
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch);
    expect(feat.type).toBe('sketch');
    expect(feat.name).toContain('Sketch');
    expect(feat.suppressed).toBe(false);
    expect(feat.sketch.planeId).toBe('xy');
  });

  it('should accept parent ids', () => {
    const sketch = createSketch('xy');
    const feat = createSketchFeature(sketch, ['parent1']);
    expect(feat.parentIds).toEqual(['parent1']);
  });
});

describe('createExtrudeFeature', () => {
  it('should create an extrude feature', () => {
    const feat = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 10 },
      ['sketch1'],
    );
    expect(feat.type).toBe('extrude');
    expect(feat.name).toBe('Extrude');
    expect(feat.params.distance).toBe(10);
    expect(feat.parentIds).toEqual(['sketch1']);
  });
});
