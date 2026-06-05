import { describe, it, expect } from 'vitest';

// Test the box selection logic used for rectangle drag selection.

describe('box selection', () => {
  describe('containment test', () => {
    // Simulate the containment check: is a screen point inside the selection rectangle?
    const isInside = (
      px: number, py: number,
      x1: number, y1: number, x2: number, y2: number,
    ): boolean => {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return px >= minX && px <= maxX && py >= minY && py <= maxY;
    };

    it('point inside rectangle is selected', () => {
      expect(isInside(50, 50, 0, 0, 100, 100)).toBe(true);
    });

    it('point outside rectangle is not selected', () => {
      expect(isInside(150, 50, 0, 0, 100, 100)).toBe(false);
    });

    it('point on edge is selected', () => {
      expect(isInside(100, 50, 0, 0, 100, 100)).toBe(true);
    });

    it('point on corner is selected', () => {
      expect(isInside(0, 0, 0, 0, 100, 100)).toBe(true);
    });

    it('works with reversed coordinates (right-to-left drag)', () => {
      // Right-to-left drag: x1 > x2.
      expect(isInside(50, 50, 100, 100, 0, 0)).toBe(true);
      expect(isInside(150, 50, 100, 100, 0, 0)).toBe(false);
    });

    it('works with top-to-bottom drag', () => {
      expect(isInside(50, 50, 0, 100, 100, 0)).toBe(true);
      expect(isInside(50, 150, 0, 100, 100, 0)).toBe(false);
    });
  });

  describe('selection rectangle dimensions', () => {
    it('minimum drag distance triggers selection', () => {
      const startX = 100, startY = 200;
      const endX = 110, endY = 205;
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);
      expect(w > 5 || h > 5).toBe(true);
    });

    it('tiny drag does not trigger selection', () => {
      const startX = 100, startY = 200;
      const endX = 102, endY = 201;
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);
      const isSelection = w > 5 || h > 5;
      expect(isSelection).toBe(false);
    });
  });
});
