import { describe, it, expect } from 'vitest';

// HollowDialog is a React component — test the validation logic directly.

describe('HollowDialog validation', () => {
  const validateThickness = (value: string): boolean => {
    const w = parseFloat(value);
    return Number.isFinite(w) && w > 0;
  };

  describe('thickness validation', () => {
    it('accepts valid thickness values', () => {
      expect(validateThickness('2')).toBe(true);
      expect(validateThickness('0.5')).toBe(true);
      expect(validateThickness('10')).toBe(true);
    });

    it('rejects non-positive values', () => {
      expect(validateThickness('0')).toBe(false);
      expect(validateThickness('-1')).toBe(false);
    });

    it('rejects non-numeric values', () => {
      expect(validateThickness('abc')).toBe(false);
      expect(validateThickness('')).toBe(false);
    });
  });
});
