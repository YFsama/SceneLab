import { describe, it, expect } from 'vitest';
import {
  FeatureTree,
  createSketchFeature,
  createExtrudeFeature,
  createRevolveFeature,
  createSweepFeature,
  createLoftFeature,
  createFilletFeature,
  createChamferFeature,
  createShellFeature,
  createLinearArrayFeature,
  createCircularArrayFeature,
  createMirrorFeature,
} from '../../lib/features/tree';
import { serializeProject, deserializeFeatures, saveToFile, loadFromFile } from '../../lib/io';
import { createSketch, addRectangle } from '../../lib/sketch/engine';

// Real coverage: every feature type the FeatureEditor can list must survive a
// full project round-trip (serialize → deserialize), so editing/suppressing
// any of them keeps working after a save/reload. Previously this file
// re-declared a literal array and asserted it against itself.

describe('feature round-trip for every type', () => {
  function buildTreeWithEveryType(): FeatureTree {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const tree = new FeatureTree();
    tree.addFeature(sf);
    tree.addFeature(createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 5, symmetric: false },
      [sf.id],
    ));
    tree.addFeature(createRevolveFeature(Math.PI, [sf.id]));
    tree.addFeature(createSweepFeature({ path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }], twist: 0.5 }, [sf.id]));
    tree.addFeature(createLoftFeature({}, [sf.id]));
    tree.addFeature(createFilletFeature([], 2, [sf.id]));
    tree.addFeature(createChamferFeature([], 1, [sf.id]));
    tree.addFeature(createShellFeature([], 1.5, [sf.id]));
    tree.addFeature(createLinearArrayFeature({ x: 1, y: 0, z: 0 }, 3, 10, [sf.id]));
    tree.addFeature(createCircularArrayFeature({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, 6, [sf.id]));
    tree.addFeature(createMirrorFeature({ origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, [sf.id]));
    return tree;
  }

  it('creates one feature of each of the 11 types', () => {
    const tree = buildTreeWithEveryType();
    expect(tree.features).toHaveLength(11);
    const types = new Set(tree.features.map((f) => f.type));
    expect(types.has('sweep')).toBe(true);
    expect(types.has('loft')).toBe(true);
  });

  it('every feature type survives serialize → deserialize', () => {
    const tree = buildTreeWithEveryType();
    const json = saveToFile(serializeProject('All', tree.features, []));
    const back = deserializeFeatures(loadFromFile(json));
    expect(back.map((f) => f.type)).toEqual(tree.features.map((f) => f.type));
    // Parameters survive too (spot-check the numeric ones).
    const fillet = back.find((f) => f.type === 'fillet');
    expect(fillet && fillet.type === 'fillet' && fillet.params.radius).toBe(2);
    const array = back.find((f) => f.type === 'linearArray');
    expect(array && array.type === 'linearArray' && array.params.count).toBe(3);
    const mirror = back.find((f) => f.type === 'mirror');
    expect(mirror && mirror.type === 'mirror' && mirror.params.keepOriginal).toBe(true);
  });

  it('suppressing a feature removes its bodies from the tree output', () => {
    const tree = buildTreeWithEveryType();
    tree.recompute();
    const before = tree.getLatestBodies().length;
    tree.updateFeature(tree.features[1]!.id, (f) => ({ ...f, suppressed: true }));
    tree.recompute();
    // The extrude feature (and its dependents) no longer produce bodies.
    expect(tree.getLatestBodies().length).toBeLessThan(before);
  });
});
