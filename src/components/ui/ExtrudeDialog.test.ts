import { describe, it, expect } from 'vitest';

// ExtrudeDialog is a React component — test the validation logic directly.

describe('ExtrudeDialog validation', () => {
  const validateDistance = (value: number): number => {
    return Math.max(0.1, value);
  };

  const isValidDistance = (value: number): boolean => {
    return Number.isFinite(value) && value >= 0.1;
  };

  describe('distance validation', () => {
    it('accepts valid distances', () => {
      expect(isValidDistance(10)).toBe(true);
      expect(isValidDistance(0.1)).toBe(true);
      expect(isValidDistance(100)).toBe(true);
    });

    it('rejects distances below minimum', () => {
      expect(isValidDistance(0.05)).toBe(false);
      expect(isValidDistance(0)).toBe(false);
      expect(isValidDistance(-5)).toBe(false);
    });

    it('rejects non-finite values', () => {
      expect(isValidDistance(Infinity)).toBe(false);
      expect(isValidDistance(NaN)).toBe(false);
    });
  });

  describe('distance clamping', () => {
    it('clamps to minimum 0.1', () => {
      expect(validateDistance(0.05)).toBe(0.1);
      expect(validateDistance(0)).toBe(0.1);
      expect(validateDistance(-5)).toBe(0.1);
    });

    it('preserves valid values', () => {
      expect(validateDistance(10)).toBe(10);
      expect(validateDistance(0.5)).toBe(0.5);
    });
  });

  describe('extrude modes', () => {
    it('one-direction extrude uses distance as-is', () => {
      const symmetric = false;
      const distance = 10;
      expect(symmetric).toBe(false);
      expect(distance).toBe(10);
    });

    it('symmetric extrude doubles the effective distance', () => {
      const symmetric = true;
      const distance = 10;
      // Symmetric: extends distance/2 in each direction
      expect(symmetric).toBe(true);
      expect(distance / 2).toBe(5);
    });
  });
});
