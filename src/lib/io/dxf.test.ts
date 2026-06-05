import { describe, it, expect } from 'vitest';
import { exportDXF, exportDXF3D } from './dxf';
import { createBox, createCylinder, createSphere } from '../geometry/brep';

describe('exportDXF', () => {
  it('should start with SECTION HEADER', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('SECTION');
    expect(result).toContain('HEADER');
  });

  it('should end with EOF', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('EOF');
  });

  it('should contain LINE entities', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('LINE');
  });

  it('should contain ENTITIES section', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('ENTITIES');
  });
});

describe('exportDXF3D', () => {
  it('should contain 3DFACE entities', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    expect(result).toContain('3DFACE');
  });

  it('should start with SECTION and end with EOF', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    expect(result).toContain('SECTION');
    expect(result).toContain('EOF');
  });

  it('should contain coordinate data', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    // Should have numeric coordinate values
    expect(result).toMatch(/\d+\.\d+/);
  });

  it('fan-triangulates n-gon faces instead of dropping vertices', () => {
    // A cylinder has two 32-gon caps. Writing only the first 4 vertices per
    // face would lose the caps; fan triangulation must emit (n-2) faces each.
    const segs = 32;
    const result = exportDXF3D(createCylinder(5, 10, segs));
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    // 2 caps × (32-2) tris + 32 quad side faces × 2 tris each = 60 + 64 = 124.
    const expected = 2 * (segs - 2) + segs * 2;
    expect(faceCount).toBe(expected);
  });

  it('exports a sphere with 3DFACE entities', () => {
    const sphere = createSphere(5, 16);
    const result = exportDXF3D(sphere);
    expect(result).toContain('3DFACE');
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(0);
  });

  it('exports a cylinder with 3DFACE entities', () => {
    const cyl = createCylinder(5, 10, 16);
    const result = exportDXF3D(cyl);
    expect(result).toContain('3DFACE');
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(0);
  });

  it('all 3DFACE entities have valid vertex data', () => {
    const box = createBox(10, 10, 10);
    const result = exportDXF3D(box);
    // Each 3DFACE should have numeric coordinates.
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.trim() === '3DFACE') {
        // Next few lines should be numeric coordinates.
        const idx = lines.indexOf(line);
        for (let i = idx + 1; i < idx + 13 && i < lines.length; i++) {
          const val = parseFloat(lines[i]!.trim());
          if (!isNaN(val)) {
            expect(Number.isFinite(val)).toBe(true);
          }
        }
      }
    }
  });
});
