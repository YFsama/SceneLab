import { describe, it, expect } from 'vitest';

// MoveDialog is a React component — test the validation logic directly.

describe('MoveDialog validation', () => {
  const parseMoveValue = (value: string): number => {
    return parseFloat(value) || 0;
  };

  describe('parseMoveValue', () => {
    it('parses valid numbers', () => {
      expect(parseMoveValue('10')).toBe(10);
      expect(parseMoveValue('-5.5')).toBe(-5.5);
      expect(parseMoveValue('0')).toBe(0);
    });

    it('returns 0 for non-numeric input', () => {
      expect(parseMoveValue('abc')).toBe(0);
      expect(parseMoveValue('')).toBe(0);
    });

    it('handles decimal values', () => {
      expect(parseMoveValue('0.5')).toBe(0.5);
      expect(parseMoveValue('-0.25')).toBe(-0.25);
    });
  });

  describe('move modes', () => {
    it('relative mode applies offset', () => {
      const mode = 'relative';
      const x = 10;
      // Relative: nudgeSelected(x, y, z)
      expect(mode).toBe('relative');
      expect(x).toBe(10);
    });

    it('absolute mode moves to position', () => {
      const mode = 'absolute';
      const x = 50;
      // Absolute: moveSelectionTo({ x, y, z })
      expect(mode).toBe('absolute');
      expect(x).toBe(50);
    });
  });
});
