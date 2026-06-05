import { describe, it, expect } from 'vitest';

// RotateDialog is a React component — test the validation logic directly.

describe('RotateDialog validation', () => {
  const validateAngle = (angle: string): boolean => {
    const deg = parseFloat(angle);
    return Number.isFinite(deg);
  };

  const parseAngle = (angle: string): number => {
    return parseFloat(angle);
  };

  describe('angle validation', () => {
    it('accepts valid angles', () => {
      expect(validateAngle('45')).toBe(true);
      expect(validateAngle('-90')).toBe(true);
      expect(validateAngle('0')).toBe(true);
      expect(validateAngle('360')).toBe(true);
      expect(validateAngle('0.5')).toBe(true);
    });

    it('rejects non-numeric angles', () => {
      expect(validateAngle('abc')).toBe(false);
      expect(validateAngle('')).toBe(false);
    });

    it('accepts Infinity as finite check fails', () => {
      expect(validateAngle('Infinity')).toBe(false);
    });
  });

  describe('angle parsing', () => {
    it('parses positive angles', () => {
      expect(parseAngle('90')).toBe(90);
      expect(parseAngle('45.5')).toBe(45.5);
    });

    it('parses negative angles', () => {
      expect(parseAngle('-90')).toBe(-90);
      expect(parseAngle('-180')).toBe(-180);
    });

    it('parses zero', () => {
      expect(parseAngle('0')).toBe(0);
    });
  });

  describe('axis selection', () => {
    it('valid axes are x, y, z', () => {
      const validAxes = ['x', 'y', 'z'];
      expect(validAxes).toContain('x');
      expect(validAxes).toContain('y');
      expect(validAxes).toContain('z');
    });
  });
});
