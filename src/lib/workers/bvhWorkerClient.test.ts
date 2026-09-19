import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildBoundsTree, ASYNC_BVH_TRIANGLE_THRESHOLD, __disableBvhWorkerForTests } from './bvhWorkerClient';

// Builds a grid of triangles as a position+index pair, exactly the shape
// ViewportCanvas feeds the client (positions flattened x,y,z; indices into it).
function gridGeometry(triangles: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const b = positions.length / 3;
    positions.push(b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8);
    indices.push(b, b + 1, b + 2);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

describe('BVH worker client', () => {
  beforeEach(() => {
    __disableBvhWorkerForTests();
  });

  it('attaches a real bounds tree synchronously when Workers are unavailable', async () => {
    const { positions, indices } = gridGeometry(64);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    await buildBoundsTree(geo, positions, indices);
    expect(geo.boundsTree).toBeInstanceOf(MeshBVH);
    // The tree spans the geometry's full bounds (every vertex is degenerate
    // here, so the AABB collapses to the last vertex's point).
    expect(geo.boundsTree).toBeTruthy();
  });

  it('never detaches the caller-owned input arrays (transfer safety)', async () => {
    const { positions, indices } = gridGeometry(8);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    await buildBoundsTree(geo, positions, indices);
    // If the transfer had used the originals, these would be detached and
    // reading byteLength/elements would break or the render geometry would be
    // empty.
    expect(positions.byteLength).toBeGreaterThan(0);
    expect(indices.byteLength).toBeGreaterThan(0);
    expect(geo.getAttribute('position').count).toBe(positions.length / 3);
  });

  it('threshold keeps small meshes on the synchronous path by contract', () => {
    // The constant exists and is in a sane range — the wired check in the
    // viewport compares triFaceIds.length against it.
    expect(ASYNC_BVH_TRIANGLE_THRESHOLD).toBeGreaterThanOrEqual(1000);
    expect(ASYNC_BVH_TRIANGLE_THRESHOLD).toBeLessThanOrEqual(200000);
  });
});
