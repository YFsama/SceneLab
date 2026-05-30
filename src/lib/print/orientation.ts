import type { SolidBody, Vec3 } from '../geometry/types';
import { computeFaceAreas } from '../geometry';

const DEG = 180 / Math.PI;

export interface OrientationOptions {
  /** Overhang support-angle threshold in degrees (default 45). */
  thresholdDeg?: number;
}

export interface OrientationCandidate {
  /** "Up" build direction for this orientation. */
  up: Vec3;
  label: '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
  /** Area of overhang faces needing support (bed-resting faces excluded). */
  supportArea: number;
  /**
   * Approximate support-material volume: each overhang's horizontal projection
   * (area × |n·up|) times its drop to the bed. Better reflects support cost
   * than area alone, since a tall overhang costs more than a low one.
   */
  supportVolume: number;
  supportFaces: number;
  /** Part height along the build axis. */
  buildHeight: number;
  /** Area of faces resting on the bed in this orientation (first-layer adhesion). */
  bedContactArea: number;
}

export interface OrientationReport {
  /** All six axis-aligned orientations, best (least support) first. */
  candidates: OrientationCandidate[];
  best: OrientationCandidate;
}

const DIRECTIONS: { up: Vec3; label: OrientationCandidate['label'] }[] = [
  { up: { x: 1, y: 0, z: 0 }, label: '+X' },
  { up: { x: -1, y: 0, z: 0 }, label: '-X' },
  { up: { x: 0, y: 1, z: 0 }, label: '+Y' },
  { up: { x: 0, y: -1, z: 0 }, label: '-Y' },
  { up: { x: 0, y: 0, z: 1 }, label: '+Z' },
  { up: { x: 0, y: 0, z: -1 }, label: '-Z' },
];

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}
function faceCentroidHeight(face: SolidBody['faces'][number], dir: Vec3): number {
  let h = 0;
  for (const v of face.vertices) h += dot(v, dir);
  return face.vertices.length ? h / face.vertices.length : 0;
}

/**
 * Recommend a print orientation that minimizes support material.
 *
 * For each of the six axis-aligned "up" directions, sum the area of
 * downward-facing faces shallower than the threshold — excluding faces that
 * rest on the build plate (they need no support). Orientations are ranked by
 * support area, then by build height as a tie-breaker.
 */
export function recommendOrientation(body: SolidBody, options: OrientationOptions = {}): OrientationReport {
  const thresholdDeg = options.thresholdDeg ?? 45;
  const areaById = new Map<string, number>();
  for (const { faceId, area } of computeFaceAreas(body)) areaById.set(faceId, area);

  const candidates: OrientationCandidate[] = DIRECTIONS.map(({ up, label }) => {
    const dir = normalize(up);
    if (body.vertices.length === 0) {
      return { up, label, supportArea: 0, supportVolume: 0, supportFaces: 0, buildHeight: 0, bedContactArea: 0 };
    }

    const heights = body.vertices.map((v) => dot(v, dir));
    const minH = Math.min(...heights);
    const maxH = Math.max(...heights);
    const buildHeight = maxH - minH;
    const tol = Math.max(1e-6, buildHeight * 0.01);

    let supportArea = 0;
    let supportVolume = 0;
    let supportFaces = 0;
    let bedContactArea = 0;
    for (const face of body.faces) {
      const n = normalize(face.normal);
      const d = dot(n, dir);
      const centroidH = faceCentroidHeight(face, dir);
      const onBed = centroidH <= minH + tol;
      if (d < 0 && onBed) {
        bedContactArea += areaById.get(face.id) ?? 0; // first-layer contact
        continue;
      }
      if (d >= 0) continue; // not downward-facing
      if (onBed) continue; // resting on the bed
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, -d))) * DEG;
      if (angleDeg < thresholdDeg) {
        const area = areaById.get(face.id) ?? 0;
        supportArea += area;
        // Vertical support column: horizontal projection (area × |n·up|) × drop.
        supportVolume += area * Math.abs(d) * Math.max(0, centroidH - minH);
        supportFaces += 1;
      }
    }
    return { up, label, supportArea, supportVolume, supportFaces, buildHeight, bedContactArea };
  });

  // Prefer least support material (volume), then support area, then shortest
  // build, then largest bed contact (best first-layer adhesion).
  const sorted = [...candidates].sort(
    (a, b) =>
      a.supportVolume - b.supportVolume ||
      a.supportArea - b.supportArea ||
      a.buildHeight - b.buildHeight ||
      b.bedContactArea - a.bedContactArea,
  );

  return { candidates: sorted, best: sorted[0]! };
}
