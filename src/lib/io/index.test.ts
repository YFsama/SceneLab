import { describe, it, expect } from 'vitest';
import {
  serializeProject, saveToFile, loadFromFile, downloadFile, readFileAsText,
  exportSTLBinary, exportSTLAscii,
  export3MF,
  exportDXF, exportDXF3D,
  captureViewport, downloadViewportPNG, getViewportBase64,
  projectBody, exportDrawingSVG,
} from './index';
import { createBox } from '../geometry/brep';

describe('IO module exports', () => {
  it('should export studio3d functions', () => {
    expect(typeof serializeProject).toBe('function');
    expect(typeof saveToFile).toBe('function');
    expect(typeof loadFromFile).toBe('function');
    expect(typeof downloadFile).toBe('function');
    expect(typeof readFileAsText).toBe('function');
  });

  it('should export STL functions', () => {
    expect(typeof exportSTLBinary).toBe('function');
    expect(typeof exportSTLAscii).toBe('function');
  });

  it('should export 3MF function', () => {
    expect(typeof export3MF).toBe('function');
  });

  it('should export DXF functions', () => {
    expect(typeof exportDXF).toBe('function');
    expect(typeof exportDXF3D).toBe('function');
  });

  it('should export screenshot functions', () => {
    expect(typeof captureViewport).toBe('function');
    expect(typeof downloadViewportPNG).toBe('function');
    expect(typeof getViewportBase64).toBe('function');
  });

  it('should export drawing functions', () => {
    expect(typeof projectBody).toBe('function');
    expect(typeof exportDrawingSVG).toBe('function');
  });

  it('should round-trip through serialize/deserialize', () => {
    const body = createBox(2, 2, 2);
    const project = serializeProject('Test', [], [body]);
    const json = saveToFile(project);
    const loaded = loadFromFile(json);
    expect(loaded.name).toBe('Test');
    expect(loaded.bodies.length).toBe(1);
  });

  it('should export STL binary for a box', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLBinary(body);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(84);
  });

  it('should export STL ASCII for a box', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLAscii(body);
    expect(result).toContain('solid');
    expect(result).toContain('endsolid');
  });

  it('should export 3MF for a box', () => {
    const body = createBox(2, 2, 2);
    const result = export3MF([body]);
    expect(result).toContain('<?xml');
    expect(result).toContain('<model');
  });

  it('should export DXF for a box', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('SECTION');
    expect(result).toContain('EOF');
  });

  it('should export DXF3D for a box', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    expect(result).toContain('3DFACE');
  });
});
