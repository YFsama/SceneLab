import { describe, it, expect } from 'vitest';
import { serializeProject, loadFromFile, deserializeReferenceGeometry, saveToFile } from './studio3d';
import { createSketch, addLine } from '../sketch/engine';
import type { AnnotationDefinition } from '../geometry/referenceGeometry';

describe('annotation persistence', () => {
  it('round-trips annotations through save/load', () => {
    const sketch = createSketch('xz');
    addLine(sketch, 0, 0, 10, 0);

    const annotations: AnnotationDefinition[] = [
      { id: 'ann_1', name: 'Test Distance', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], value: 10, kind: 'distance' },
      { id: 'ann_2', name: 'Test Angle', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }], value: 90, kind: 'angle' },
    ];

    const project = serializeProject('Test', [], [], [], { planes: [], axes: [], points: [], coordSystems: [], annotations });
    const json = saveToFile(project);
    const loaded = loadFromFile(json);
    const rg = deserializeReferenceGeometry(loaded);

    expect(rg.annotations).toHaveLength(2);
    expect(rg.annotations[0]!.id).toBe('ann_1');
    expect(rg.annotations[0]!.kind).toBe('distance');
    expect(rg.annotations[0]!.value).toBe(10);
    expect(rg.annotations[0]!.points).toHaveLength(2);
    expect(rg.annotations[1]!.id).toBe('ann_2');
    expect(rg.annotations[1]!.kind).toBe('angle');
    expect(rg.annotations[1]!.value).toBe(90);
    expect(rg.annotations[1]!.points).toHaveLength(3);
  });

  it('defaults to empty annotations for old files', () => {
    const project = serializeProject('Old', [], [], [], { planes: [], axes: [], points: [], coordSystems: [] });
    const json = saveToFile(project);
    const loaded = loadFromFile(json);
    const rg = deserializeReferenceGeometry(loaded);

    expect(rg.annotations).toEqual([]);
  });

  it('handles empty annotations array', () => {
    const project = serializeProject('Empty', [], [], [], { planes: [], axes: [], points: [], coordSystems: [], annotations: [] });
    const json = saveToFile(project);
    const loaded = loadFromFile(json);
    const rg = deserializeReferenceGeometry(loaded);

    expect(rg.annotations).toEqual([]);
  });
});
