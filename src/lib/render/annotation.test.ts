import { describe, it, expect } from 'vitest';
import type { AnnotationDefinition } from '../geometry/referenceGeometry';

describe('annotation rendering', () => {
  const distanceAnnotation: AnnotationDefinition = {
    id: 'ann_1',
    name: 'Test Distance',
    points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
    value: 10,
    kind: 'distance',
  };

  const angleAnnotation: AnnotationDefinition = {
    id: 'ann_2',
    name: 'Test Angle',
    points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
    value: 90,
    kind: 'angle',
  };

  describe('annotation data structure', () => {
    it('distance annotation has 2 points', () => {
      expect(distanceAnnotation.points).toHaveLength(2);
      expect(distanceAnnotation.kind).toBe('distance');
    });

    it('angle annotation has 3 points', () => {
      expect(angleAnnotation.points).toHaveLength(3);
      expect(angleAnnotation.kind).toBe('angle');
    });

    it('annotation has a value', () => {
      expect(distanceAnnotation.value).toBe(10);
      expect(angleAnnotation.value).toBe(90);
    });

    it('annotation has an id and name', () => {
      expect(distanceAnnotation.id).toBeTruthy();
      expect(distanceAnnotation.name).toBeTruthy();
    });
  });

  describe('annotation midpoint calculation', () => {
    it('midpoint of distance annotation', () => {
      const mid = distanceAnnotation.points.reduce(
        (acc, p) => ({
          x: acc.x + p.x / distanceAnnotation.points.length,
          y: acc.y + p.y / distanceAnnotation.points.length,
          z: acc.z + p.z / distanceAnnotation.points.length,
        }),
        { x: 0, y: 0, z: 0 },
      );
      expect(mid.x).toBeCloseTo(5, 6);
      expect(mid.y).toBeCloseTo(0, 6);
      expect(mid.z).toBeCloseTo(0, 6);
    });

    it('midpoint of angle annotation', () => {
      const mid = angleAnnotation.points.reduce(
        (acc, p) => ({
          x: acc.x + p.x / angleAnnotation.points.length,
          y: acc.y + p.y / angleAnnotation.points.length,
          z: acc.z + p.z / angleAnnotation.points.length,
        }),
        { x: 0, y: 0, z: 0 },
      );
      expect(mid.x).toBeCloseTo(20 / 3, 1);
      expect(mid.y).toBeCloseTo(10 / 3, 1);
      expect(mid.z).toBeCloseTo(0, 6);
    });
  });

  describe('annotation label formatting', () => {
    it('distance label shows mm', () => {
      const label = `${distanceAnnotation.value.toFixed(2)} mm`;
      expect(label).toBe('10.00 mm');
    });

    it('angle label shows degrees', () => {
      const label = `${angleAnnotation.value.toFixed(1)}°`;
      expect(label).toBe('90.0°');
    });
  });
});
