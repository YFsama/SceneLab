import type { SolidBody, Vec3 } from '../geometry/types';
import { checkManifold, computeThickness } from '../geometry';
import { analyzeOverhangs } from './analysis';
import { analyzeStability } from './stability';
import { analyzeBedContact } from './bedContact';
import { checkBuildVolume } from './analysis';

export interface PrintIssue {
  severity: 'error' | 'warning';
  code: 'not-watertight' | 'overhangs' | 'unstable' | 'tippy' | 'tall' | 'thin-walls' | 'too-big';
  message: string;
}

export interface PrintReadiness {
  /** True when there are no error-level issues. */
  ready: boolean;
  issues: PrintIssue[];
}

export interface ReadinessOptions {
  /** Overhang support-angle threshold in degrees (default 45). */
  thresholdDeg?: number;
  /** Printer build volume (mm) to check the part fits. */
  buildVolume?: Vec3;
  /** Tallness ratio above which a warp/detach warning is raised (default 4). */
  tallnessLimit?: number;
  /**
   * Critical tipping angle (degrees) below which a stable part is flagged as
   * easily tipped. Default 10°.
   */
  minTippingAngleDeg?: number;
  /**
   * Minimum printable wall thickness in mm; walls thinner than this are flagged
   * (they can't be printed below the nozzle/line width). Default 0.8mm
   * (~2 perimeters at a 0.4mm nozzle).
   */
  minWallThicknessMm?: number;
}

/**
 * Aggregate the print analyses into an actionable readiness report: watertight
 * and build-volume failures are errors; support, stability and warp concerns
 * are warnings.
 */
export function assessPrintReadiness(body: SolidBody, options: ReadinessOptions = {}): PrintReadiness {
  const issues: PrintIssue[] = [];

  const man = checkManifold(body);
  if (!man.isManifold || man.boundaryEdges > 0) {
    issues.push({
      severity: 'error',
      code: 'not-watertight',
      message: `Not watertight (${man.boundaryEdges} boundary, ${man.nonManifoldEdges} non-manifold edges)`,
    });
  }

  const oh = analyzeOverhangs(body, { thresholdDeg: options.thresholdDeg });
  const supportFaces = oh.faces.filter((f) => f.needsSupport).length;
  if (supportFaces > 0) {
    // Include the worst (shallowest) overhang angle — 0° is a flat bridge,
    // near the threshold is mild — so the user knows how severe it is.
    issues.push({
      severity: 'warning',
      code: 'overhangs',
      message: `${supportFaces} face(s) need support (${oh.overhangArea.toFixed(1)} mm², worst ${oh.worstAngleDeg.toFixed(0)}° from horizontal)`,
    });
  }

  const stability = analyzeStability(body);
  if (!stability.stable) {
    issues.push({ severity: 'warning', code: 'unstable', message: 'May tip over (center of mass outside base)' });
  } else {
    // Stable, but how much tilt does it take to topple? A small critical angle
    // means it tips easily (tall/top-heavy on a narrow base).
    const minTip = options.minTippingAngleDeg ?? 10;
    if (stability.tippingAngleDeg < minTip) {
      issues.push({
        severity: 'warning',
        code: 'tippy',
        message: `Tips easily (topples at ${stability.tippingAngleDeg.toFixed(0)}° tilt) — top-heavy on a narrow base`,
      });
    }
  }

  const bed = analyzeBedContact(body);
  const tallnessLimit = options.tallnessLimit ?? 4;
  if (bed.tallness > tallnessLimit) {
    issues.push({
      severity: 'warning',
      code: 'tall',
      message: `Tall on a small base (tallness ${bed.tallness.toFixed(1)}) — warp/detach risk`,
    });
  }

  const minWall = options.minWallThicknessMm ?? 0.8;
  const thickness = computeThickness(body);
  if (thickness.minThickness < minWall) {
    issues.push({
      severity: 'warning',
      code: 'thin-walls',
      message: `Thin walls (min ${thickness.minThickness.toFixed(2)} mm < ${minWall} mm) may not print`,
    });
  }

  if (options.buildVolume) {
    const fit = checkBuildVolume(body, options.buildVolume);
    if (!fit.fits) {
      issues.push({
        severity: 'error',
        code: 'too-big',
        message: `Exceeds build volume by (${fit.overage.x.toFixed(0)}, ${fit.overage.y.toFixed(0)}, ${fit.overage.z.toFixed(0)}) mm`,
      });
    }
  }

  return { ready: !issues.some((i) => i.severity === 'error'), issues };
}
