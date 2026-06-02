import type { SolidBody } from '../geometry/types';

/**
 * Flat position array (xyz pairs per edge) for rendering a body's edges as
 * THREE.LineSegments — the dark outlines that make a solid's shape legible,
 * like the edge display in any CAD viewport.
 */
export function buildEdgePositions(body: SolidBody): number[] {
  const out: number[] = [];
  for (const e of body.edges) {
    out.push(e.start.x, e.start.y, e.start.z, e.end.x, e.end.y, e.end.z);
  }
  return out;
}

/** Midpoint of every edge — extra snap targets for the measure tool. */
export function edgeMidpoints(body: SolidBody): { x: number; y: number; z: number }[] {
  return body.edges.map((e) => ({
    x: (e.start.x + e.end.x) / 2,
    y: (e.start.y + e.end.y) / 2,
    z: (e.start.z + e.end.z) / 2,
  }));
}
