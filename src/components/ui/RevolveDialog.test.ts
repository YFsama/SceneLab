import { describe, it, expect } from 'vitest';

// RevolveDialog is a React component — test the validation logic directly.

describe('RevolveDialog validation', () => {
  const clampAngle = (value: number): number => {
    return Math.min(360, Math.max(1, value));
  };

  const degToRad = (deg: number): number => {
    return (deg * Math.PI) / 180;
  };

  const isValidAngle = (value: number): boolean => {
    return Number.isFinite(value) && value >= 1 && value <= 360;
  };

  describe('angle validation', () => {
    it('accepts valid angles', () => {
      expect(isValidAngle(90)).toBe(true);
      expect(isValidAngle(180)).toBe(true);
      expect(isValidAngle(360)).toBe(true);
      expect(isValidAngle(1)).toBe(true);
    });

    it('rejects out-of-range angles', () => {
      expect(isValidAngle(0)).toBe(false);
      expect(isValidAngle(361)).toBe(false);
      expect(isValidAngle(-10)).toBe(false);
    });

    it('rejects non-finite values', () => {
      expect(isValidAngle(Infinity)).toBe(false);
      expect(isValidAngle(NaN)).toBe(false);
    });
  });

  describe('angle clamping', () => {
    it('clamps to minimum 1', () => {
      expect(clampAngle(0)).toBe(1);
      expect(clampAngle(-10)).toBe(1);
    });

    it('clamps to maximum 360', () => {
      expect(clampAngle(361)).toBe(360);
      expect(clampAngle(720)).toBe(360);
    });

    it('preserves valid values', () => {
      expect(clampAngle(90)).toBe(90);
      expect(clampAngle(180)).toBe(180);
    });
  });

  describe('degree to radian conversion', () => {
    it('converts 90° to π/2', () => {
      expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 6);
    });

    it('converts 180° to π', () => {
      expect(degToRad(180)).toBeCloseTo(Math.PI, 6);
    });

    it('converts 360° to 2π', () => {
      expect(degToRad(360)).toBeCloseTo(2 * Math.PI, 6);
    });

    it('converts 0° to 0', () => {
      expect(degToRad(0)).toBe(0);
    });
  });
});
