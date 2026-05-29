import { describe, it, expect } from 'vitest';
import { FeatureTree, createSketchFeature, createExtrudeFeature } from './index';
import { createSketch } from '../sketch/engine';

describe('features module exports', () => {
  it('should export FeatureTree', () => {
    expect(typeof FeatureTree).toBe('function');
  });

  it('should export createSketchFeature', () => {
    expect(typeof createSketchFeature).toBe('function');
  });

  it('should export createExtrudeFeature', () => {
    expect(typeof createExtrudeFeature).toBe('function');
  });

  it('should create a feature tree and manage features', () => {
    const tree = new FeatureTree();
    const sketch = createSketch('xy');
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

    expect(tree.features.length).toBe(2);
    expect(tree.getLatestBodies().length).toBe(1);
  });
});
