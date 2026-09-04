import { describe, it, expect } from 'vitest';
import { featureSummary } from './summary';
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
  createScaleFeature,
  createLinearArrayFeature,
  createCircularArrayFeature,
  createMirrorFeature,
} from './tree';
import { createSketch, addRectangle } from '../sketch/engine';

function treeWithEveryType(): FeatureTree {
  const sketch = createSketch('xy');
  addRectangle(sketch, 0, 0, 10, 10);
  const sf = createSketchFeature(sketch);
  const tree = new FeatureTree();
  tree.addFeature(sf);
  tree.addFeature(createExtrudeFeature({ profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 5.5, symmetric: false }, [sf.id]));
  tree.addFeature(createRevolveFeature(Math.PI / 2, [sf.id]));
  tree.addFeature(createSweepFeature({ path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }], twist: 0.5 }, [sf.id]));
  tree.addFeature(createLoftFeature({}, [sf.id]));
  tree.addFeature(createFilletFeature([], 2.5, [sf.id]));
  tree.addFeature(createChamferFeature([], 1, [sf.id]));
  tree.addFeature(createShellFeature([], 1.5, [sf.id]));
  tree.addFeature(createScaleFeature('x', 42, [sf.id]));
  tree.addFeature(createLinearArrayFeature({ x: 1, y: 0, z: 0 }, 3, 10, [sf.id]));
  tree.addFeature(createCircularArrayFeature({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, 6, [sf.id]));
  tree.addFeature(createMirrorFeature({ origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, [sf.id]));
  return tree;
}

describe('featureSummary (timeline chip labels)', () => {
  it('summarizes every feature type without throwing', () => {
    const tree = treeWithEveryType();
    for (const f of tree.features) {
      expect(() => featureSummary(f)).not.toThrow();
      expect(featureSummary(f).length).toBeGreaterThan(0);
    }
  });

  it('formats distances and angles compactly', () => {
    const tree = treeWithEveryType();
    const extrude = tree.features.find((f) => f.type === 'extrude')!;
    expect(featureSummary(extrude)).toBe('5.5mm');
    const revolve = tree.features.find((f) => f.type === 'revolve')!;
    expect(featureSummary(revolve)).toBe('90°');
    const fillet = tree.features.find((f) => f.type === 'fillet')!;
    expect(featureSummary(fillet)).toBe('r2.5');
    const scale = tree.features.find((f) => f.type === 'scale')!;
    expect(featureSummary(scale)).toBe('x→42');
  });
});
