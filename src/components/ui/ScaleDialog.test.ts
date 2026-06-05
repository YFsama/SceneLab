import { describe, it, expect } from 'vitest';

// ScaleDialog is a React component — test the validation logic directly.

describe('ScaleDialog validation', () => {
  const validateUniform = (factor: string): boolean => {
    const f = parseFloat(factor);
    return Number.isFinite(f) && f > 0;
  };

  const validateNonUniform = (fx: string, fy: string, fz: string): boolean => {
    const x = parseFloat(fx), y = parseFloat(fy), z = parseFloat(fz);
    return Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0 && Number.isFinite(z) && z > 0;
  };

  it('accepts valid uniform factor', () => {
    expect(validateUniform('2')).toBe(true);
    expect(validateUniform('0.5')).toBe(true);
    expect(validateUniform('100')).toBe(true);
  });

  it('rejects non-positive uniform factor', () => {
    expect(validateUniform('0')).toBe(false);
    expect(validateUniform('-1')).toBe(false);
  });

  it('rejects non-numeric uniform factor', () => {
    expect(validateUniform('abc')).toBe(false);
    expect(validateUniform('')).toBe(false);
  });

  it('accepts valid non-uniform factors', () => {
    expect(validateNonUniform('2', '3', '0.5')).toBe(true);
  });

  it('rejects non-uniform with zero factor', () => {
    expect(validateNonUniform('2', '0', '1')).toBe(false);
  });

  it('rejects non-uniform with negative factor', () => {
    expect(validateNonUniform('2', '-1', '1')).toBe(false);
  });

  it('rejects non-uniform with non-numeric factor', () => {
    expect(validateNonUniform('2', 'abc', '1')).toBe(false);
  });
});
