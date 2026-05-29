import type { SolidBody, Vec3 } from '../geometry/types';
import { analyzeOverhangs } from './analysis';

export interface SupportOptions {
  /** Build / "up" axis. Defaults to +Y. */
  buildDirection?: Vec3;
  /** Overhang support-angle threshold in degrees (default 45). */
  thresholdDeg?: number;
  /** Fraction of the support column actually filled with material (default 0.2). */
  supportDensity?: number;
}

export interface SupportEstimate {
  /** Approximate volume of support material (mm³). */
  supportVolumeMm3: number;
  /** Number of faces requiring support. */
  supportFaces: number;
  supportDensity: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Rough estimate of support-material volume for a print.
 *
 * Each overhang face that needs support is treated as the top of a column that
 * drops to the build plate; the column volume is its area × drop height ×
 * support density (supports are sparse, ~20% by default). This ignores the
 * part occluding some columns, so it's an upper-bound-ish guide, not exact.
 */
export function estimateSupportVolume(body: SolidBody, options: SupportOptions = {}): SupportEstimate {
  const buildDirection = normalize(options.buildDirection ?? { x: 0, y: 1, z: 0 });
  const supportDensity = options.supportDensity ?? 0.2;

  const overhangs = analyzeOverhangs(body, { buildDirection, thresholdDeg: options.thresholdDeg });
  const heights = body.vertices.map((v) => dot(v, buildDirection));
  const minH = heights.length ? Math.min(...heights) : 0;
  const faceById = new Map(body.faces.map((f) => [f.id, f]));

  let supportVolumeMm3 = 0;
  let supportFaces = 0;
  for (const fo of overhangs.faces) {
    if (!fo.needsSupport) continue;
    const face = faceById.get(fo.faceId);
    if (!face || face.vertices.length === 0) continue;
    const centroidH = face.vertices.reduce((s, v) => s + dot(v, buildDirection), 0) / face.vertices.length;
    const drop = Math.max(0, centroidH - minH);
    supportVolumeMm3 += fo.area * drop * supportDensity;
    supportFaces += 1;
  }

  return { supportVolumeMm3, supportFaces, supportDensity };
}
