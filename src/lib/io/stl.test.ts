import { describe, it, expect } from 'vitest';
import { exportSTLBinary, exportSTLAscii } from './stl';
import { createBox } from '../geometry/brep';

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
