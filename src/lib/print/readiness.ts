import type { SolidBody, Vec3 } from '../geometry/types';
import { checkManifold } from '../geometry';
import { analyzeOverhangs } from './analysis';
import { analyzeStability } from './stability';
import { analyzeBedContact } from './bedContact';
import { checkBuildVolume } from './analysis';

export interface PrintIssue {
  severity: 'error' | 'warning';
  code: 'not-watertight' | 'overhangs' | 'unstable' | 'tall' | 'too-big';
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
    issues.push({
      severity: 'warning',
      code: 'overhangs',
      message: `${supportFaces} face(s) need support (${oh.overhangArea.toFixed(1)} mm²)`,
    });
  }

  if (!analyzeStability(body).stable) {
    issues.push({ severity: 'warning', code: 'unstable', message: 'May tip over (center of mass outside base)' });
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
