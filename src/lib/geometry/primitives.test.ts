import { describe, it, expect } from 'vitest';
import { createBox, createCylinder, createSphere, createCone, createTorus, createWedge, createPrism, createTube, createCoil, computeVolume, computeBoundingBox, checkManifold } from './brep';

describe('geometric primitives', () => {
  describe('createBox', () => {
    it('creates a box with correct dimensions', () => {
      const box = createBox(10, 20, 30);
      const bb = computeBoundingBox(box);
      expect(bb.max.x - bb.min.x).toBeCloseTo(10, 4);
      expect(bb.max.y - bb.min.y).toBeCloseTo(20, 4);
      expect(bb.max.z - bb.min.z).toBeCloseTo(30, 4);
    });

    it('has correct volume', () => {
      const box = createBox(10, 20, 30);
      expect(Math.abs(computeVolume(box))).toBeCloseTo(6000, 0);
    });

    it('is manifold (watertight)', () => {
      const box = createBox(10, 20, 30);
      expect(checkManifold(box).boundaryEdges).toBe(0);
    });
  });

  describe('createCylinder', () => {
    it('creates a cylinder with correct height', () => {
      const cyl = createCylinder(5, 10, 16);
      const bb = computeBoundingBox(cyl);
      expect(bb.max.y - bb.min.y).toBeCloseTo(10, 1);
    });

    it('has non-zero volume', () => {
      const cyl = createCylinder(5, 10, 16);
      expect(Math.abs(computeVolume(cyl))).toBeGreaterThan(0);
    });
  });

  describe('createSphere', () => {
    it('creates a sphere with correct diameter', () => {
      const sphere = createSphere(7, 16);
      const bb = computeBoundingBox(sphere);
      const dx = bb.max.x - bb.min.x;
      const dy = bb.max.y - bb.min.y;
      const dz = bb.max.z - bb.min.z;
      // All dimensions should be approximately 14 (2×radius).
      expect(dx).toBeCloseTo(14, 0);
      expect(dy).toBeCloseTo(14, 0);
      expect(dz).toBeCloseTo(14, 0);
    });

    it('has non-zero volume', () => {
      const sphere = createSphere(7, 16);
      expect(Math.abs(computeVolume(sphere))).toBeGreaterThan(0);
    });
  });

  describe('createCone', () => {
    it('creates a cone with correct height', () => {
      const cone = createCone(5, 0, 10, 16);
      const bb = computeBoundingBox(cone);
      expect(bb.max.y - bb.min.y).toBeCloseTo(10, 1);
    });

    it('has non-zero volume', () => {
      const cone = createCone(5, 0, 10, 16);
      expect(Math.abs(computeVolume(cone))).toBeGreaterThan(0);
    });
  });

  describe('createTorus', () => {
    it('creates a torus with non-zero volume', () => {
      const torus = createTorus(10, 3, 16, 8);
      expect(Math.abs(computeVolume(torus))).toBeGreaterThan(0);
    });
  });

  describe('createWedge', () => {
    it('creates a wedge with non-zero volume', () => {
      const wedge = createWedge(10, 20, 30);
      expect(Math.abs(computeVolume(wedge))).toBeGreaterThan(0);
    });
  });

  describe('createPrism', () => {
    it('creates a prism with non-zero volume', () => {
      const prism = createPrism(5, 6, 10);
      expect(Math.abs(computeVolume(prism))).toBeGreaterThan(0);
    });
  });

  describe('createTube', () => {
    it('creates a tube with non-zero volume', () => {
      const tube = createTube(5, 3, 10, 16);
      expect(Math.abs(computeVolume(tube))).toBeGreaterThan(0);
    });
  });

  describe('createCoil', () => {
    it('creates a coil with non-zero volume', () => {
      const coil = createCoil(10, 2, 5, 16);
      expect(Math.abs(computeVolume(coil))).toBeGreaterThan(0);
    });
  });
});
