import type { Vec3 } from '../geometry/types';

/** Common filament / resin densities in g/cm³. */
export const MATERIAL_DENSITIES = {
  PLA: 1.24,
  ABS: 1.04,
  PETG: 1.27,
  TPU: 1.21,
  Nylon: 1.14,
  Resin: 1.1,
} as const;

export type MaterialName = keyof typeof MATERIAL_DENSITIES;

export interface OverhangOptions {
  /** "Up" direction of the print (build axis). Defaults to +Y (model up). */
  buildDirection?: Vec3;
  /**
   * Surfaces whose angle from the horizontal build plate is below this need
   * support. 45° is the common FDM rule of thumb.
   */
  thresholdDeg?: number;
  /**
   * Count faces resting on the build plate as overhangs. Default false — the
   * bottom surface needs no support.
   */
  includeBaseFaces?: boolean;
  /** Height band (mm) from the lowest point that counts as "on the bed". */
  baseTolerance?: number;
}

export interface FaceOverhang {
  faceId: string;
  /** Angle of the face from the horizontal plate, in degrees (downward faces). */
  angleDeg: number;
  area: number;
  needsSupport: boolean;
}

export interface OverhangReport {
  thresholdDeg: number;
  faces: FaceOverhang[];
  /** Total area of downward faces that fall below the threshold. */
  overhangArea: number;
  /** Total area of all downward-facing faces. */
  downwardArea: number;
}

export interface MassEstimate {
  volumeMm3: number;
  volumeCm3: number;
  massGrams: number;
  density: number;
}

export interface BuildVolumeCheck {
  fits: boolean;
  size: Vec3;
  build: Vec3;
  /** Per-axis amount the part exceeds the build volume (0 if it fits). */
  overage: Vec3;
}

export interface PrintabilityReport {
  overhangs: OverhangReport;
  mass: MassEstimate;
  buildVolume: BuildVolumeCheck | null;
}
