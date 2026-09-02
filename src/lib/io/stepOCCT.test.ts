import { describe, it, expect, afterEach } from 'vitest';
import {
  occtMeshToSolidBody,
  importSTEPAuto,
  stepNeedsExactKernel,
  __setExactStepLoaderForTests,
} from './stepOCCT';
import { computeVolume, createBox, createCylinder } from '../geometry/brep';
import { exportSTEP } from './step';

/**
 * A 10mm cube as OCCT would tessellate it: one quad (2 triangles) per face,
 * positions duplicated per face — conversion must weld them back to 8 shared
 * vertices and recover the 12 feature edges.
 */
function cubeMeshData(): { positions: number[]; indices: number[] } {
  const quads: [number, number, number][][] = [
    [[0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]], // bottom, −z
    [[0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]], // top, +z
    [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], // front, −y
    [[10, 10, 0], [0, 10, 0], [0, 10, 10], [10, 10, 10]], // back, +y
    [[0, 10, 0], [0, 0, 0], [0, 0, 10], [0, 10, 10]], // left, −x
    [[10, 0, 0], [10, 10, 0], [10, 10, 10], [10, 0, 10]], // right, +x
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const quad of quads) {
    const base = positions.length / 3;
    for (const p of quad) positions.push(...p);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

describe('occtMeshToSolidBody', () => {
  it('welds duplicated positions and emits one face per triangle', () => {
    const { positions, indices } = cubeMeshData();
    const body = occtMeshToSolidBody({ positions, indices }, 'Cube');
    expect(body.faces).toHaveLength(12);
    expect(body.vertices).toHaveLength(8);
    expect(body.name).toBe('Cube');
  });

  it('produces a watertight cube with the exact volume', () => {
    const { positions, indices } = cubeMeshData();
    const body = occtMeshToSolidBody({ positions, indices }, 'Cube');
    expect(computeVolume(body)).toBeCloseTo(1000, 1);
  });

  it('recovers the 12 cube feature edges, not coplanar diagonals', () => {
    const { positions, indices } = cubeMeshData();
    const body = occtMeshToSolidBody({ positions, indices }, 'Cube');
    expect(body.edges).toHaveLength(12);
    // Every edge is a full 10mm side of the cube.
    for (const e of body.edges) {
      expect(Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z)).toBeCloseTo(10, 5);
    }
  });

  it('open boundaries are edges even when flat (single quad)', () => {
    const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
    const indices = [0, 1, 2, 0, 2, 3];
    const body = occtMeshToSolidBody({ positions, indices }, 'Plate');
    expect(body.faces).toHaveLength(2);
    // The 4 outer boundary segments; the shared coplanar diagonal is not a
    // feature edge.
    expect(body.edges).toHaveLength(4);
  });

  it('converts rgb 0..1 colour to 0xRRGGBB', () => {
    const { positions, indices } = cubeMeshData();
    const body = occtMeshToSolidBody({ positions, indices, color: [1, 0, 0] }, 'Red');
    expect(body.color).toBe(0xff0000);
  });

  it('accepts typed arrays (the real WASM output shape)', () => {
    const { positions, indices } = cubeMeshData();
    const body = occtMeshToSolidBody({
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    }, 'Typed');
    expect(body.vertices).toHaveLength(8);
    expect(computeVolume(body)).toBeCloseTo(1000, 1);
  });
});

describe('stepNeedsExactKernel', () => {
  it('planar faceted exports stay on the fast parser', () => {
    const step = exportSTEP(createBox(10, 10, 10));
    expect(stepNeedsExactKernel(step)).toBe(false);
  });

  it('curved surfaces and curved edges trigger the exact kernel', () => {
    expect(stepNeedsExactKernel('=CYLINDRICAL_SURFACE(\'\',1.,$,#1);')).toBe(true);
    expect(stepNeedsExactKernel('=TOROIDAL_SURFACE(#1,5.,1.,.F.);')).toBe(true);
    expect(stepNeedsExactKernel('=B_SPLINE_SURFACE_WITH_KNOTS(')).toBe(true);
    expect(stepNeedsExactKernel('#12=CIRCLE(\'\',$,5.);')).toBe(true);
    expect(stepNeedsExactKernel('=ELLIPSE(\'\',$,5.,3.);')).toBe(true);
    expect(stepNeedsExactKernel('=SURFACE_OF_REVOLUTION(')).toBe(true);
  });
});

describe('importSTEPAuto dispatcher', () => {
  afterEach(() => __setExactStepLoaderForTests(null));

  const planarStep = exportSTEP(createBox(10, 10, 10));

  it('routes curved files to the exact loader', async () => {
    const curved = exportSTEP(createCylinder(5, 10, 16)).replace(/PLANE/g, 'CYLINDRICAL_SURFACE');
    let seen: Uint8Array | null = null;
    __setExactStepLoaderForTests(async (bytes) => {
      seen = bytes;
      return [occtMeshToSolidBody(cubeMeshData(), 'Part')];
    });
    const bytes = new TextEncoder().encode(curved);
    const result = await importSTEPAuto(curved, 'Part', bytes);
    expect(result.engine).toBe('occt');
    expect(result.bodies[0]!.faces).toHaveLength(12);
    expect(seen).toBe(bytes);
  });

  it('falls back to the faceted parser when the exact loader fails', async () => {
    __setExactStepLoaderForTests(async () => {
      throw new Error('WASM unavailable');
    });
    const result = await importSTEPAuto(planarStep + '=CYLINDRICAL_SURFACE(', 'Part');
    expect(result.engine).toBe('faceted');
    expect(result.bodies[0]!.faces.length).toBeGreaterThan(0);
  });

  it('falls back when the exact loader returns empty bodies', async () => {
    __setExactStepLoaderForTests(async () => []);
    const result = await importSTEPAuto(planarStep + '=CYLINDRICAL_SURFACE(', 'Part');
    expect(result.engine).toBe('faceted');
  });

  it('planar files never touch the exact loader', async () => {
    let called = false;
    __setExactStepLoaderForTests(async () => {
      called = true;
      return [];
    });
    const result = await importSTEPAuto(planarStep, 'Part');
    expect(result.engine).toBe('faceted');
    expect(called).toBe(false);
    expect(result.bodies).toHaveLength(1);
  });
});
