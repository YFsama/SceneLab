import type { SolidBody } from '../geometry/types';
import { computeVolume, computeSurfaceArea, computeBoundingBox } from '../geometry';
import { MATERIAL_DENSITIES } from './types';
import type { MaterialName } from './types';

export interface PrintJobOptions {
  /** Infill fraction for the interior (0–1). Default 0.2. */
  infill?: number;
  /** Shell/wall thickness in mm. Default 1.2 (≈ 3 × 0.4 mm perimeters). */
  wallThickness?: number;
  /** Filament diameter in mm. Default 1.75. */
  filamentDiameter?: number;
  /** Material for the mass estimate. Default PLA. */
  material?: MaterialName;
  /** Custom density g/cm³ (overrides material). */
  density?: number;
  /** Volumetric throughput in mm³/s for the time estimate. Default 8. */
  volumetricSpeed?: number;
  /** Layer height in mm, for the layer count. Default 0.2. */
  layerHeight?: number;
}

export interface PrintJobEstimate {
  solidVolumeMm3: number;
  /** Material actually deposited (solid walls + infilled interior). */
  materialVolumeMm3: number;
  filamentLengthM: number;
  filamentMassG: number;
  printTimeMinutes: number;
  infill: number;
  wallThickness: number;
  /** Part height along the build axis (+Y), mm. */
  heightMm: number;
  layerHeight: number;
  /** Number of layers = ceil(height / layerHeight). */
  layerCount: number;
}

/**
 * Rough FDM print-job estimate.
 *
 * Material volume is modelled as solid perimeter walls (surface area × wall
 * thickness, capped at the solid volume) plus the remaining interior filled at
 * the infill fraction. Filament length, mass and time follow from that volume.
 * Intended for quick comparisons, not slicer-accurate numbers.
 */
export function estimatePrintJob(body: SolidBody, options: PrintJobOptions = {}): PrintJobEstimate {
  const infill = Math.max(0, Math.min(1, options.infill ?? 0.2));
  const wallThickness = options.wallThickness ?? 1.2;
  const filamentDiameter = options.filamentDiameter ?? 1.75;
  const density = options.density ?? MATERIAL_DENSITIES[options.material ?? 'PLA'];
  const volumetricSpeed = options.volumetricSpeed ?? 8;
  const layerHeight = options.layerHeight ?? 0.2;

  const solidVolumeMm3 = Math.abs(computeVolume(body));
  const surfaceArea = computeSurfaceArea(body);
  const bb = computeBoundingBox(body);
  const heightMm = Number.isFinite(bb.max.y - bb.min.y) ? Math.max(0, bb.max.y - bb.min.y) : 0;
  const layerCount = layerHeight > 0 ? Math.ceil(heightMm / layerHeight) : 0;

  const wallVolume = Math.min(solidVolumeMm3, surfaceArea * wallThickness);
  const interiorVolume = Math.max(0, solidVolumeMm3 - wallVolume);
  const materialVolumeMm3 = wallVolume + interiorVolume * infill;

  const filamentArea = Math.PI * (filamentDiameter / 2) ** 2; // mm²
  const filamentLengthMm = filamentArea > 0 ? materialVolumeMm3 / filamentArea : 0;
  const filamentMassG = (materialVolumeMm3 / 1000) * density;
  const printTimeMinutes = volumetricSpeed > 0 ? materialVolumeMm3 / (volumetricSpeed * 60) : 0;

  return {
    solidVolumeMm3,
    materialVolumeMm3,
    filamentLengthM: filamentLengthMm / 1000,
    filamentMassG,
    printTimeMinutes,
    infill,
    wallThickness,
    heightMm,
    layerHeight,
    layerCount,
  };
}
