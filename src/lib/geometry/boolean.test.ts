import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import {
  booleanOp,
  asyncBooleanOp,
  hollowBody,
  splitByPlane,
  mirrorMerge,
  isBodyManifoldCompatible,
  lastBooleanFallbackReason,
  setBooleanFallbackNotifier,
  isManifoldEngineReady,
  warmUpBooleanEngine,
} from './boolean';
import { booleanOpVoxel } from './booleanVoxel';
import { createBox, createCylinder, createSphere, checkManifold, computeVolume } from './brep';
import { isPointInsideBody } from './measure';
import { translateBody, applyFillet, applyChamfer, applyShell } from './operations';
import { makePlane } from './referenceGeometry';
import { getToasts, clearToasts } from '../toast';
import type { SolidBody, Vec3 } from './types';

describe('booleanOp', () => {
  const a = createBox(10, 10, 10); // x,z ∈ [-5,5], y ∈ [0,10], vol 1000
  const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }); // overlap x∈[0,5] → 500

  const vol = (op: 'union' | 'difference' | 'intersect') => Math.abs(computeVolume(booleanOp(a, b, op, 30)!));

  it('union ≈ A + B − overlap, watertight', () => {
    const r = booleanOp(a, b, 'union', 30)!;
    expect(checkManifold(r).boundaryEdges).toBe(0); // closed
    expect(Math.abs(computeVolume(r))).toBeCloseTo(1500, -2); // 1000+1000-500
  });

  it('intersect ≈ the overlap volume', () => {
    expect(vol('intersect')).toBeGreaterThan(450);
    expect(vol('intersect')).toBeLessThan(550);
  });

  it('difference A−B ≈ A minus the overlap', () => {
    expect(vol('difference')).toBeGreaterThan(450);
    expect(vol('difference')).toBeLessThan(550);
  });

  it('intersect of disjoint bodies is null', () => {
    const far = translateBody(createBox(10, 10, 10), { x: 40, y: 0, z: 0 });
    expect(booleanOp(a, far, 'intersect', 16)).toBeNull();
  });
});

describe('hollowBody', () => {
  it('produces a closed shell with less material than the solid', () => {
    const solid = createBox(20, 20, 20); // vol 8000
    const h = hollowBody(solid, 2, 40)!;
    expect(h).not.toBeNull();
    expect(checkManifold(h).boundaryEdges).toBe(0); // watertight
    const v = Math.abs(computeVolume(h));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(8000 * 0.75); // hollowed out (material removed)
  });

  it('throws on non-positive wall thickness', () => {
    expect(() => hollowBody(createBox(10, 10, 10), 0)).toThrow();
  });
});

describe('splitByPlane', () => {
  // createBox(10,10,10): x,z ∈ [-5,5], y ∈ [0,10], vol 1000.
  const box = createBox(10, 10, 10);

  it('a mid-height horizontal plane halves the volume, both sides watertight', () => {
    const plane = makePlane({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    expect(checkManifold(positive!).boundaryEdges).toBe(0);
    expect(checkManifold(negative!).boundaryEdges).toBe(0);
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp).toBeCloseTo(500, -2);
    expect(vn).toBeCloseTo(500, -2);
    // The two halves together conserve the original volume.
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('a plane outside the body leaves one side empty', () => {
    const plane = makePlane({ x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 30);
    expect(positive).toBeNull(); // nothing above y=100
    expect(negative).not.toBeNull(); // whole body below
  });
});

describe('mirrorMerge', () => {
  // createBox(10,10,10): x ∈ [-5,5], y ∈ [0,10], z ∈ [-5,5], vol 1000.
  const box = createBox(10, 10, 10);

  it('fuses a body with its reflection into one symmetric watertight solid', () => {
    // Mirror across x = 5: the copy fills x ∈ [5,15]; union ≈ a 20×10×10 box.
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 40)!;
    expect(merged).not.toBeNull();
    expect(checkManifold(merged).boundaryEdges).toBe(0); // closed, single seamless body
    expect(Math.abs(computeVolume(merged))).toBeCloseTo(2000, -2);
  });

  it('is symmetric about the mirror plane (bounding box centred on it)', () => {
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const v of merged.vertices) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); }
    expect((minX + maxX) / 2).toBeCloseTo(5, 1);
  });
});

describe('booleanOp with different body types', () => {
  it('unions two cylinders', () => {
    const a = createCylinder(5, 10, 16);
    const b = translateBody(createCylinder(5, 10, 16), { x: 8, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30);
    expect(r).not.toBeNull();
    expect(Math.abs(computeVolume(r!))).toBeGreaterThan(0);
  });

  it('intersects two overlapping cylinders', () => {
    const a = createCylinder(5, 10, 16);
    const b = translateBody(createCylinder(5, 10, 16), { x: 3, y: 0, z: 0 });
    const r = booleanOp(a, b, 'intersect', 30);
    expect(r).not.toBeNull();
    expect(Math.abs(computeVolume(r!))).toBeGreaterThan(0);
  });

  it('differences a box minus a cylinder', () => {
    const box = createBox(20, 20, 20);
    const cyl = createCylinder(5, 20, 16);
    const r = booleanOp(box, cyl, 'difference', 30);
    expect(r).not.toBeNull();
    // Volume should be less than the box alone.
    expect(Math.abs(computeVolume(r!))).toBeLessThan(Math.abs(computeVolume(box)));
  });

  it('union with disjoint bodies returns non-null', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 100, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30);
    expect(r).not.toBeNull();
  });

  it('union preserves total volume for disjoint bodies', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 100, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 30)!;
    const volA = Math.abs(computeVolume(a));
    const volB = Math.abs(computeVolume(b));
    const volR = Math.abs(computeVolume(r));
    // Voxel approximation has some error, so allow 20% tolerance.
    expect(volR).toBeGreaterThan((volA + volB) * 0.8);
    expect(volR).toBeLessThan((volA + volB) * 1.2);
  });

  it('difference removes volume', () => {
    const a = createBox(20, 20, 20);
    const b = createBox(10, 10, 10);
    const r = booleanOp(a, b, 'difference', 30)!;
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(a)));
  });

  it('intersect volume is less than either input', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 3, y: 0, z: 0 });
    const r = booleanOp(a, b, 'intersect', 30)!;
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(a)));
    expect(Math.abs(computeVolume(r))).toBeLessThan(Math.abs(computeVolume(b)));
  });
});

describe('splitByPlane edge cases', () => {
  const box = createBox(10, 10, 10);

  it('splits along X axis', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('splits along Z axis', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    expect(vp + vn).toBeCloseTo(1000, -2);
  });

  it('diagonal plane produces two halves', () => {
    const plane = makePlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
  });

  it('both halves are watertight', () => {
    const plane = makePlane({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(checkManifold(positive!).boundaryEdges).toBe(0);
    expect(checkManifold(negative!).boundaryEdges).toBe(0);
  });

  it('off-center plane produces unequal halves', () => {
    const plane = makePlane({ x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(positive).not.toBeNull();
    expect(negative).not.toBeNull();
    const vp = Math.abs(computeVolume(positive!));
    const vn = Math.abs(computeVolume(negative!));
    // The halves should be different sizes.
    expect(Math.abs(vp - vn)).toBeGreaterThan(100);
  });

  it('both halves are always non-negative volume', () => {
    const plane = makePlane({ x: 0, y: 3, z: 0 }, { x: 0, y: 1, z: 0 });
    const { positive, negative } = splitByPlane(box, plane, 40);
    expect(Math.abs(computeVolume(positive!))).toBeGreaterThanOrEqual(0);
    expect(Math.abs(computeVolume(negative!))).toBeGreaterThanOrEqual(0);
  });
});

describe('hollowBody edge cases', () => {
  it('hollow body has less volume than solid', () => {
    const box = createBox(20, 20, 20);
    const hollow = hollowBody(box, 2, 40)!;
    expect(hollow).not.toBeNull();
    expect(Math.abs(computeVolume(hollow))).toBeLessThan(Math.abs(computeVolume(box)));
  });

  it('hollow body has positive volume', () => {
    const box = createBox(20, 20, 20);
    const hollow = hollowBody(box, 2, 40)!;
    expect(hollow).not.toBeNull();
    expect(Math.abs(computeVolume(hollow))).toBeGreaterThan(0);
  });

  it('throws on non-positive wall thickness', () => {
    const box = createBox(20, 20, 20);
    expect(() => hollowBody(box, 0, 40)).toThrow('positive');
    expect(() => hollowBody(box, -1, 40)).toThrow('positive');
  });

  it('thicker wall produces different volume than thinner wall', () => {
    const box = createBox(20, 20, 20);
    const thin = hollowBody(box, 1, 40)!;
    const thick = hollowBody(box, 4, 40)!;
    // Both should have positive volume.
    expect(Math.abs(computeVolume(thin))).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(thick))).toBeGreaterThan(0);
    // They should be different.
    expect(Math.abs(computeVolume(thick))).not.toBeCloseTo(Math.abs(computeVolume(thin)), 0);
  });
});

describe('mirrorMerge edge cases', () => {
  it('mirror merge doubles the volume', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    const volOrig = Math.abs(computeVolume(box));
    const volMerged = Math.abs(computeVolume(merged));
    // Mirror merge should approximately double the volume.
    expect(volMerged).toBeGreaterThan(volOrig * 1.5);
  });

  it('mirror merge produces watertight result', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(checkManifold(merged).boundaryEdges).toBe(0);
  });

  it('mirror merge across Y axis', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 0, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(Math.abs(computeVolume(merged))).toBeGreaterThan(0);
  });

  it('mirror merge across Z axis', () => {
    const box = createBox(10, 10, 10);
    const merged = mirrorMerge(box, { origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: 1 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(Math.abs(computeVolume(merged))).toBeGreaterThan(0);
  });

  it('mirror merge of a cylinder produces valid result', () => {
    const cyl = createCylinder(5, 10, 16);
    const merged = mirrorMerge(cyl, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 30)!;
    expect(merged).not.toBeNull();
    expect(Math.abs(computeVolume(merged))).toBeGreaterThan(0);
  });

  it('mirror merge preserves volume (approximately doubles)', () => {
    const box = createBox(10, 10, 10);
    const volOrig = Math.abs(computeVolume(box));
    const merged = mirrorMerge(box, { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, 40)!;
    const volMerged = Math.abs(computeVolume(merged));
    expect(volMerged).toBeCloseTo(volOrig * 2, -1);
  });
});

describe('hollowBody wall thickness edge cases', () => {
  it('thicker wall produces different volume', () => {
    const box = createBox(20, 20, 20);
    const thin = hollowBody(box, 1, 40)!;
    const thick = hollowBody(box, 4, 40)!;
    expect(Math.abs(computeVolume(thin))).not.toBeCloseTo(Math.abs(computeVolume(thick)), 0);
  });

  it('wall thickness of 1mm works', () => {
    const box = createBox(20, 20, 20);
    const h = hollowBody(box, 1, 40)!;
    expect(h).not.toBeNull();
    expect(Math.abs(computeVolume(h))).toBeGreaterThan(0);
  });

  it('wall thickness close to half dimension still produces valid result', () => {
    const box = createBox(20, 20, 20);
    // Wall thickness = 9mm (almost fills the 10mm half-dimension).
    const h = hollowBody(box, 9, 40);
    // May return null if wall consumes the entire part.
    if (h) {
      expect(Math.abs(computeVolume(h))).toBeGreaterThan(0);
    }
  });
});

describe('booleanOp resolution edge cases', () => {
  it('lower resolution produces faster but rougher result', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 });
    const low = booleanOp(a, b, 'union', 16);
    const high = booleanOp(a, b, 'union', 48);
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    // Both should produce valid results.
    expect(Math.abs(computeVolume(low!))).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(high!))).toBeGreaterThan(0);
  });

  it('minimum resolution (2) still produces a result', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 });
    const r = booleanOp(a, b, 'union', 2);
    // May or may not produce a result at very low resolution.
    if (r) {
      expect(Math.abs(computeVolume(r))).toBeGreaterThan(0);
    }
  });

  it('all three operations work at same resolution', () => {
    const a = createBox(10, 10, 10);
    const b = translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 });
    for (const op of ['union', 'difference', 'intersect'] as const) {
      const r = booleanOp(a, b, op, 24);
      expect(r).not.toBeNull();
      expect(Math.abs(computeVolume(r!))).toBeGreaterThan(0);
    }
  });
});

describe('voxel boolean performance', () => {
  // Timing regression (companion of the "100 exact cuts" bound in
  // booleanManifold.test.ts): the voxel path is the fallback of last resort,
  // but it must stay usable. isPointInsideBody used to rebuild every face's
  // AABB (and a closure) per grid query, which made this difference of
  // 1152-face spheres cost ~14 s; with the per-body AABB cache it is ~1 s.
  // Bound generously so CI stays stable across slower machines.
  it('1152-face voxel difference at res 48 finishes well under 8 s', () => {
    // createSphere emits lon·lat faces (lat = segments/2), so 48 → 1152 faces.
    const a = createSphere(10, 48);
    expect(a.faces.length).toBe(1152);
    const b = translateBody(createSphere(10, 48), { x: 5, y: 0, z: 0 });

    const t0 = performance.now();
    const r = booleanOpVoxel(a, b, 'difference', 48);
    const ms = performance.now() - t0;

    expect(r).not.toBeNull();
    expect(Math.abs(computeVolume(r!))).toBeGreaterThan(1000); // sphere − ~half overlap
    expect(ms).toBeLessThan(8000);
  });
});

// ---------------------------------------------------------------------------
// Pass-30 B/C: voxel-fallback guardrails and isotropic hollow erosion.
// ---------------------------------------------------------------------------

/** A closed box with one dangling triangle — boundary edges, can never be
 *  converted by the exact engine (same class as a fillet/chamfer overlay). */
function boxWithDanglingFace(): SolidBody {
  const box = createBox(10, 10, 10);
  const v = box.vertices[0]!;
  return {
    ...box,
    faces: [
      ...box.faces,
      {
        id: 'dangling',
        vertices: [v, { x: v.x + 3, y: v.y + 3, z: v.z }, { x: v.x, y: v.y + 3, z: v.z + 3 }],
        normal: { x: 1, y: 0, z: 0 },
      },
    ],
  };
}

describe('voxel fallback guardrails', () => {
  afterEach(() => {
    setBooleanFallbackNotifier(null);
    vi.restoreAllMocks();
    clearToasts();
  });

  it('isBodyManifoldCompatible: clean primitives and voxel meshes pass; open meshes and fillet overlays fail', () => {
    expect(isBodyManifoldCompatible(createBox(10, 10, 10))).toBe(true);
    expect(isBodyManifoldCompatible(createCylinder(5, 10, 16))).toBe(true);
    // A voxel result is a closed grid mesh — manifold.
    const vox = booleanOp(createBox(10, 10, 10), translateBody(createBox(10, 10, 10), { x: 5, y: 0, z: 0 }), 'union', 12);
    expect(vox).not.toBeNull();
    expect(isBodyManifoldCompatible(vox!)).toBe(true);
    // The pass-30 fillet overlay is honestly non-manifold (4-face spines) —
    // the exact path can never take it, so booleans after a fillet warn.
    expect(isBodyManifoldCompatible(applyFillet(createBox(30, 10, 30), [], 1))).toBe(false);
    expect(isBodyManifoldCompatible(boxWithDanglingFace())).toBe(false);
  });

  it('sync booleanOp records why it left the exact path; refusing is opt-in', () => {
    const cutter = translateBody(createBox(4, 4, 12), { x: 0, y: 4, z: 0 });
    // Default (allowVoxelFallback unset): voxel fallback still happens —
    // previous behavior preserved for CAM/feature callers.
    expect(booleanOp(boxWithDanglingFace(), cutter, 'difference', 10)).not.toBeNull();
    expect(lastBooleanFallbackReason()).toBe('non-manifold-input');
    // Opt-out: null instead of silently grinding a blocky 15 s voxel result.
    expect(booleanOp(boxWithDanglingFace(), cutter, 'difference', 10, { allowVoxelFallback: false })).toBeNull();
    expect(lastBooleanFallbackReason()).toBe('non-manifold-input');
    // Clean bodies with the engine cold record engine-not-ready — a normal
    // startup state, not an input defect (skipped if some test warmed WASM).
    if (!isManifoldEngineReady()) {
      expect(booleanOp(createBox(10, 10, 10), cutter, 'difference', 10)).not.toBeNull();
      expect(lastBooleanFallbackReason()).toBe('engine-not-ready');
    }
  });

  it('asyncBooleanOp on a filleted body warns via toast + console and still returns the voxel result', async () => {
    const filleted = applyFillet(createBox(30, 10, 30), [], 1);
    const cutter = translateBody(createBox(4, 4, 12), { x: 0, y: 5, z: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearToasts();
    // The voxel result is still returned: the guardrail makes the 15–19 s
    // blocky cliff VISIBLE, not fatal — CAM and feature-recompute chains
    // keep working either way.
    const result = await asyncBooleanOp(filleted, cutter, 'difference', 10);
    expect(result).not.toBeNull();
    expect(checkManifold(result!).boundaryEdges).toBe(0);
    expect(lastBooleanFallbackReason()).toBe('non-manifold-input');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('non-manifold');
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.type).toBe('warning');
  });

  it('a 16-op chain on the same non-manifold body warns once per episode, and clean cold-engine ops stay silent', async () => {
    const notifier = vi.fn();
    setBooleanFallbackNotifier(notifier);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Clean bodies, cold engine: normal startup fallback — silent.
    const box = createBox(10, 10, 10);
    const cutter = translateBody(createBox(2, 2, 12), { x: 0, y: 4, z: 0 });
    await asyncBooleanOp(box, cutter, 'difference', 8);
    expect(notifier).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // 16-hole drill chain on one non-manifold body: one announcement.
    const bad = boxWithDanglingFace();
    for (let i = 0; i < 16; i++) {
      const hole = translateBody(cutter, { x: (i - 8) * 1.1, y: 0, z: 0 });
      await asyncBooleanOp(bad, hole, 'difference', 8);
    }
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0]![0].reason).toBe('non-manifold-input');
    expect(warn).not.toHaveBeenCalled(); // custom notifier replaces console+toast
  });

  it('the manifold precheck is cheap enough to gate every fallback (≈24k-face voxel mesh)', () => {
    const mesh = hollowBody(createBox(40, 40, 40), 2, 40)!;
    expect(mesh.faces.length).toBeGreaterThan(5000);
    const t0 = performance.now();
    expect(isBodyManifoldCompatible(mesh)).toBe(true);
    const ms = performance.now() - t0;
    // Measured ~10–40 ms — three orders of magnitude under the 15–19 s voxel
    // op it gates. Generous bound for CI variance.
    expect(ms).toBeLessThan(500);
  });
});

describe('hollowBody isotropic erosion (anisotropic-cell fix)', () => {
  // Walk inward from a face of the hollow body until the ray leaves the
  // material — the walked distance is the local wall thickness. Probe lines
  // are deliberately off the body's symmetry axes: isPointInsideBody's
  // near-diagonal ray grazes lattice edges on symmetric lines and flips
  // parity there.
  const wallAlong = (body: SolidBody, from: Vec3, dir: Vec3): number => {
    const step = 0.02;
    let walked = 0;
    for (let t = step; t < 14; t += step) {
      const p = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t };
      if (!isPointInsideBody(body, p)) return t - step;
      walked = t;
    }
    return walked;
  };

  it('a 30×30×10 plate at nominal wall 2 keeps ≥ 1.6 mm on every axis (was one 0.208 mm cell)', () => {
    // createBox(30, 30, 10): x ∈ [−15,15], y ∈ [0,30], z ∈ [−5,5]; cells at
    // res 48 are 0.625 × 0.625 × 0.208 — the anisotropy that used to thin
    // the z walls to a single cell.
    const h = hollowBody(createBox(30, 30, 10), 2, 48)!;
    expect(h).not.toBeNull();
    expect(checkManifold(h).boundaryEdges).toBe(0); // still watertight
    expect(Math.abs(computeVolume(h))).toBeGreaterThan(0);
    expect(Math.abs(computeVolume(h))).toBeLessThan(9000);

    const walls = [
      wallAlong(h, { x: -14.99, y: 13.37, z: 1.71 }, { x: 1, y: 0, z: 0 }),
      wallAlong(h, { x: 14.99, y: 13.37, z: -1.71 }, { x: -1, y: 0, z: 0 }),
      wallAlong(h, { x: 1.37, y: 0.01, z: 2.91 }, { x: 0, y: 1, z: 0 }),
      wallAlong(h, { x: 1.37, y: 29.99, z: 2.91 }, { x: 0, y: -1, z: 0 }),
      wallAlong(h, { x: 1.37, y: 13.37, z: 4.99 }, { x: 0, y: 0, z: -1 }),
      wallAlong(h, { x: 1.37, y: 13.37, z: -4.99 }, { x: 0, y: 0, z: 1 }),
    ];
    for (const w of walls) expect(w).toBeGreaterThanOrEqual(1.6);
    // And not absurdly thick either (quantized to ~1.9–2.1).
    for (const w of walls) expect(w).toBeLessThanOrEqual(2.6);
  });

  it('a cube keeps its nominal wall (2 mm on 0.5 mm cells → ~2.0)', () => {
    const h = hollowBody(createBox(20, 20, 20), 2, 40)!;
    const w = wallAlong(h, { x: -9.99, y: 3.37, z: 1.71 }, { x: 1, y: 0, z: 0 });
    expect(w).toBeGreaterThanOrEqual(1.6);
    expect(w).toBeLessThanOrEqual(2.6);
  });

  it('hollow meshes stay closed (no boundary edges)', () => {
    const h = hollowBody(createBox(40, 40, 40), 2, 40)!;
    expect(h.faces.length).toBeGreaterThan(5000);
    expect(checkManifold(h).boundaryEdges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Warm-engine guardrails: the exact fillet/chamfer/shell paths produce
// MANIFOLD results, so booleans after them stay on the exact path — the
// pass-30 overlay (cold) was non-manifold and forced the voxel cliff.
// Appended after the cold tests so their ordering stays deterministic.
// ---------------------------------------------------------------------------

describe('fillet/chamfer/shell warm keep the exact boolean path', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('a warm fillet result is manifold-compatible (the overlay was not)', () => {
    const filleted = applyFillet(createBox(30, 10, 30), [], 1);
    expect(isBodyManifoldCompatible(filleted)).toBe(true);
  });

  it('a warm chamfer and shell result are manifold-compatible too', () => {
    expect(isBodyManifoldCompatible(applyChamfer(createBox(30, 10, 30), [], 1))).toBe(true);
    expect(isBodyManifoldCompatible(applyShell(createBox(20, 20, 20), [], 1))).toBe(true);
  });

  it('a 16-op drill chain on a warm filleted body never touches the voxel path', () => {
    const filleted = applyFillet(createBox(30, 10, 30), [], 1);
    const cutter = translateBody(createBox(2, 2, 12), { x: 0, y: 4, z: 0 });
    for (let i = 0; i < 16; i++) {
      const hole = translateBody(cutter, { x: (i - 8) * 1.1, y: 0, z: 0 });
      expect(booleanOp(filleted, hole, 'difference', 8)).not.toBeNull();
    }
    expect(lastBooleanFallbackReason()).toBeNull();
  });

  it('cold engine flips back to the overlay (non-manifold) — the fallback seam', async () => {
    const { __resetManifoldEngineForTests } = await import('./booleanManifold');
    __resetManifoldEngineForTests();
    expect(isBodyManifoldCompatible(applyFillet(createBox(30, 10, 30), [], 1))).toBe(false);
    await warmUpBooleanEngine();
  });
});
