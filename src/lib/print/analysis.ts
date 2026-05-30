import type { SolidBody, Vec3 } from '../geometry/types';
import { computeVolume, computeBoundingBox, computeFaceAreas } from '../geometry';
import { MATERIAL_DENSITIES } from './types';
import type {
  OverhangOptions,
  OverhangReport,
  FaceOverhang,
  MassEstimate,
  BuildVolumeCheck,
  PrintabilityReport,
  MaterialName,
} from './types';

const DEG = 180 / Math.PI;

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Flag downward-facing faces that are too shallow to print without support.
 *
 * For a downward face the angle between its surface and the horizontal build
 * plate is `acos(-n·up)`: 0° for a flat ceiling/bridge, 90° for a vertical
 * wall. Anything below `thresholdDeg` (default 45°) is reported as needing
 * support.
 */
export function analyzeOverhangs(body: SolidBody, options: OverhangOptions = {}): OverhangReport {
  const buildDirection = normalize(options.buildDirection ?? { x: 0, y: 1, z: 0 });
  const thresholdDeg = options.thresholdDeg ?? 45;
  const includeBaseFaces = options.includeBaseFaces ?? false;

  const areaById = new Map<string, number>();
  for (const { faceId, area } of computeFaceAreas(body)) {
    areaById.set(faceId, area);
  }

  // Faces resting on the build plate (lowest along the build axis) need no
  // support; identify them so they are not counted as overhangs.
  const heights = body.vertices.map((v) => dot(v, buildDirection));
  const minH = heights.length ? Math.min(...heights) : 0;
  const maxH = heights.length ? Math.max(...heights) : 0;
  const baseTol = options.baseTolerance ?? Math.max(1e-6, (maxH - minH) * 0.01);

  const faces: FaceOverhang[] = [];
  let overhangArea = 0;
  let downwardArea = 0;
  let worstAngleDeg = 90;

  for (const face of body.faces) {
    const n = normalize(face.normal);
    const d = dot(n, buildDirection);
    const area = areaById.get(face.id) ?? 0;

    const onBed =
      !includeBaseFaces &&
      face.vertices.length > 0 &&
      face.vertices.reduce((s, v) => s + dot(v, buildDirection), 0) / face.vertices.length <= minH + baseTol;

    // Only downward-facing surfaces away from the bed can be unsupported.
    if (d >= 0 || onBed) {
      faces.push({ faceId: face.id, angleDeg: d >= 0 ? 90 : 0, area, needsSupport: false });
      continue;
    }

    const angleDeg = Math.acos(clamp(-d, -1, 1)) * DEG;
    const needsSupport = angleDeg < thresholdDeg;
    downwardArea += area;
    if (needsSupport) {
      overhangArea += area;
      worstAngleDeg = Math.min(worstAngleDeg, angleDeg);
    }

    faces.push({ faceId: face.id, angleDeg, area, needsSupport });
  }

  return { thresholdDeg, faces, overhangArea, downwardArea, worstAngleDeg };
}

/** Estimate part mass from its volume and a material density (g/cm³). */
export function estimateMass(body: SolidBody, density: number): MassEstimate {
  const volumeMm3 = Math.abs(computeVolume(body));
  const volumeCm3 = volumeMm3 / 1000;
  return {
    volumeMm3,
    volumeCm3,
    massGrams: volumeCm3 * density,
    density,
  };
}

/** Estimate mass for a named material (PLA, ABS, …). */
export function estimateMassForMaterial(body: SolidBody, material: MaterialName): MassEstimate {
  return estimateMass(body, MATERIAL_DENSITIES[material]);
}

/** Check whether the part's bounding box fits inside a printer's build volume. */
export function checkBuildVolume(body: SolidBody, build: Vec3): BuildVolumeCheck {
  const bb = computeBoundingBox(body);
  const size: Vec3 = {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z,
  };
  const overage: Vec3 = {
    x: Math.max(0, size.x - build.x),
    y: Math.max(0, size.y - build.y),
    z: Math.max(0, size.z - build.z),
  };
  const fits = overage.x === 0 && overage.y === 0 && overage.z === 0;
  return { fits, size, build, overage };
}

export interface PrintabilityOptions extends OverhangOptions {
  density?: number;
  material?: MaterialName;
  buildVolume?: Vec3;
}

/** Combined printability report: overhangs, mass, and build-volume fit. */
export function analyzePrintability(body: SolidBody, options: PrintabilityOptions = {}): PrintabilityReport {
  const density = options.density ?? MATERIAL_DENSITIES[options.material ?? 'PLA'];
  return {
    overhangs: analyzeOverhangs(body, options),
    mass: estimateMass(body, density),
    buildVolume: options.buildVolume ? checkBuildVolume(body, options.buildVolume) : null,
  };
}
