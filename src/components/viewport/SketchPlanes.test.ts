import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

// Test the sketch plane frame mapping used for multi-plane sketch support.

describe('sketch plane frames', () => {
  // The SKETCH_PLANE_FRAMES mapping from ViewportCanvas.
  const SKETCH_PLANE_FRAMES = {
    xy: { normal: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
    xz: { normal: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
    yz: { normal: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1) },
  };

  describe('XY plane', () => {
    it('has normal pointing in +Z', () => {
      expect(SKETCH_PLANE_FRAMES.xy.normal.z).toBe(1);
      expect(SKETCH_PLANE_FRAMES.xy.normal.x).toBe(0);
      expect(SKETCH_PLANE_FRAMES.xy.normal.y).toBe(0);
    });

    it('u axis is +X', () => {
      expect(SKETCH_PLANE_FRAMES.xy.u.x).toBe(1);
    });

    it('v axis is +Y', () => {
      expect(SKETCH_PLANE_FRAMES.xy.v.y).toBe(1);
    });

    it('u × v = normal', () => {
      const cross = new THREE.Vector3().crossVectors(SKETCH_PLANE_FRAMES.xy.u, SKETCH_PLANE_FRAMES.xy.v);
      expect(cross.distanceTo(SKETCH_PLANE_FRAMES.xy.normal)).toBeCloseTo(0, 6);
    });
  });

  describe('XZ plane', () => {
    it('has normal pointing in +Y', () => {
      expect(SKETCH_PLANE_FRAMES.xz.normal.y).toBe(1);
      expect(SKETCH_PLANE_FRAMES.xz.normal.x).toBe(0);
      expect(SKETCH_PLANE_FRAMES.xz.normal.z).toBe(0);
    });

    it('u axis is +X', () => {
      expect(SKETCH_PLANE_FRAMES.xz.u.x).toBe(1);
    });

    it('v axis is +Z', () => {
      expect(SKETCH_PLANE_FRAMES.xz.v.z).toBe(1);
    });

    it('u × v is parallel to normal (may be anti-parallel for left-handed frames)', () => {
      const cross = new THREE.Vector3().crossVectors(SKETCH_PLANE_FRAMES.xz.u, SKETCH_PLANE_FRAMES.xz.v);
      const dot = cross.dot(SKETCH_PLANE_FRAMES.xz.normal);
      // dot should be ±1 (parallel or anti-parallel).
      expect(Math.abs(dot)).toBeCloseTo(1, 6);
    });
  });

  describe('YZ plane', () => {
    it('has normal pointing in +X', () => {
      expect(SKETCH_PLANE_FRAMES.yz.normal.x).toBe(1);
      expect(SKETCH_PLANE_FRAMES.yz.normal.y).toBe(0);
      expect(SKETCH_PLANE_FRAMES.yz.normal.z).toBe(0);
    });

    it('u axis is +Y', () => {
      expect(SKETCH_PLANE_FRAMES.yz.u.y).toBe(1);
    });

    it('v axis is +Z', () => {
      expect(SKETCH_PLANE_FRAMES.yz.v.z).toBe(1);
    });

    it('u × v = normal', () => {
      const cross = new THREE.Vector3().crossVectors(SKETCH_PLANE_FRAMES.yz.u, SKETCH_PLANE_FRAMES.yz.v);
      expect(cross.distanceTo(SKETCH_PLANE_FRAMES.yz.normal)).toBeCloseTo(0, 6);
    });
  });

  describe('coordinate transformation', () => {
    it('s2w converts 2D sketch coords to 3D world coords on XZ plane', () => {
      const frame = SKETCH_PLANE_FRAMES.xz;
      const s2w = (x: number, y: number) => new THREE.Vector3(
        frame.u.x * x + frame.v.x * y,
        frame.u.y * x + frame.v.y * y,
        frame.u.z * x + frame.v.z * y,
      );

      // Point (5, 10) on XZ plane → world (5, 0, 10).
      const p = s2w(5, 10);
      expect(p.x).toBeCloseTo(5, 6);
      expect(p.y).toBeCloseTo(0, 6);
      expect(p.z).toBeCloseTo(10, 6);
    });

    it('s2w converts 2D sketch coords to 3D world coords on XY plane', () => {
      const frame = SKETCH_PLANE_FRAMES.xy;
      const s2w = (x: number, y: number) => new THREE.Vector3(
        frame.u.x * x + frame.v.x * y,
        frame.u.y * x + frame.v.y * y,
        frame.u.z * x + frame.v.z * y,
      );

      // Point (5, 10) on XY plane → world (5, 10, 0).
      const p = s2w(5, 10);
      expect(p.x).toBeCloseTo(5, 6);
      expect(p.y).toBeCloseTo(10, 6);
      expect(p.z).toBeCloseTo(0, 6);
    });

    it('s2w converts 2D sketch coords to 3D world coords on YZ plane', () => {
      const frame = SKETCH_PLANE_FRAMES.yz;
      const s2w = (x: number, y: number) => new THREE.Vector3(
        frame.u.x * x + frame.v.x * y,
        frame.u.y * x + frame.v.y * y,
        frame.u.z * x + frame.v.z * y,
      );

      // Point (5, 10) on YZ plane → world (0, 5, 10).
      const p = s2w(5, 10);
      expect(p.x).toBeCloseTo(0, 6);
      expect(p.y).toBeCloseTo(5, 6);
      expect(p.z).toBeCloseTo(10, 6);
    });
  });
});
