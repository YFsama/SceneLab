import { describe, it, expect } from 'vitest';
import { serializeProject, saveToFile, loadFromFile } from './studio3d';
import { createBox } from '../geometry/brep';
import { FeatureTree } from '../features/tree';

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
