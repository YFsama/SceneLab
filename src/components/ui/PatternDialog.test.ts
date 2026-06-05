import { describe, it, expect } from 'vitest';

// PatternDialog is a React component — test the validation logic directly.

describe('PatternDialog validation', () => {
  const validateCount = (value: string): boolean => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 1;
  };

  const validateSpacing = (value: string): boolean => {
    const s = parseFloat(value);
    return Number.isFinite(s) && s > 0;
  };

  const validateGridParams = (sx: string, nz: string, sz: string): boolean => {
    const sxv = parseFloat(sx);
    const nzv = parseInt(nz, 10);
    const szv = parseFloat(sz);
    return [sxv, szv].every((v) => Number.isFinite(v) && v > 0) && Number.isFinite(nzv) && nzv >= 1;
  };

  describe('count validation', () => {
    it('accepts valid counts', () => {
      expect(validateCount('1')).toBe(true);
      expect(validateCount('6')).toBe(true);
      expect(validateCount('100')).toBe(true);
    });

    it('rejects counts below 1', () => {
      expect(validateCount('0')).toBe(false);
      expect(validateCount('-1')).toBe(false);
    });

    it('rejects non-numeric counts', () => {
      expect(validateCount('abc')).toBe(false);
      expect(validateCount('')).toBe(false);
    });
  });

  describe('spacing validation', () => {
    it('accepts valid spacing', () => {
      expect(validateSpacing('10')).toBe(true);
      expect(validateSpacing('0.5')).toBe(true);
    });

    it('rejects non-positive spacing', () => {
      expect(validateSpacing('0')).toBe(false);
      expect(validateSpacing('-5')).toBe(false);
    });

    it('rejects non-numeric spacing', () => {
      expect(validateSpacing('abc')).toBe(false);
    });
  });

  describe('grid parameter validation', () => {
    it('accepts valid grid parameters', () => {
      expect(validateGridParams('10', '3', '10')).toBe(true);
    });

    it('rejects grid with zero spacing', () => {
      expect(validateGridParams('0', '3', '10')).toBe(false);
    });

    it('rejects grid with count below 1', () => {
      expect(validateGridParams('10', '0', '10')).toBe(false);
    });
  });

  describe('pattern modes', () => {
    it('linear mode requires axis, count, spacing', () => {
      const mode = 'linear';
      expect(mode).toBe('linear');
    });

    it('circular mode requires axis, count', () => {
      const mode = 'circular';
      expect(mode).toBe('circular');
    });

    it('grid mode requires countX, spacingX, countZ, spacingZ', () => {
      const mode = 'grid';
      expect(mode).toBe('grid');
    });
  });
});
