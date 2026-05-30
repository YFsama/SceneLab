import { describe, it, expect } from 'vitest';
import { serializeProject, deserializeFeatures, saveToFile, loadFromFile } from './studio3d';
import { createBox, computeVolume } from '../geometry/brep';
import { FeatureTree, createSketchFeature, createExtrudeFeature } from '../features/tree';
import { createSketch, addRectangle } from '../sketch/engine';

describe('project round-trip (parametric)', () => {
  it('rebuilds the feature tree and geometry from a saved project', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      {
        profile: [
          { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 10 },
        ],
        direction: { x: 0, y: 1, z: 0 },
        distance: 5,
      },
      [sf.id],
    );

    const json = saveToFile(serializeProject('Part', [sf, ef], []));
    const features = deserializeFeatures(loadFromFile(json));

    expect(features).toHaveLength(2);
    expect(features[0]!.type).toBe('sketch');
    // The sketch entities Map survived serialization.
    const restoredSketch = features[0] as { sketch: { entities: Map<string, unknown> } };
    expect(restoredSketch.sketch.entities.size).toBe(sketch.entities.size);

    // Rebuilt tree produces the same solid.
    const tree = new FeatureTree();
    for (const f of features) tree.addFeature(f);
    tree.recompute();
    const bodies = tree.getLatestBodies();
    expect(bodies).toHaveLength(1);
    expect(Math.abs(computeVolume(bodies[0]!))).toBeCloseTo(500, 3); // 10×10×5
  });
});

describe('serializeProject', () => {
  it('should serialize a project with features and bodies', () => {
    const tree = new FeatureTree();
    const body = createBox(2, 2, 2);
    const project = serializeProject('Test', tree.features, [body]);

    expect(project.name).toBe('Test');
    expect(project.version).toBe(1);
    expect(project.bodies.length).toBe(1);
    expect(project.bodies[0]?.name).toBe('Box');
    expect(project.metadata.appVersion).toBe('0.1.0');
  });

  it('should serialize empty project', () => {
    const tree = new FeatureTree();
    const project = serializeProject('Empty', tree.features, []);

    expect(project.bodies.length).toBe(0);
    expect(project.features.length).toBe(0);
  });
});

describe('saveToFile / loadFromFile', () => {
  it('should round-trip through JSON', () => {
    const tree = new FeatureTree();
    const body = createBox(2, 2, 2);
    const project = serializeProject('Test', tree.features, [body]);
    const json = saveToFile(project);
    const loaded = loadFromFile(json);

    expect(loaded.name).toBe('Test');
    expect(loaded.version).toBe(1);
    expect(loaded.bodies.length).toBe(1);
  });

  it('should throw on invalid JSON', () => {
    expect(() => loadFromFile('not json')).toThrow('Invalid JSON format');
  });

  it('should throw on non-object JSON', () => {
    expect(() => loadFromFile('"hello"')).toThrow('not an object');
  });

  it('should throw on missing version', () => {
    expect(() => loadFromFile('{"name":"test"}')).toThrow('missing version');
  });

  it('should throw on wrong version', () => {
    expect(() => loadFromFile('{"version":99,"name":"test","features":[]}')).toThrow('Unsupported file version');
  });

  it('should throw on missing name', () => {
    expect(() => loadFromFile('{"version":1,"features":[]}')).toThrow('missing name');
  });

  it('should throw on missing features', () => {
    expect(() => loadFromFile('{"version":1,"name":"test"}')).toThrow('missing features array');
  });
});
