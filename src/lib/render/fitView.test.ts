import { describe, it, expect } from 'vitest';
import { combinedBounds, fitCameraDistance, framingBodies } from './fitView';
import { createBox } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('framingBodies', () => {
  const a = createBox(2, 2, 2);
  const b = createBox(3, 3, 3);

  it('returns the selected subset when selectionOnly and a selection exists', () => {
    expect(framingBodies([a, b], [a.id], true)).toEqual([a]);
  });

  it('falls back to all when selectionOnly but nothing is selected', () => {
    expect(framingBodies([a, b], [], true)).toEqual([a, b]);
  });

  it('returns all when not selectionOnly', () => {
    expect(framingBodies([a, b], [a.id], false)).toEqual([a, b]);
  });
});

describe('combinedBounds', () => {
  it('returns null for no bodies', () => {
    expect(combinedBounds([])).toBeNull();
  });

  it('spans every vertex across multiple bodies', () => {
    const a = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10]
    const b = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 }); // x ∈ [15,25]
    const bb = combinedBounds([a, b])!;
    expect(bb.min.x).toBeCloseTo(-5, 5);
    expect(bb.max.x).toBeCloseTo(25, 5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(10, 5);
  });
});

describe('fitCameraDistance', () => {
  it('grows with size and is always positive', () => {
    const d1 = fitCameraDistance({ x: 10, y: 10, z: 10 }, 50, 1);
    const d2 = fitCameraDistance({ x: 20, y: 20, z: 20 }, 50, 1);
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeCloseTo(d1 * 2, 5); // distance scales linearly with size
  });

  it('a narrower (non-square) aspect needs more distance to fit width', () => {
    const wide = fitCameraDistance({ x: 10, y: 10, z: 10 }, 50, 2);
    const narrow = fitCameraDistance({ x: 10, y: 10, z: 10 }, 50, 0.5);
    expect(narrow).toBeGreaterThan(wide); // tall/narrow viewport pushes the camera back
  });

  it('handles a degenerate (zero-size) box without dividing by zero', () => {
    expect(Number.isFinite(fitCameraDistance({ x: 0, y: 0, z: 0 }, 50, 1))).toBe(true);
  });
});
