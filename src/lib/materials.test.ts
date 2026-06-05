import { describe, it, expect } from 'vitest';
import { MATERIALS } from './materials';

describe('MATERIALS', () => {
  it('has 8 materials', () => {
    expect(Object.keys(MATERIALS)).toHaveLength(8);
  });

  it('steel has correct density', () => {
    expect(MATERIALS.steel!.density).toBe(7.85);
    expect(MATERIALS.steel!.name).toBe('Steel');
  });

  it('aluminum has correct density', () => {
    expect(MATERIALS.aluminum!.density).toBe(2.70);
    expect(MATERIALS.aluminum!.name).toBe('Aluminum');
  });

  it('PLA has correct density', () => {
    expect(MATERIALS.pla!.density).toBe(1.24);
    expect(MATERIALS.pla!.name).toBe('PLA');
  });

  it('all materials have positive density', () => {
    for (const [, mat] of Object.entries(MATERIALS)) {
      expect(mat.density).toBeGreaterThan(0);
      expect(mat.name).toBeTruthy();
    }
  });

  it('all materials have non-empty names', () => {
    for (const [, mat] of Object.entries(MATERIALS)) {
      expect(mat.name.length).toBeGreaterThan(0);
    }
  });

  it('includes common engineering materials', () => {
    expect(MATERIALS).toHaveProperty('steel');
    expect(MATERIALS).toHaveProperty('aluminum');
    expect(MATERIALS).toHaveProperty('copper');
    expect(MATERIALS).toHaveProperty('titanium');
  });

  it('includes 3D printing materials', () => {
    expect(MATERIALS).toHaveProperty('abs');
    expect(MATERIALS).toHaveProperty('pla');
    expect(MATERIALS).toHaveProperty('nylon');
  });
});
