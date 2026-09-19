import { describe, it, expect, beforeEach } from 'vitest';
import { classifyDroppedFile, importMeshFile } from './importFiles';
import { useStore } from '../../store/app';
import { FeatureTree } from '../features/tree';

function objFile(name = 'part.obj'): File {
  const text = [
    '# test cube',
    'v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0',
    'f 1 2 3', 'f 1 3 4',
  ].join('\n');
  return new File([text], name, { type: 'text/plain' });
}

describe('classifyDroppedFile', () => {
  it('routes by extension, case-insensitively', () => {
    expect(classifyDroppedFile('a.stl')).toBe('stl');
    expect(classifyDroppedFile('A.STL')).toBe('stl');
    expect(classifyDroppedFile('b.obj')).toBe('obj');
    expect(classifyDroppedFile('c.step')).toBe('step');
    expect(classifyDroppedFile('d.STP')).toBe('step');
    expect(classifyDroppedFile('e.3mf')).toBe('3mf');
    expect(classifyDroppedFile('f.studio3d')).toBe('studio3d');
    expect(classifyDroppedFile('g.json')).toBe('studio3d');
    expect(classifyDroppedFile('h.txt')).toBe('unknown');
    expect(classifyDroppedFile('noext')).toBe('unknown');
  });
});

describe('importMeshFile', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [], directBodies: [], objectIds: [], selectedIds: [],
      undoStack: [], redoStack: [],
    });
  });

  it('imports an OBJ file into the scene and reports one body', async () => {
    const r = await importMeshFile(objFile());
    expect(r.kind).toBe('obj');
    expect(r.bodyCount).toBe(1);
    expect(useStore.getState().directBodies).toHaveLength(1);
  });

  it('throws for unsupported types without touching the scene', async () => {
    await expect(importMeshFile(new File(['x'], 'notes.txt'))).rejects.toThrow(/Unsupported/i);
    await expect(importMeshFile(new File(['{}'], 'proj.studio3d'))).rejects.toThrow(/Unsupported/i);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });

  it('throws on content-free files', async () => {
    await expect(importMeshFile(new File(['# empty\n'], 'empty.obj'))).rejects.toThrow(/No faces/i);
    expect(useStore.getState().directBodies).toHaveLength(0);
  });
});
