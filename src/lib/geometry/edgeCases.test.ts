import { describe, it, expect } from 'vitest';
import { createBox, createCylinder, createSphere, computeVolume, computeBoundingBox, checkManifold } from './brep';
import { scaleBody, scaleBodyXYZ, translateBody, mergeBodies, weldVertices } from './operations';

describe('geometry edge cases', () => {
  describe('scaleBody', () => {
    it('rejects non-positive factor', () => {
      const box = createBox(10, 10, 10);
      expect(() => scaleBody(box, 0)).toThrow('positive');
      expect(() => scaleBody(box, -1)).toThrow('positive');
    });

    it('preserves volume with factor 1', () => {
      const box = createBox(10, 10, 10);
      const scaled = scaleBody(box, 1);
      expect(Math.abs(computeVolume(scaled))).toBeCloseTo(Math.abs(computeVolume(box)), 2);
    });

    it('doubles volume with factor 2', () => {
      const box = createBox(10, 10, 10);
      const scaled = scaleBody(box, 2);
      // Volume scales by factor³ = 8.
      expect(Math.abs(computeVolume(scaled))).toBeCloseTo(Math.abs(computeVolume(box)) * 8, 0);
    });
  });

  describe('scaleBodyXYZ', () => {
    it('rejects non-positive factors', () => {
      const box = createBox(10, 10, 10);
      expect(() => scaleBodyXYZ(box, 0, 1, 1)).toThrow('positive');
      expect(() => scaleBodyXYZ(box, 1, -1, 1)).toThrow('positive');
      expect(() => scaleBodyXYZ(box, 1, 1, 0)).toThrow('positive');
    });

    it('preserves volume when scaling one axis up and another down', () => {
      const box = createBox(10, 10, 10);
      const vol = Math.abs(computeVolume(box));
      // Scale X by 2, Y by 0.5, Z by 1 → volume should stay the same.
      const scaled = scaleBodyXYZ(box, 2, 0.5, 1);
      expect(Math.abs(computeVolume(scaled))).toBeCloseTo(vol, 0);
    });
  });

  describe('translateBody', () => {
    it('preserves volume', () => {
      const box = createBox(10, 10, 10);
      const vol = Math.abs(computeVolume(box));
      const moved = translateBody(box, { x: 100, y: -50, z: 25 });
      expect(Math.abs(computeVolume(moved))).toBeCloseTo(vol, 2);
    });

    it('moves the bounding box center', () => {
      const box = createBox(10, 10, 10);
      const moved = translateBody(box, { x: 100, y: 0, z: 0 });
      const bb = computeBoundingBox(moved);
      const center = (bb.min.x + bb.max.x) / 2;
      expect(center).toBeCloseTo(100, 2);
    });
  });

  describe('mergeBodies', () => {
    it('merges two bodies into one', () => {
      const box1 = createBox(10, 10, 10);
      const box2 = translateBody(createBox(10, 10, 10), { x: 20, y: 0, z: 0 });
      const merged = mergeBodies([box1, box2]);
      expect(merged.faces.length).toBe(box1.faces.length + box2.faces.length);
      expect(merged.vertices.length).toBe(box1.vertices.length + box2.vertices.length);
    });

    it('returns the same body for a single-body merge', () => {
      const box = createBox(10, 10, 10);
      const merged = mergeBodies([box]);
      expect(merged.faces.length).toBe(box.faces.length);
    });
  });

  describe('weldVertices', () => {
    it('maintains or reduces vertex count for a box', () => {
      const box = createBox(10, 10, 10);
      const welded = weldVertices(box);
      // Welding should not increase vertex count.
      expect(welded.vertices.length).toBeLessThanOrEqual(box.vertices.length);
    });

    it('preserves bounding box', () => {
      const box = createBox(10, 20, 30);
      const welded = weldVertices(box);
      const bbOrig = computeBoundingBox(box);
      const bbWelded = computeBoundingBox(welded);
      expect(bbWelded.min.x).toBeCloseTo(bbOrig.min.x, 4);
      expect(bbWelded.max.y).toBeCloseTo(bbOrig.max.y, 4);
      expect(bbWelded.max.z).toBeCloseTo(bbOrig.max.z, 4);
    });

    it('preserves face count', () => {
      const box = createBox(10, 10, 10);
      const welded = weldVertices(box);
      expect(welded.faces.length).toBe(box.faces.length);
    });

    it('preserves edge count', () => {
      const box = createBox(10, 10, 10);
      const welded = weldVertices(box);
      expect(welded.edges.length).toBe(box.edges.length);
    });

    it('produces a valid mesh (non-degenerate faces)', () => {
      const box = createBox(10, 10, 10);
      const welded = weldVertices(box);
      for (const face of welded.faces) {
        expect(face.vertices.length).toBeGreaterThanOrEqual(3);
        expect(face.normal).toBeDefined();
      }
    });
  });

  describe('checkManifold', () => {
    it('reports zero boundary edges for a closed box', () => {
      const box = createBox(10, 10, 10);
      expect(checkManifold(box).boundaryEdges).toBe(0);
    });

    it('reports zero boundary edges for a cylinder', () => {
      const cyl = createCylinder(5, 10, 16);
      expect(checkManifold(cyl).boundaryEdges).toBe(0);
    });

    it('reports zero boundary edges for a sphere', () => {
      const sphere = createSphere(7, 16);
      expect(checkManifold(sphere).boundaryEdges).toBe(0);
    });
  });
});
