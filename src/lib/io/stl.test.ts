import { describe, it, expect } from 'vitest';
import { exportSTLBinary, exportSTLAscii, importSTLAscii, importSTLBinary, importSTL } from './stl';
import { createBox, computeVolume } from '../geometry/brep';

describe('exportSTLBinary', () => {
  it('should return an ArrayBuffer', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLBinary(body);
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it('should have correct header size (84 bytes minimum)', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLBinary(body);
    expect(result.byteLength).toBeGreaterThanOrEqual(84);
  });

  it('should have triangle count in header', () => {
    const body = createBox(2, 2, 2);
    const buffer = exportSTLBinary(body);
    const view = new DataView(buffer);
    const triCount = view.getUint32(80, true);
    expect(triCount).toBeGreaterThan(0);
    // Each triangle is 50 bytes: 12 (normal) + 36 (3 vertices) + 2 (attribute)
    expect(buffer.byteLength).toBe(84 + triCount * 50);
  });
});

describe('exportSTLAscii', () => {
  it('should start with solid keyword', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLAscii(body);
    expect(result).toMatch(/^solid /);
  });

  it('should end with endsolid keyword', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLAscii(body);
    expect(result).toMatch(/endsolid /);
  });

  it('should contain facet normal lines', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLAscii(body);
    expect(result).toContain('facet normal');
  });

  it('should contain vertex lines', () => {
    const body = createBox(2, 2, 2);
    const result = exportSTLAscii(body);
    expect(result).toContain('vertex');
  });
});

describe('importSTLAscii', () => {
  it('round-trips a box through ASCII STL', () => {
    const box = createBox(10, 10, 10);
    const imported = importSTLAscii(exportSTLAscii(box));
    // A box is 6 quads → 12 triangles.
    expect(imported.faces).toHaveLength(12);
    expect(imported.faces.every((f) => f.vertices.length === 3)).toBe(true);
    // 8 distinct corners after vertex deduplication.
    expect(imported.vertices).toHaveLength(8);
    expect(Math.abs(computeVolume(imported))).toBeCloseTo(1000, 3);
  });

  it('reads the solid name', () => {
    const imported = importSTLAscii('solid widget\nendsolid widget\n');
    expect(imported.name).toBe('widget');
  });
});

describe('importSTLBinary', () => {
  it('round-trips a box through binary STL', () => {
    const box = createBox(10, 10, 10);
    const imported = importSTLBinary(exportSTLBinary(box));
    expect(imported.faces).toHaveLength(12);
    expect(Math.abs(computeVolume(imported))).toBeCloseTo(1000, 1);
  });

  it('rejects a truncated buffer', () => {
    expect(() => importSTLBinary(new ArrayBuffer(10))).toThrow('too short');
  });
});

describe('importSTL (auto-detect)', () => {
  const box = createBox(10, 10, 10);

  it('parses a binary STL buffer', () => {
    const body = importSTL(exportSTLBinary(box));
    expect(body.faces).toHaveLength(12);
    expect(Math.abs(computeVolume(body))).toBeCloseTo(1000, 1);
  });

  it('parses an ASCII STL string', () => {
    const body = importSTL(exportSTLAscii(box));
    expect(body.faces).toHaveLength(12);
  });

  it('falls back to ASCII for ASCII bytes in a buffer', () => {
    const buf = new TextEncoder().encode(exportSTLAscii(box)).buffer;
    const body = importSTL(buf);
    expect(body.faces).toHaveLength(12);
  });
});

describe('importSTLAscii welding', () => {
  // Two triangles; one shared corner is jittered by 1e-6.
  const jittered = `solid j
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 1 0 0
   vertex 0 1 0
  endloop
 endfacet
 facet normal 0 0 1
  outer loop
   vertex 1 0 0
   vertex 1 1 0
   vertex 0.000001 1 0
  endloop
 endfacet
endsolid j
`;

  it('welds the jittered corner by default', () => {
    const body = importSTLAscii(jittered); // default weldTolerance 1e-4
    // {0,1,0} and {0.000001,1,0} merge → 4 unique corners.
    expect(body.vertices).toHaveLength(4);
  });

  it('keeps the jittered corner when welding is disabled', () => {
    const body = importSTLAscii(jittered, 0);
    expect(body.vertices).toHaveLength(5);
  });
});
