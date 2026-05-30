import type { SolidBody } from '../geometry/types';
import { computeVolume } from '../geometry';
import { estimatePrintJob } from './printJob';

export interface HollowSavings {
  solidVolumeMm3: number;
  /** Material left after hollowing to the given wall thickness (the shell). */
  shellVolumeMm3: number;
  savedVolumeMm3: number;
  savedPercent: number;
}

/**
 * Estimate how much material hollowing a part (shelling to `wallThickness`)
 * saves versus a solid print. The shell volume is the wall model from
 * estimatePrintJob at 0% infill.
 */
export function estimateHollowSavings(body: SolidBody, wallThickness = 1.2): HollowSavings {
  const solidVolumeMm3 = Math.abs(computeVolume(body));
  const shellVolumeMm3 = estimatePrintJob(body, { infill: 0, wallThickness }).materialVolumeMm3;
  const savedVolumeMm3 = Math.max(0, solidVolumeMm3 - shellVolumeMm3);
  return {
    solidVolumeMm3,
    shellVolumeMm3,
    savedVolumeMm3,
    savedPercent: solidVolumeMm3 > 0 ? (savedVolumeMm3 / solidVolumeMm3) * 100 : 0,
  };
}
