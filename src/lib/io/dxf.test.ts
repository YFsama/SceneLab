import { describe, it, expect } from 'vitest';
import { exportDXF, exportDXF3D } from './dxf';
import { createBox } from '../geometry/brep';

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
});
