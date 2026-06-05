import { describe, it, expect } from 'vitest';
import { serializeProject, deserializeFeatures, deserializeReferenceGeometry, saveToFile, loadFromFile } from './studio3d';
import { createBox, computeVolume } from '../geometry/brep';
import { FeatureTree, createSketchFeature, createExtrudeFeature } from '../features/tree';
import { createSketch, addRectangle } from '../sketch/engine';
import { standardPlanes, makeAxis, makePoint, makeCoordinateSystem } from '../geometry/referenceGeometry';

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

  it('round-trips reference geometry (planes/axes/points)', () => {
    const tree = new FeatureTree();
    const refGeo = {
      planes: standardPlanes(),
      axes: [makeAxis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 'Z')],
      points: [makePoint({ x: 1, y: 2, z: 3 }, 'P')],
      coordSystems: [makeCoordinateSystem({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 'CS')],
      annotations: [],
    };
    const json = saveToFile(serializeProject('Ref', tree.features, [], [], refGeo));
    const loaded = loadFromFile(json);
    const rg = deserializeReferenceGeometry(loaded);
    expect(rg.planes).toHaveLength(3);
    expect(rg.axes).toHaveLength(1);
    expect(rg.axes[0]!.direction.z).toBeCloseTo(1, 6);
    expect(rg.points).toHaveLength(1);
    expect(rg.points[0]!.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(rg.coordSystems).toHaveLength(1);
    expect(rg.coordSystems[0]!.origin).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('deserializeReferenceGeometry defaults to empty arrays for old files', () => {
    const rg = deserializeReferenceGeometry({ version: 1, name: 'x', features: [], bodies: [], metadata: { created: '', modified: '', appVersion: '' } });
    expect(rg).toEqual({ planes: [], axes: [], points: [], coordSystems: [], annotations: [] });
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

describe('direct body round-trip', () => {
  it('round-trips direct bodies through save/load', () => {
    const box = createBox(10, 20, 30);
    const json = saveToFile(serializeProject('Direct', [], [], [box]));
    const loaded = loadFromFile(json);
    expect(loaded.directBodies).toBeDefined();
    expect(loaded.directBodies!.length).toBe(1);
    expect(loaded.directBodies![0]!.name).toBe(box.name);
  });

  it('preserves body vertices through round-trip', () => {
    const box = createBox(10, 20, 30);
    const json = saveToFile(serializeProject('Direct', [], [], [box]));
    const loaded = loadFromFile(json);
    const restored = loaded.directBodies![0]!;
    expect(restored.vertices.length).toBe(box.vertices.length);
    expect(Math.abs(computeVolume(restored))).toBeCloseTo(Math.abs(computeVolume(box)), 0);
  });

  it('preserves body color and opacity', () => {
    const box = createBox(10, 10, 10);
    box.color = 0xff0000;
    box.opacity = 0.5;
    const json = saveToFile(serializeProject('Direct', [], [], [box]));
    const loaded = loadFromFile(json);
    expect(loaded.directBodies![0]!.color).toBe(0xff0000);
    expect(loaded.directBodies![0]!.opacity).toBe(0.5);
  });

  it('handles empty direct bodies array', () => {
    const json = saveToFile(serializeProject('Empty', [], [], []));
    const loaded = loadFromFile(json);
    expect(loaded.directBodies).toEqual([]);
  });
});

describe('feature tree serialization', () => {
  it('round-trips a sketch feature with entities', () => {
    const sketch = createSketch('xz');
    addRectangle(sketch, 0, 0, 10, 5);
    const sf = createSketchFeature(sketch);
    const json = saveToFile(serializeProject('Feat', [sf], []));
    const features = deserializeFeatures(loadFromFile(json));
    expect(features).toHaveLength(1);
    expect(features[0]!.type).toBe('sketch');
  });

  it('round-trips an extrude feature with params', () => {
    const ef = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 15 },
      [],
    );
    const json = saveToFile(serializeProject('Feat', [ef], []));
    const features = deserializeFeatures(loadFromFile(json));
    expect(features).toHaveLength(1);
    expect(features[0]!.type).toBe('extrude');
    expect((features[0] as { params: { distance: number } }).params.distance).toBe(15);
  });

  it('round-trips a multi-feature dependency chain', () => {
    const sketch = createSketch('xy');
    addRectangle(sketch, -5, -5, 5, 5);
    const sf = createSketchFeature(sketch);
    const ef = createExtrudeFeature(
      { profile: [], direction: { x: 0, y: 1, z: 0 }, distance: 10 },
      [sf.id],
    );
    const json = saveToFile(serializeProject('Chain', [sf, ef], []));
    const features = deserializeFeatures(loadFromFile(json));
    expect(features).toHaveLength(2);
    expect(features[0]!.type).toBe('sketch');
    expect(features[1]!.type).toBe('extrude');
    expect(features[1]!.parentIds).toContain(sf.id);
  });
});
