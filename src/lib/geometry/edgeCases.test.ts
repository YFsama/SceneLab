import { describe, it, expect } from 'vitest';
import { createBox, createCylinder, createSphere, createTorus, createWedge, createPrism, createTube, computeVolume, computeBoundingBox, checkManifold } from './brep';
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

  describe('sphere operations', () => {
    it('sphere volume approximates 4/3πr³', () => {
      const sphere = createSphere(5, 32);
      const vol = Math.abs(computeVolume(sphere));
      const expected = (4 / 3) * Math.PI * 125; // 4/3 * π * 5³
      expect(vol).toBeGreaterThan(expected * 0.85);
      expect(vol).toBeLessThan(expected * 1.15);
    });

    it('sphere bounding box is roughly cubic', () => {
      const sphere = createSphere(7, 16);
      const bb = computeBoundingBox(sphere);
      const dx = bb.max.x - bb.min.x;
      const dy = bb.max.y - bb.min.y;
      const dz = bb.max.z - bb.min.z;
      expect(Math.abs(dx - dy)).toBeLessThan(1);
      expect(Math.abs(dy - dz)).toBeLessThan(1);
    });

    it('scaled sphere has correct bounding box', () => {
      const sphere = createSphere(5, 16);
      const scaled = scaleBody(sphere, 2);
      const bb = computeBoundingBox(scaled);
      expect(bb.max.x - bb.min.x).toBeCloseTo(20, 0);
    });

    it('translated sphere moves correctly', () => {
      const sphere = createSphere(5, 16);
      const moved = translateBody(sphere, { x: 100, y: 0, z: 0 });
      const bb = computeBoundingBox(moved);
      expect(bb.min.x).toBeGreaterThan(90);
    });
  });

  describe('cylinder operations', () => {
    it('cylinder volume approximates πr²h', () => {
      const cyl = createCylinder(5, 20, 32);
      const vol = Math.abs(computeVolume(cyl));
      const expected = Math.PI * 25 * 20; // π * 5² * 20
      expect(vol).toBeGreaterThan(expected * 0.9);
      expect(vol).toBeLessThan(expected * 1.1);
    });

    it('cylinder bounding box has correct height', () => {
      const cyl = createCylinder(5, 20, 16);
      const bb = computeBoundingBox(cyl);
      expect(bb.max.y - bb.min.y).toBeCloseTo(20, 1);
    });

    it('cylinder bounding box has correct diameter', () => {
      const cyl = createCylinder(5, 20, 32);
      const bb = computeBoundingBox(cyl);
      expect(bb.max.x - bb.min.x).toBeCloseTo(10, 1);
      expect(bb.max.z - bb.min.z).toBeCloseTo(10, 1);
    });

    it('scaled cylinder has correct dimensions', () => {
      const cyl = createCylinder(5, 10, 16);
      const scaled = scaleBodyXYZ(cyl, 2, 1, 3);
      const bb = computeBoundingBox(scaled);
      expect(bb.max.x - bb.min.x).toBeCloseTo(20, 1);
      expect(bb.max.y - bb.min.y).toBeCloseTo(10, 1);
      expect(bb.max.z - bb.min.z).toBeCloseTo(30, 1);
    });
  });

  describe('torus operations', () => {
    it('torus volume approximates 2π²Rr²', () => {
      const R = 10, r = 3;
      const torus = createTorus(R, r, 32, 16);
      const vol = Math.abs(computeVolume(torus));
      const expected = 2 * Math.PI * Math.PI * R * r * r;
      expect(vol).toBeGreaterThan(expected * 0.85);
      expect(vol).toBeLessThan(expected * 1.15);
    });

    it('torus bounding box spans 2(R+r) in X and Z', () => {
      const R = 10, r = 3;
      const torus = createTorus(R, r, 32, 16);
      const bb = computeBoundingBox(torus);
      const expectedSpan = 2 * (R + r);
      expect(bb.max.x - bb.min.x).toBeCloseTo(expectedSpan, 1);
      expect(bb.max.z - bb.min.z).toBeCloseTo(expectedSpan, 1);
    });

    it('torus bounding box spans 2r in Y', () => {
      const R = 10, r = 3;
      const torus = createTorus(R, r, 32, 16);
      const bb = computeBoundingBox(torus);
      expect(bb.max.y - bb.min.y).toBeCloseTo(2 * r, 1);
    });

    it('torus is manifold', () => {
      const torus = createTorus(10, 3, 16, 8);
      expect(checkManifold(torus).boundaryEdges).toBe(0);
    });
  });

  describe('wedge operations', () => {
    it('wedge volume is ½·w·h·d', () => {
      const w = 10, h = 6, d = 4;
      const wedge = createWedge(w, h, d);
      const vol = Math.abs(computeVolume(wedge));
      const expected = 0.5 * w * h * d;
      expect(vol).toBeCloseTo(expected, 0);
    });

    it('wedge bounding box has correct dimensions', () => {
      const w = 10, h = 6, d = 4;
      const wedge = createWedge(w, h, d);
      const bb = computeBoundingBox(wedge);
      expect(bb.max.x - bb.min.x).toBeCloseTo(w, 4);
      expect(bb.max.y - bb.min.y).toBeCloseTo(h, 4);
      expect(bb.max.z - bb.min.z).toBeCloseTo(d, 4);
    });

    it('wedge is manifold', () => {
      const wedge = createWedge(10, 6, 4);
      expect(checkManifold(wedge).boundaryEdges).toBe(0);
    });

    it('scaled wedge preserves volume ratio', () => {
      const wedge = createWedge(10, 6, 4);
      const scaled = scaleBody(wedge, 2);
      const volOrig = Math.abs(computeVolume(wedge));
      const volScaled = Math.abs(computeVolume(scaled));
      // Volume scales by factor³ = 8.
      expect(volScaled).toBeCloseTo(volOrig * 8, 0);
    });
  });

  describe('prism operations', () => {
    it('prism has non-zero volume', () => {
      const prism = createPrism(5, 6, 10);
      const vol = Math.abs(computeVolume(prism));
      expect(vol).toBeGreaterThan(0);
    });

    it('prism bounding box has correct height', () => {
      const prism = createPrism(5, 6, 10);
      const bb = computeBoundingBox(prism);
      expect(bb.max.y - bb.min.y).toBeCloseTo(10, 1);
    });

    it('prism is manifold', () => {
      const prism = createPrism(5, 6, 10);
      expect(checkManifold(prism).boundaryEdges).toBe(0);
    });

    it('scaled prism preserves volume ratio', () => {
      const prism = createPrism(5, 6, 10);
      const scaled = scaleBody(prism, 3);
      const volOrig = Math.abs(computeVolume(prism));
      const volScaled = Math.abs(computeVolume(scaled));
      expect(volScaled).toBeCloseTo(volOrig * 27, 0); // 3³ = 27
    });
  });

  describe('tube operations', () => {
    it('tube volume approximates π(R²-r²)h', () => {
      const R = 5, r = 3, h = 20;
      const tube = createTube(R, r, h, 32);
      const vol = Math.abs(computeVolume(tube));
      const expected = Math.PI * (R * R - r * r) * h;
      expect(vol).toBeGreaterThan(expected * 0.9);
      expect(vol).toBeLessThan(expected * 1.1);
    });

    it('tube bounding box has correct height', () => {
      const tube = createTube(5, 3, 20, 16);
      const bb = computeBoundingBox(tube);
      expect(bb.max.y - bb.min.y).toBeCloseTo(20, 1);
    });

    it('tube is manifold', () => {
      const tube = createTube(5, 3, 10, 16);
      expect(checkManifold(tube).boundaryEdges).toBe(0);
    });

    it('tube has less volume than solid cylinder', () => {
      const R = 5, h = 10;
      const cyl = createCylinder(R, h, 32);
      const tube = createTube(R, 3, h, 32);
      expect(Math.abs(computeVolume(tube))).toBeLessThan(Math.abs(computeVolume(cyl)));
    });
  });
});
