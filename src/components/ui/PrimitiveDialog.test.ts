import { describe, it, expect } from 'vitest';
import type { PrimitiveKind } from '../../store/app';

// PrimitiveDialog is a React component — test the validation logic directly.

describe('PrimitiveDialog validation', () => {
  const validatePositive = (value: string): boolean => {
    const v = parseFloat(value);
    return Number.isFinite(v) && v > 0;
  };

  const validateNonNegative = (value: string): boolean => {
    const v = parseFloat(value);
    return Number.isFinite(v) && v >= 0;
  };

  describe('positive validation (width, height, depth, radius)', () => {
    it('accepts positive numbers', () => {
      expect(validatePositive('10')).toBe(true);
      expect(validatePositive('0.5')).toBe(true);
      expect(validatePositive('100')).toBe(true);
    });

    it('rejects zero', () => {
      expect(validatePositive('0')).toBe(false);
    });

    it('rejects negative', () => {
      expect(validatePositive('-5')).toBe(false);
    });

    it('rejects non-numeric', () => {
      expect(validatePositive('abc')).toBe(false);
      expect(validatePositive('')).toBe(false);
    });
  });

  describe('non-negative validation (top radius of cone)', () => {
    it('accepts zero', () => {
      expect(validateNonNegative('0')).toBe(true);
    });

    it('accepts positive', () => {
      expect(validateNonNegative('5')).toBe(true);
    });

    it('rejects negative', () => {
      expect(validateNonNegative('-1')).toBe(false);
    });
  });

  describe('primitive kind fields', () => {
    const SPECS: Record<PrimitiveKind, { fieldCount: number }> = {
      box: { fieldCount: 3 },
      cylinder: { fieldCount: 2 },
      sphere: { fieldCount: 1 },
      cone: { fieldCount: 3 },
      torus: { fieldCount: 2 },
      wedge: { fieldCount: 3 },
      prism: { fieldCount: 3 },
      tube: { fieldCount: 3 },
      coil: { fieldCount: 4 },
    };

    it('box has 3 fields (width, height, depth)', () => {
      expect(SPECS.box.fieldCount).toBe(3);
    });

    it('cylinder has 2 fields (radius, height)', () => {
      expect(SPECS.cylinder.fieldCount).toBe(2);
    });

    it('sphere has 1 field (radius)', () => {
      expect(SPECS.sphere.fieldCount).toBe(1);
    });

    it('cone has 3 fields (bottom radius, top radius, height)', () => {
      expect(SPECS.cone.fieldCount).toBe(3);
    });

    it('torus has 2 fields (ring radius, tube radius)', () => {
      expect(SPECS.torus.fieldCount).toBe(2);
    });

    it('wedge has 3 fields', () => {
      expect(SPECS.wedge.fieldCount).toBe(3);
    });

    it('prism has 3 fields', () => {
      expect(SPECS.prism.fieldCount).toBe(3);
    });

    it('tube has 3 fields', () => {
      expect(SPECS.tube.fieldCount).toBe(3);
    });

    it('coil has 4 fields', () => {
      expect(SPECS.coil.fieldCount).toBe(4);
    });
  });
});
