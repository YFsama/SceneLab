import { describe, it, expect, beforeAll } from 'vitest';
import {
  FeatureTree,
  createSketchFeature,
  createExtrudeFeature,
  createRevolveFeature,
  createFilletFeature,
  createChamferFeature,
  createShellFeature,
  createHoleFeature,
  createLinearArrayFeature,
  createCircularArrayFeature,
  createMirrorFeature,
  createSweepFeature,
  createLoftFeature,
  canReorderFeatures,
  drillHoleInBody,
} from './tree';
import { createSketch, addRectangle, addCircle, addLine } from '../sketch/engine';
import { computeVolume, computeBoundingBox } from '../geometry/brep';
import { warmUpBooleanEngine, isManifoldEngineReady } from '../geometry/boolean';
import { __resetManifoldEngineForTests } from '../geometry/booleanManifold';
import type { SweepFeature, LoftFeature, HoleFeature, ExtrudeFeature } from './types';
import { serializeProject, deserializeFeatures, saveToFile, loadFromFile } from '../io/studio3d';

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

  it('re-evaluates geometry when a feature parameter is edited', () => {
    // The extrude/revolve edit dialogs drive updateFeature + recompute; this
    // locks that the edited parameter actually changes the resulting body.
    const tree = new FeatureTree();
    const ext = boxExtrude(); // 10×10 profile × distance 10 → volume 1000
    tree.addFeature(ext);
    tree.recompute();
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeCloseTo(1000, 3);

    tree.updateFeature(ext.id, (f) =>
      f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 20 } } : f,
    );
    tree.recompute();
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeCloseTo(2000, 3);
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

  it('drills a through hole: volume drops by ~πr²·depth of the box', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude(); // 10×10×10, volume 1000, top face at y = 10
    tree.addFeature(ext);
    tree.recompute();
    const before = Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    expect(before).toBeCloseTo(1000, 3);

    const hole = createHoleFeature(
      {
        center: { x: 0, y: 10, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
        diameter: 4,
        depth: null, // through-all
      },
      [ext.id],
    );
    tree.addFeature(hole);
    tree.recompute();

    // The hole consumes its parent — exactly one output body.
    expect(tree.getLatestBodies()).toHaveLength(1);
    expect(tree.getResult(hole.id)?.bodies).toHaveLength(1);
    const removed = before - Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    const ideal = Math.PI * 2 * 2 * 10; // πr²·h
    // Voxel/exact boolean tolerance ±10%.
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('drills a blind hole to the requested depth', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.recompute();
    const before = Math.abs(computeVolume(tree.getLatestBodies()[0]!));

    tree.addFeature(createHoleFeature(
      {
        center: { x: 0, y: 10, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
        diameter: 4,
        depth: 5,
      },
      [ext.id],
    ));
    tree.recompute();

    const removed = before - Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    const ideal = Math.PI * 2 * 2 * 5; // πr²·depth
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('suppressing the hole restores the parent body', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.recompute();
    const hole = createHoleFeature(
      { center: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: null },
      [ext.id],
    );
    tree.addFeature(hole);
    tree.recompute();
    const drilled = Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    expect(drilled).toBeLessThan(1000);

    tree.updateFeature(hole.id, (f) => ({ ...f, suppressed: true }));
    tree.recompute();
    // Suppressed hole → the unconsumed extrude body is the only output again.
    expect(tree.getLatestBodies()).toHaveLength(1);
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeCloseTo(1000, 3);
  });

  it('records an error when a hole has no parent body', () => {
    const tree = new FeatureTree();
    tree.addFeature(createHoleFeature(
      { center: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: null },
      ['missing'],
    ));
    tree.recompute();
    expect(tree.getResult(tree.features[0]!.id)?.error).toContain('parent body');
  });

  it('hole feature survives a studio3d project round-trip', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      { center: { x: 1, y: 10, z: -2 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth: 3 },
      [ext.id],
    ));
    const json = saveToFile(serializeProject('Part', tree.features, []));
    const features = deserializeFeatures(loadFromFile(json));
    expect(features.map((f) => f.type)).toEqual(['extrude', 'hole']);
    const hole = features[1] as HoleFeature;
    expect(hole.params.diameter).toBe(6);
    expect(hole.params.depth).toBe(3);
    expect(hole.params.center).toEqual({ x: 1, y: 10, z: -2 });
    expect(hole.params.direction).toEqual({ x: 0, y: -1, z: 0 });
    expect(hole.parentIds).toEqual([ext.id]);
  });

  it('counterbore/countersink params survive a studio3d round-trip', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      {
        center: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth: null,
        counterbore: { diameter: 10, depth: 3 },
      },
      [ext.id],
    ));
    tree.addFeature(createHoleFeature(
      {
        center: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth: null,
        countersink: { diameter: 10, angleDeg: 90 },
      },
      ['missing'],
    ));
    const json = saveToFile(serializeProject('Part', tree.features, []));
    const features = deserializeFeatures(loadFromFile(json));
    const cbHole = features[1] as HoleFeature;
    expect(cbHole.params.counterbore).toEqual({ diameter: 10, depth: 3 });
    const csHole = features[2] as HoleFeature;
    expect(csHole.params.countersink).toEqual({ diameter: 10, angleDeg: 90 });
  });

  it('extrudes a sketched circle into a cylinder', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    addCircle(sketch, 0, 0, 5); // radius 5
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 10 },
      [sf.id],
    );
    tree.addFeature(sf);
    tree.addFeature(ef);
    tree.recompute();

    const bodies = tree.getLatestBodies();
    expect(bodies).toHaveLength(1);
    const ideal = Math.PI * 25 * 10; // πr²·h ≈ 785.4
    const vol = Math.abs(computeVolume(bodies[0]!));
    expect(vol).toBeGreaterThan(ideal * 0.97);
    expect(vol).toBeLessThanOrEqual(ideal + 1e-6);
  });

  it('extrudes a square drawn as four lines added out of order', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
    // Add the four edges of a 10×10 square in a shuffled order. Naive endpoint
    // concatenation would produce a self-intersecting profile; chaining fixes it.
    addLine(sketch, 0, 0, 10, 0); // bottom
    addLine(sketch, 0, 10, 0, 0); // left (reversed)
    addLine(sketch, 10, 0, 10, 10); // right
    addLine(sketch, 10, 10, 0, 10); // top
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 5 },
      [sf.id],
    );
    tree.addFeature(sf);
    tree.addFeature(ef);
    tree.recompute();

    const bodies = tree.getLatestBodies();
    expect(bodies).toHaveLength(1);
    // A correct (non-bowtie) square profile → 10·10·5 = 500.
    expect(Math.abs(computeVolume(bodies[0]!))).toBeCloseTo(500, 3);
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

describe('createRevolveFeature', () => {
  it('should create a revolve feature', () => {
    const feat = createRevolveFeature(360, ['sketch1']);
    expect(feat.type).toBe('revolve');
    expect(feat.name).toBe('Revolve');
    expect(feat.params.angle).toBe(360);
    expect(feat.parentIds).toEqual(['sketch1']);
  });

  it('should create a partial revolve feature', () => {
    const feat = createRevolveFeature(180, ['sketch2']);
    expect(feat.params.angle).toBe(180);
  });

  it('should evaluate a revolve from a circle sketch', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xz');
    // Draw a circle offset from the world Z-axis (the xz plane's revolve axis
    // since revolve became plane-aware).
    addCircle(sketch, 5, 5, 2);
    const sketchFeat = createSketchFeature(sketch);
    tree.addFeature(sketchFeat);
    const revolveFeat = createRevolveFeature(360, [sketchFeat.id]);
    tree.addFeature(revolveFeat);
    tree.recompute();
    const bodies = tree.getLatestBodies();
    expect(bodies.length).toBe(1);
    expect(Math.abs(computeVolume(bodies[0]!))).toBeGreaterThan(0);
  });
});

describe('sweep and loft features', () => {
  // 2D profile for sweep (sketch coordinates, like extrude profiles).
  const squareProfile = [
    { x: -5, y: -5 }, { x: 5, y: -5 },
    { x: 5, y: 5 }, { x: -5, y: 5 },
  ];
  // 3D sections for loft.
  const squareSection = (half: number, y: number) => [
    { x: -half, y, z: -half }, { x: half, y, z: -half },
    { x: half, y, z: half }, { x: -half, y, z: half },
  ];

  it('sweep feature extrudes along its path (untwisted = prism volume)', () => {
    const tree = new FeatureTree();
    tree.addFeature(createSweepFeature(
      { path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }], twist: 0, profile: squareProfile },
      [],
    ));
    tree.recompute();
    const result = tree.getResult(tree.features[0]!.id)!;
    expect(result.error).toBeUndefined();
    expect(computeVolume(result.bodies[0]!)).toBeCloseTo(100 * 20, 0);
  });

  it('sweep without a profile throws a clear error', () => {
    const tree = new FeatureTree();
    tree.addFeature(createSweepFeature({ path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }], twist: 0 }, []));
    tree.recompute();
    expect(tree.getResult(tree.features[0]!.id)!.error).toBeTruthy();
  });

  it('loft feature skins between explicit sections', () => {
    const tree = new FeatureTree();
    tree.addFeature(createLoftFeature({
      sections: [squareSection(5, 0), squareSection(3, 20)],
    }));
    tree.recompute();
    const result = tree.getResult(tree.features[0]!.id)!;
    expect(result.error).toBeUndefined();
    // Frustum between 10x10 and 6x6 over height 20.
    const v = (20 / 3) * (100 + 36 + 60);
    expect(computeVolume(result.bodies[0]!)).toBeCloseTo(v, 0);
  });

  it('loft with fewer than two usable sections reports an error', () => {
    const tree = new FeatureTree();
    tree.addFeature(createLoftFeature({ sections: [squareSection(5, 0)] }));
    tree.recompute();
    expect(tree.getResult(tree.features[0]!.id)!.error).toBeTruthy();
  });

  it('sweep and loft features survive a project round-trip', () => {
    const tree = new FeatureTree();
    tree.addFeature(createSweepFeature(
      { path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }], twist: Math.PI, profile: squareProfile },
      [],
    ));
    tree.addFeature(createLoftFeature({ sections: [squareSection(5, 0), squareSection(5, 20)] }));
    const json = saveToFile(serializeProject('Part', tree.features, []));
    const features = deserializeFeatures(loadFromFile(json));
    expect(features.map((f) => f.type)).toEqual(['sweep', 'loft']);
    const sweep = features[0] as SweepFeature;
    expect(sweep.params.twist).toBeCloseTo(Math.PI, 6);
    expect(sweep.params.path).toHaveLength(2);
    const loft = features[1] as LoftFeature;
    expect(loft.params.sections).toHaveLength(2);
  });
});

describe('incremental recompute', () => {
  function boxExtrudeFeature(height: number) {
    return createExtrudeFeature(
      {
        profile: [
          { x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 },
          { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 },
        ],
        direction: { x: 0, y: 1, z: 0 },
        distance: height,
        symmetric: false,
      },
      [],
    );
  }

  it('reuses body references for unchanged features across recomputes', () => {
    const tree = new FeatureTree();
    tree.addFeature(boxExtrudeFeature(10));
    tree.recompute();
    const first = tree.getLatestBodies()[0]!;
    tree.recompute();
    const second = tree.getLatestBodies()[0]!;
    // Same object → the viewport mesh cache can skip rebuilding this body.
    expect(second).toBe(first);
  });

  it('re-evaluates only the edited feature and its dependents', () => {
    const tree = new FeatureTree();
    const base = boxExtrudeFeature(10);
    tree.addFeature(base);
    tree.addFeature(createFilletFeature([], 1, [base.id]));
    tree.recompute();
    const baseBody1 = tree.getResult(base.id)!.bodies[0]!;
    const fillet1 = tree.getResult(tree.features[1]!.id)!.bodies[0]!;

    // Edit the base feature — both must re-evaluate.
    tree.updateFeature(base.id, (f) =>
      f.type === 'extrude' ? { ...f, params: { ...f.params, distance: 20 } } : f,
    );
    tree.recompute();
    const baseBody2 = tree.getResult(base.id)!.bodies[0]!;
    const fillet2 = tree.getResult(tree.features[1]!.id)!.bodies[0]!;
    expect(baseBody2).not.toBe(baseBody1);
    expect(fillet2).not.toBe(fillet1);
    expect(computeVolume(baseBody2)).toBeCloseTo(2000, 0);
    // The arc-segment fillet overlays material on the original faces, so the
    // volume lands slightly above the exact prism volume.
    expect(computeVolume(fillet2)).toBeCloseTo(2000, -2);

    // Unrelated recompute keeps both reused again.
    tree.recompute();
    expect(tree.getResult(base.id)!.bodies[0]).toBe(baseBody2);
    expect(tree.getResult(tree.features[1]!.id)!.bodies[0]).toBe(fillet2);
  });

  it('replays a downstream feature when a parent flips validity', () => {
    const tree = new FeatureTree();
    const base = boxExtrudeFeature(10);
    const child = createFilletFeature([], 1, [base.id]);
    tree.addFeature(base);
    tree.addFeature(child);
    tree.recompute();
    expect(tree.getResult(child.id)!.bodies.length).toBe(1);
    // Suppress the base — the child's parent result disappears → re-evaluated to an error.
    tree.updateFeature(base.id, (f) => ({ ...f, suppressed: true }));
    tree.recompute();
    expect(tree.getResult(child.id)!.error).toBeTruthy();
  });
});

describe('timeline drag-reorder', () => {
  it('moves an independent feature and reorders the evaluation order', () => {
    const tree = new FeatureTree();
    const a = boxExtrude();
    const b = boxExtrude();
    const c = boxExtrude();
    tree.addFeature(a);
    tree.addFeature(b);
    tree.addFeature(c);
    expect(tree.moveFeature(c.id, 0)).toBe(true);
    expect(tree.features.map((f) => f.id)).toEqual([c.id, a.id, b.id]);
  });

  it('refuses to move a feature before its parent', () => {
    const tree = new FeatureTree();
    const base = boxExtrude();
    const child = createFilletFeature([], 1, [base.id]);
    tree.addFeature(base);
    tree.addFeature(child);
    expect(tree.moveFeature(child.id, 0)).toBe(false);
    expect(tree.features.map((f) => f.id)).toEqual([base.id, child.id]);
  });

  it('refuses to move a feature after its dependent', () => {
    const tree = new FeatureTree();
    const base = boxExtrude();
    const child = createFilletFeature([], 1, [base.id]);
    tree.addFeature(base);
    tree.addFeature(child);
    // Moving the parent to the end would put it after the fillet that consumes it.
    expect(tree.moveFeature(base.id, 1)).toBe(false);
    expect(tree.features.map((f) => f.id)).toEqual([base.id, child.id]);
  });

  it('clamps out-of-range targets and treats a same-place move as a no-op', () => {
    const tree = new FeatureTree();
    const a = boxExtrude();
    const b = boxExtrude();
    tree.addFeature(a);
    tree.addFeature(b);
    expect(tree.moveFeature(a.id, 99)).toBe(true); // clamped to the end
    expect(tree.features.map((f) => f.id)).toEqual([b.id, a.id]);
    expect(tree.moveFeature(a.id, 1)).toBe(false); // already there (from 1 → 1)
    expect(tree.moveFeature(a.id, -5)).toBe(true); // clamps back to the front
    expect(tree.features.map((f) => f.id)).toEqual([a.id, b.id]);
    expect(tree.moveFeature('missing', 0)).toBe(false);
  });

  it('reorder keeps bodies valid and reuses memoized results', () => {
    const tree = new FeatureTree();
    const base = boxExtrude();
    const child = createFilletFeature([], 1, [base.id]);
    tree.addFeature(base);
    tree.addFeature(child);
    tree.recompute();
    const baseBody = tree.getResult(base.id)!.bodies[0]!;
    const childBody = tree.getResult(child.id)!.bodies[0]!;
    expect(tree.moveFeature(base.id, 0)).toBe(false); // dependency-guarded, nothing changes
    tree.recompute();
    expect(tree.getResult(base.id)!.bodies[0]).toBe(baseBody);
    expect(tree.getResult(child.id)!.bodies[0]).toBe(childBody);
  });

  it('canReorderFeatures mirrors moveFeature legality (pure, no mutation)', () => {
    const tree = new FeatureTree();
    const base = boxExtrude();
    const child = createFilletFeature([], 1, [base.id]);
    const tail = boxExtrude();
    tree.addFeature(base);
    tree.addFeature(child);
    tree.addFeature(tail);
    const before = [...tree.features];
    expect(canReorderFeatures(tree.features, child.id, 0)).toBe(false);
    expect(canReorderFeatures(tree.features, base.id, 2)).toBe(false);
    expect(canReorderFeatures(tree.features, tail.id, 0)).toBe(true);
    expect(canReorderFeatures(tree.features, base.id, 0)).toBe(true);
    expect(tree.features).toEqual(before); // pure check, order untouched
  });
});

/** A standalone 20×20×20 extrude (top face at y = 20) for the cb/cs volume math. */
function boxExtrude20() {
  return createExtrudeFeature(
    {
      profile: [
        { x: -10, y: 0, z: -10 },
        { x: 10, y: 0, z: -10 },
        { x: 10, y: 0, z: 10 },
        { x: -10, y: 0, z: 10 },
      ],
      direction: { x: 0, y: 1, z: 0 },
      distance: 20,
    },
    [],
  );
}

describe('hole counterbore/countersink evaluator', () => {
  // The runtime app always has the exact Manifold engine warm; do the same
  // here so the volume math is measured against the exact boolean, not the
  // blocky (and slow) voxel fallback.
  beforeAll(() => warmUpBooleanEngine());

  /** Build a 20mm box, drill `params` from the top-face centre, return the removed volume. */
  function removedVolume(params: HoleFeature['params']): number {
    const tree = new FeatureTree();
    const ext = boxExtrude20();
    tree.addFeature(ext);
    tree.recompute();
    const before = Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    expect(before).toBeCloseTo(8000, 3);

    tree.addFeature(createHoleFeature(params, [ext.id]));
    tree.recompute();
    expect(tree.getResult(tree.features[1]!.id)?.error).toBeUndefined();
    expect(tree.getLatestBodies()).toHaveLength(1);
    return before - Math.abs(computeVolume(tree.getLatestBodies()[0]!));
  }

  const entry = { center: { x: 0, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 } };

  it('counterbore: removed volume ≈ through cylinder + counterbore ring (±10%)', () => {
    const removed = removedVolume({
      ...entry,
      diameter: 6,
      depth: null, // through-all
      counterbore: { diameter: 10, depth: 3 },
    });
    // The exact union of both cutters: the ⌀6 cylinder through the full 20mm
    // plus the ⌀10×3 counterbore MINUS the ⌀6 part it already removed.
    const ideal = Math.PI * 3 * 3 * 20 + (Math.PI * 5 * 5 * 3 - Math.PI * 3 * 3 * 3);
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('countersink: removed volume ≈ through cylinder + frustum − overlap (±10%)', () => {
    const removed = removedVolume({
      ...entry,
      diameter: 6,
      depth: null,
      countersink: { diameter: 10, angleDeg: 90 },
    });
    // Cone depth: (10 − 6)/2 / tan(45°) = 2 mm. Truncated-cone volume
    // V = πh/3·(R² + Rr + r²), minus the ⌀6 cylinder it overlaps.
    const frustum = ((Math.PI * 2) / 3) * (5 * 5 + 5 * 3 + 3 * 3);
    const ideal = Math.PI * 3 * 3 * 20 + (frustum - Math.PI * 3 * 3 * 2);
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('countersink honours a non-90° included angle', () => {
    const removed = removedVolume({
      ...entry,
      diameter: 6,
      depth: null,
      countersink: { diameter: 12, angleDeg: 60 },
    });
    // Depth: (12 − 6)/2 / tan(30°) = 3 / 0.5774 ≈ 5.196 mm.
    const h = 3 / Math.tan(Math.PI / 6);
    const frustum = ((Math.PI * h) / 3) * (6 * 6 + 6 * 3 + 3 * 3);
    const ideal = Math.PI * 3 * 3 * 20 + (frustum - Math.PI * 3 * 3 * h);
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('prefers the counterbore when both counterbore and countersink are present', () => {
    // The countersink band (⌀8 90°) and the counterbore band (⌀10×3) are >10%
    // apart, so the tolerance itself proves which cutter ran.
    const removed = removedVolume({
      ...entry,
      diameter: 6,
      depth: null,
      counterbore: { diameter: 10, depth: 3 },
      countersink: { diameter: 8, angleDeg: 90 },
    });
    const ideal = Math.PI * 3 * 3 * 20 + (Math.PI * 5 * 5 * 3 - Math.PI * 3 * 3 * 3);
    expect(removed).toBeGreaterThan(ideal * 0.9);
    expect(removed).toBeLessThan(ideal * 1.1);
  });

  it('records an error when the counterbore is not wider than the hole', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude20();
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      { ...entry, diameter: 6, depth: null, counterbore: { diameter: 6, depth: 2 } },
      [ext.id],
    ));
    tree.recompute();
    expect(tree.getResult(tree.features[1]!.id)?.error).toContain('Counterbore');
  });

  it('records an error when the countersink is not wider than the hole', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude20();
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      { ...entry, diameter: 6, depth: null, countersink: { diameter: 4, angleDeg: 90 } },
      [ext.id],
    ));
    tree.recompute();
    expect(tree.getResult(tree.features[1]!.id)?.error).toContain('Countersink');
  });
});

describe('hole failure honesty (miss probe)', () => {
  beforeAll(() => warmUpBooleanEngine());

  it('drillHoleInBody throws when the cutter does not reach the body', () => {
    const tree = new FeatureTree();
    tree.addFeature(boxExtrude20());
    tree.recompute();
    const body = tree.getLatestBodies()[0]!;
    // Blind hole starting 10 mm ABOVE the top face (y = 20): the 5 mm cutter
    // spans y 30..35 and never touches the box (y 0..20) — the case that used
    // to hand the body back unchanged as a fake success.
    expect(() => drillHoleInBody(body, {
      center: { x: 0, y: 30, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: 5,
    })).toThrowError('hole does not reach the body');
  });

  it('a missed hole is an evaluator ERROR with the parent left visible, not a silent no-drill', () => {
    const tree = new FeatureTree();
    const ext = boxExtrude20();
    tree.addFeature(ext);
    tree.recompute();
    tree.addFeature(createHoleFeature(
      { center: { x: 0, y: 30, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: 5 },
      [ext.id],
    ));
    tree.recompute();
    expect(tree.getResult(tree.features[1]!.id)?.error).toContain('hole does not reach the body');
    expect(tree.getResult(tree.features[1]!.id)?.bodies).toHaveLength(0);
    // Consumption happens only on success (the cut rule): the un-drilled box
    // is still the output instead of vanishing into a failed feature.
    expect(tree.getLatestBodies()).toHaveLength(1);
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeCloseTo(8000, 0);
  });

  it('the probe does not reject on-body entries: blind and through-all top-face holes still drill', () => {
    const drillTop = (depth: number | null) => {
      const tree = new FeatureTree();
      const ext = boxExtrude20();
      tree.addFeature(ext);
      tree.recompute();
      tree.addFeature(createHoleFeature(
        { center: { x: 0, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 6, depth },
        [ext.id],
      ));
      tree.recompute();
      return tree;
    };
    // The standard placements must be untouched by the probe: a through-all
    // cutter spans twice the bounding-box diagonal centred on the entry, and a
    // blind cutter starts exactly on the picked surface point.
    for (const depth of [5, null] as const) {
      const tree = drillTop(depth);
      expect(tree.getResult(tree.features[1]!.id)?.error).toBeUndefined();
      const removed = 8000 - Math.abs(computeVolume(tree.getLatestBodies()[0]!));
      const ideal = Math.PI * 3 * 3 * (depth ?? 20);
      expect(removed).toBeGreaterThan(ideal * 0.9);
      expect(removed).toBeLessThan(ideal * 1.1);
    }
  });
});

describe('boolean-engine readiness flip (cold voxel results are not pinned)', () => {
  // The DAG memo used to reuse a hole's result forever once computed —
  // including the blocky voxel approximation produced while the exact
  // Manifold engine was still cold. The memo now records engine readiness and
  // re-evaluates boolean-touching features when it flips.
  it('a hole evaluated cold is re-evaluated after warmUpBooleanEngine', async () => {
    __resetManifoldEngineForTests();
    expect(isManifoldEngineReady()).toBe(false);

    const tree = new FeatureTree();
    const ext = boxExtrude(); // 10×10×10, top face at y = 10
    // Standalone extrude + a parented hole (the real-world shape).
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      { center: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: null },
      [ext.id],
    ));
    tree.recompute();

    const coldBody = tree.getResult(tree.features[1]!.id)!.bodies[0]!;
    expect(coldBody).toBeDefined();
    // The cold path is the voxel kernel: every face normal is axis-aligned.
    const isAxis = (n: { x: number; y: number; z: number }) =>
      Math.abs(n.x) > 0.999 || Math.abs(n.y) > 0.999 || Math.abs(n.z) > 0.999;
    expect(coldBody.faces.every((f) => isAxis(f.normal))).toBe(true);
    expect(Math.abs(computeVolume(coldBody))).toBeLessThan(1000);

    // Engine warms up (blocky-forever bug: nothing ever re-ran before).
    await warmUpBooleanEngine();
    expect(isManifoldEngineReady()).toBe(true);
    tree.recompute();

    const warmBody = tree.getResult(tree.features[1]!.id)!.bodies[0]!;
    expect(warmBody).not.toBe(coldBody);
    // The exact result contains the curved cylinder wall (off-axis normals)
    // and a different, finer tessellation than the voxel grid.
    expect(warmBody.faces.some((f) => !isAxis(f.normal))).toBe(true);
    expect(warmBody.faces.length).not.toBe(coldBody.faces.length);
    // Both approximate the same truth: box minus a ⌀4 through-cylinder.
    expect(Math.abs(Math.abs(computeVolume(warmBody)) - Math.abs(computeVolume(coldBody)))).toBeLessThan(150);
  });

  it('memo reuse still works while readiness is unchanged (no needless churn)', async () => {
    await warmUpBooleanEngine(); // warm and staying warm
    const tree = new FeatureTree();
    const ext = boxExtrude();
    tree.addFeature(ext);
    tree.addFeature(createHoleFeature(
      { center: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, diameter: 4, depth: null },
      [ext.id],
    ));
    tree.recompute();
    const body1 = tree.getResult(tree.features[1]!.id)!.bodies[0]!;
    tree.recompute();
    const body2 = tree.getResult(tree.features[1]!.id)!.bodies[0]!;
    // Same feature objects, same readiness → same body object (mesh reuse).
    expect(body2).toBe(body1);
  });
});

describe('plane-aware extrude/revolve (sketch frames)', () => {
  /** Extrude a rectangle sketch on `planeId`; returns the resulting body. */
  function extrudeRect(planeId: string, x1: number, y1: number, x2: number, y2: number, distance: number) {
    const sketch = createSketch(planeId);
    addRectangle(sketch, x1, y1, x2, y2);
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance },
      [sf.id],
    );
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(ef);
    tree.recompute();
    return tree.getLatestBodies()[0]!;
  }

  const extents = (body: ReturnType<typeof extrudeRect>) => {
    const bb = computeBoundingBox(body);
    return {
      x: [bb.min.x, bb.max.x] as const,
      y: [bb.min.y, bb.max.y] as const,
      z: [bb.min.z, bb.max.z] as const,
    };
  };

  it("default 'xz' ground sketch keeps the legacy mapping: extrude rises along +Y", () => {
    // Rectangle (0,0)–(4,10): sketch x→world x, sketch y→world z, extrude→y.
    const e = extents(extrudeRect('xz', 0, 0, 4, 10, 2));
    expect(e.x).toEqual([0, 4]);
    expect(e.y).toEqual([0, 2]); // the extrude
    expect(e.z).toEqual([0, 10]);
  });

  it("'xy' (vertical) sketch extrudes along the frame normal (world +Z)", () => {
    // The usability-audit F4 bug: a vertical sketch used to extrude along +Y,
    // flattening it onto the ground. Now the profile stays on its plane.
    const e = extents(extrudeRect('xy', 0, 0, 4, 10, 2));
    expect(e.x).toEqual([0, 4]);
    expect(e.y).toEqual([0, 10]); // sketch vertical stays vertical
    expect(e.z).toEqual([0, 2]); // extrude along the +Z normal
  });

  it("'yz' side sketch extrudes along world +X", () => {
    // yz frame: u = +Y, v = +Z, normal = +X. Sketch x→world y, y→world z.
    const e = extents(extrudeRect('yz', 0, 0, 4, 10, 2));
    expect(e.x).toEqual([0, 2]); // the extrude
    expect(e.y).toEqual([0, 4]);
    expect(e.z).toEqual([0, 10]);
  });

  it("'xy' revolve spins about world Y — the frame's in-plane vertical", () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 2, 0, 4, 2); // section offset from the local Y axis
    const sf = createSketchFeature(sketch);
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(createRevolveFeature(Math.PI * 2, [sf.id]));
    tree.recompute();
    const body = tree.getLatestBodies()[0]!;
    const bb = computeBoundingBox(body);
    // Swept around world Y: radius 2–4 in x/z, sketch y extent kept in y.
    expect(bb.min.x).toBeCloseTo(-4, 5);
    expect(bb.max.x).toBeCloseTo(4, 5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(2, 5);
    expect(bb.min.z).toBeCloseTo(-4, 5);
    expect(bb.max.z).toBeCloseTo(4, 5);
    // Pappus: section area 4 × travel 2π·3 = 24π.
    expect(Math.abs(computeVolume(body))).toBeCloseTo(24 * Math.PI, 0);
  });

  it("'xz' ground sketch revolves about world Z (its in-plane vertical)", () => {
    const sketch = createSketch('xz');
    addRectangle(sketch, 2, 0, 4, 2);
    const sf = createSketchFeature(sketch);
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(createRevolveFeature(Math.PI * 2, [sf.id]));
    tree.recompute();
    const body = tree.getLatestBodies()[0]!;
    const bb = computeBoundingBox(body);
    // Sketch (x,y) → world (x,z): the swept disc lies in x/y, thickness in z.
    expect(bb.min.z).toBeCloseTo(0, 5);
    expect(bb.max.z).toBeCloseTo(2, 5);
    expect(bb.min.x).toBeCloseTo(-4, 5);
    expect(bb.max.x).toBeCloseTo(4, 5);
    expect(Math.abs(computeVolume(body))).toBeCloseTo(24 * Math.PI, 0);
  });
});

describe('plane-aware sweep/loft (sketch frames)', () => {
  /** Sweep a rectangle sketch on `planeId` along that plane's normal. */
  function sweepRect(planeId: string, distance: number) {
    const sketch = createSketch(planeId);
    addRectangle(sketch, 0, 0, 4, 10);
    const sf = createSketchFeature(sketch);
    // World-space path along the plane normal — what performSweep builds.
    const dir =
      planeId === 'xy' ? { x: 0, y: 0, z: 1 }
        : planeId === 'yz' ? { x: 1, y: 0, z: 0 }
          : { x: 0, y: 1, z: 0 };
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(createSweepFeature(
      { path: [{ x: 0, y: 0, z: 0 }, { x: dir.x * distance, y: dir.y * distance, z: dir.z * distance }], twist: 0 },
      [sf.id],
    ));
    tree.recompute();
    return { tree, body: tree.getLatestBodies()[0]! };
  }

  it("'xz' ground sketch keeps the legacy sweep mapping bit-for-bit", () => {
    // The path runs along +Y and the profile passes through in sketch
    // coordinates: ring point = right·x + up·y with right = −Z, up = +X, so a
    // rectangle (0,0)–(4,10) sweeps to x[0,10], y[0,2], z[−4,0] exactly as
    // before the plane-aware change.
    const { tree, body } = sweepRect('xz', 2);
    expect(tree.getResult(tree.features[1]!.id)!.error).toBeUndefined();
    const bb = computeBoundingBox(body);
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(10, 9);
    expect(bb.min.y).toBeCloseTo(0, 9);
    expect(bb.max.y).toBeCloseTo(2, 9);
    expect(bb.min.z).toBeCloseTo(-4, 9);
    expect(bb.max.z).toBeCloseTo(0, 9);
    expect(Math.abs(computeVolume(body))).toBeCloseTo(40 * 2, 6);
  });

  it("'xy' sketch sweeps along the world +Z normal, unmirrored, where drawn", () => {
    // Vertical sketch (0,0)–(4,10): the profile lands on the world XY plane
    // exactly where it was drawn and the sweep extrudes perpendicular to it
    // (world +Z). An identity profile mapping would mirror x → −x.
    const { tree, body } = sweepRect('xy', 2);
    expect(tree.getResult(tree.features[1]!.id)!.error).toBeUndefined();
    const bb = computeBoundingBox(body);
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(4, 9);
    expect(bb.min.y).toBeCloseTo(0, 9);
    expect(bb.max.y).toBeCloseTo(10, 9);
    expect(bb.min.z).toBeCloseTo(0, 9);
    expect(bb.max.z).toBeCloseTo(2, 9);
    expect(Math.abs(computeVolume(body))).toBeCloseTo(40 * 2, 6);
  });

  it("'yz' sketch sweeps along the world +X normal, unmirrored, where drawn", () => {
    const { tree, body } = sweepRect('yz', 2);
    expect(tree.getResult(tree.features[1]!.id)!.error).toBeUndefined();
    const bb = computeBoundingBox(body);
    // yz frame: sketch x→world y, y→world z; the extrude runs along +X.
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(2, 9);
    expect(bb.min.y).toBeCloseTo(0, 9);
    expect(bb.max.y).toBeCloseTo(4, 9);
    expect(bb.min.z).toBeCloseTo(0, 9);
    expect(bb.max.z).toBeCloseTo(10, 9);
    expect(Math.abs(computeVolume(body))).toBeCloseTo(40 * 2, 6);
  });

  it("'xy' loft section stands in the world XY plane (was flattened to y=0)", () => {
    // Before the plane-aware mapping both parent sections collapsed onto the
    // ground plane (the old hardcoded (x, 0, y)) and the loft degenerated.
    // Now the 'xy' section keeps its vertical extent in world Y while the
    // 'xz' section lies flat with its extent in world Z.
    const vertical = createSketch('xy');
    addRectangle(vertical, 0, 0, 4, 10);
    const flat = createSketch('xz');
    addRectangle(flat, 0, 0, 4, 10);
    const vf = createSketchFeature(vertical);
    const ff = createSketchFeature(flat);
    const tree = new FeatureTree();
    tree.addFeature(vf);
    tree.addFeature(ff);
    tree.addFeature(createLoftFeature({}, [vf.id, ff.id]));
    tree.recompute();
    const result = tree.getResult(tree.features[2]!.id)!;
    expect(result.error).toBeUndefined();
    const body = result.bodies[0]!;
    expect(Math.abs(computeVolume(body))).toBeGreaterThan(0);
    const bb = computeBoundingBox(body);
    // Vertical section reaches world y = 10, flat section reaches z = 10.
    expect(bb.max.y).toBeCloseTo(10, 6);
    expect(bb.max.z).toBeCloseTo(10, 6);
  });
});

describe('extrude cut (Fusion Extrude ▸ Operation: Cut)', () => {
  // The runtime app always has the exact Manifold engine warm; do the same so
  // the volume math measures the exact boolean, not the voxel approximation.
  beforeAll(() => warmUpBooleanEngine());

  /** A sketch feature with one rectangle on the 'xz' ground plane (sketch
   * x→world x, sketch y→world z; the extrude runs along world +Y). */
  function rectSketch(x1: number, z1: number, x2: number, z2: number) {
    const sketch = createSketch('xz');
    addRectangle(sketch, x1, z1, x2, z2);
    return createSketchFeature(sketch);
  }

  /** An extrude cut: cutter from the sketch, target = the non-sketch parent. */
  function cutFeature(sketchFeatId: string, targetFeatId: string, distance: number) {
    return createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance, op: 'cut' },
      [sketchFeatId, targetFeatId],
    );
  }

  it('cuts a smaller overlapping profile out of the target: volume = target − intersection', () => {
    const tree = new FeatureTree();
    const target = boxExtrude(); // 10×10×10: x/z ±5, y 0..10
    const sf = rectSketch(-2, -2, 2, 2); // pocket x[2,6] × z[2,6]
    const cut = cutFeature(sf.id, target.id, 10); // full-depth cutter
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();

    expect(tree.getResult(cut.id)?.error).toBeUndefined();
    // The cut consumed the target: exactly one output body.
    expect(tree.getLatestBodies()).toHaveLength(1);
    expect(tree.getResult(cut.id)?.bodies).toHaveLength(1);
    // 1000 − 4·4·10 = 840 (±3% covers the voxel fallback too).
    const vol = Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    expect(vol).toBeGreaterThan(840 * 0.97);
    expect(vol).toBeLessThan(840 * 1.03);
  });

  it('the distance is honest: a shorter cutter makes a partial (blind) pocket', () => {
    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(-2, -2, 2, 2);
    const cut = cutFeature(sf.id, target.id, 5); // half the target's height
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();

    expect(tree.getResult(cut.id)?.error).toBeUndefined();
    // 1000 − 4·4·5 = 920: nothing silently extends the cutter through.
    const vol = Math.abs(computeVolume(tree.getLatestBodies()[0]!));
    expect(vol).toBeGreaterThan(920 * 0.97);
    expect(vol).toBeLessThan(920 * 1.03);
  });

  it('a cutter that misses the target is an ERROR, not a silent no-op cut', () => {
    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(20, 20, 24, 24); // far outside the target's footprint
    const cut = cutFeature(sf.id, target.id, 10);
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();

    expect(tree.getResult(cut.id)?.error).toContain('cutter does not intersect the target body');
    expect(tree.getResult(cut.id)?.bodies).toHaveLength(0);
  });

  it('a cut without a target parent reports an error', () => {
    const tree = new FeatureTree();
    const sf = rectSketch(0, 0, 4, 4);
    const cut = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 10, op: 'cut' },
      [sf.id], // sketch only — no body-producing parent
    );
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();
    expect(tree.getResult(cut.id)?.error).toContain('Cut requires a target body');
  });

  it('suppressing the cut restores the target body', () => {
    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(-2, -2, 2, 2);
    const cut = cutFeature(sf.id, target.id, 10);
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeLessThan(1000);

    tree.updateFeature(cut.id, (f) => ({ ...f, suppressed: true }));
    tree.recompute();
    // Suppressed cut → the unconsumed target is the only output again.
    expect(tree.getLatestBodies()).toHaveLength(1);
    expect(Math.abs(computeVolume(tree.getLatestBodies()[0]!))).toBeCloseTo(1000, 3);
  });

  it('an op-less extrude never consumes: even with a body parent it joins (legacy semantics)', () => {
    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(0, 0, 2, 2);
    // Same shape as a cut feature but WITHOUT op — must stay a plain join.
    const join = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 3 },
      [sf.id, target.id],
    );
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(join);
    tree.recompute();

    expect(tree.getResult(join.id)?.error).toBeUndefined();
    // The target is NOT consumed and the extrude made its own body: two out.
    expect(tree.getLatestBodies()).toHaveLength(2);
  });

  it('the op param survives a studio3d round-trip and still cuts on recompute', () => {
    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(-2, -2, 2, 2);
    const cut = cutFeature(sf.id, target.id, 10);
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();

    const json = saveToFile(serializeProject('Part', tree.features, []));
    const parsed = JSON.parse(json) as {
      features: { type: string; data: Record<string, unknown> }[];
    };
    // Serialized wholesale: the cut's params carry op, a join's do not (old
    // files deserialize without it and evaluate as joins).
    expect(parsed.features[2]!.data.op).toBe('cut');
    expect('op' in parsed.features[0]!.data).toBe(false);

    const features = deserializeFeatures(loadFromFile(json));
    expect(features.map((f) => f.type)).toEqual(['extrude', 'sketch', 'extrude']);
    const restoredCut = features[2] as ExtrudeFeature;
    expect(restoredCut.params.op).toBe('cut');
    expect(restoredCut.parentIds).toEqual([sf.id, target.id]);

    const replay = new FeatureTree();
    for (const f of features) replay.addFeature(f);
    replay.recompute();
    expect(replay.getLatestBodies()).toHaveLength(1);
    const vol = Math.abs(computeVolume(replay.getLatestBodies()[0]!));
    expect(vol).toBeGreaterThan(840 * 0.97);
    expect(vol).toBeLessThan(840 * 1.03);
  });

  it('a cut evaluated cold (voxel) re-evaluates when the exact engine warms up', async () => {
    __resetManifoldEngineForTests();
    expect(isManifoldEngineReady()).toBe(false);

    const tree = new FeatureTree();
    const target = boxExtrude();
    const sf = rectSketch(-2, -2, 2, 2);
    const cut = cutFeature(sf.id, target.id, 10);
    tree.addFeature(target);
    tree.addFeature(sf);
    tree.addFeature(cut);
    tree.recompute();

    const coldBody = tree.getResult(cut.id)!.bodies[0]!;
    expect(coldBody).toBeDefined(); // voxel approximation still cut something
    expect(Math.abs(computeVolume(coldBody))).toBeLessThan(1000);

    await warmUpBooleanEngine();
    tree.recompute();
    const warmBody = tree.getResult(cut.id)!.bodies[0]!;
    // Not pinned: the exact result replaces the blocky voxel one.
    expect(warmBody).not.toBe(coldBody);
    const vol = Math.abs(computeVolume(warmBody));
    expect(vol).toBeGreaterThan(840 * 0.99);
    expect(vol).toBeLessThan(840 * 1.01);
  });
});
