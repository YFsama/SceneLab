import { describe, it, expect } from 'vitest';
import {
  createExtrude, createRevolve, createBox,
  computeBoundingBox, computeVolume, computeSurfaceArea,
  applyFillet, applyChamfer, applyShell,
  applyLinearArray, applyCircularArray, applyMirror,
} from './index';

describe('geometry module exports', () => {
  it('should export createExtrude', () => {
    expect(typeof createExtrude).toBe('function');
  });

  it('should export createRevolve', () => {
    expect(typeof createRevolve).toBe('function');
  });

  it('should export createBox', () => {
    expect(typeof createBox).toBe('function');
  });

  it('should export computeBoundingBox', () => {
    expect(typeof computeBoundingBox).toBe('function');
  });

  it('should export computeVolume', () => {
    expect(typeof computeVolume).toBe('function');
  });

  it('should export computeSurfaceArea', () => {
    expect(typeof computeSurfaceArea).toBe('function');
  });

  it('should export applyFillet', () => {
    expect(typeof applyFillet).toBe('function');
  });

  it('should export applyChamfer', () => {
    expect(typeof applyChamfer).toBe('function');
  });

  it('should export applyShell', () => {
    expect(typeof applyShell).toBe('function');
  });

  it('should export applyLinearArray', () => {
    expect(typeof applyLinearArray).toBe('function');
  });

  it('should export applyCircularArray', () => {
    expect(typeof applyCircularArray).toBe('function');
  });

  it('should export applyMirror', () => {
    expect(typeof applyMirror).toBe('function');
  });

  it('should compute consistent results across functions', () => {
    const box = createBox(2, 3, 4);
    const bb = computeBoundingBox(box);
    const volume = computeVolume(box);
    const area = computeSurfaceArea(box);

    // Bounding box should match box dimensions
    expect(bb.max.x - bb.min.x).toBeCloseTo(2);
    expect(bb.max.y - bb.min.y).toBeCloseTo(3);
    expect(bb.max.z - bb.min.z).toBeCloseTo(4);

    // Volume should be positive
    expect(volume).toBeGreaterThan(0);

    // Surface area should be positive
    expect(area).toBeGreaterThan(0);

    // Surface area of a 2x3x4 box = 2*(2*3 + 3*4 + 2*4) = 52
    expect(area).toBeCloseTo(52, 0);
  });
});
