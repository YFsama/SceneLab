/**
 * Hole callouts for the drawing sheet: GD&T leader annotations auto-derived
 * from the parametric HoleFeatures in the feature tree (no store state —
 * DrawingCanvas reads the tree and passes the features in; suppressed holes
 * are skipped; holes drilled into DIRECT bodies have no feature and are out
 * of scope by design).
 */
import type { HoleFeature, HoleParams } from '../features/types';
import type { Vec3 } from '../geometry/types';
import { holeCalloutText } from '../features/summary';
import { projectPoint, viewRightAxis, type SectionPlane } from './drawing';

/** Where a hole sits in one view, and whether the view looks down its axis. */
export interface HoleAnchor {
  center: { x: number; y: number };
  /** Radius in view units (diameter/2 × scale), same as projected geometry. */
  radius: number;
  /**
   * True when |dot(hole axis, viewDir)| > 0.95 — the hole reads as a circle
   * and gets a callout. Side views of a hole are covered by its geometry
   * (and section hatching), not by a leader.
   */
  axisOn: boolean;
}

/** A view the hole callouts anchor against (mirrors DrawingCanvas's grid). */
export interface CalloutViewFrame {
  dir: Vec3;
  up: Vec3;
  scale: number;
}

/**
 * Project a hole's entry point into a view using projectBodies' exact frame
 * (right = viewRightAxis(up, dir)), plus the axis-on test for callout
 * eligibility.
 */
export function holeAnchor(
  params: HoleParams,
  viewDir: Vec3,
  right: Vec3,
  up: Vec3,
  scale: number,
): HoleAnchor {
  const len = Math.hypot(params.direction.x, params.direction.y, params.direction.z) || 1;
  const axisOn =
    Math.abs(
      (params.direction.x * viewDir.x + params.direction.y * viewDir.y + params.direction.z * viewDir.z) / len,
    ) > 0.95;
  return {
    center: projectPoint(params.center, viewDir, right, up, scale),
    radius: (params.diameter / 2) * scale,
    axisOn,
  };
}

/**
 * Section culling: a hole whose entry point lies on the removed side of the
 * cutting plane (the same sd() > 0 half-space the section clip removes) is
 * not annotated — its geometry is gone from that view.
 */
export function holeKeptBySection(params: HoleParams, section?: SectionPlane): boolean {
  if (!section) return true;
  const sd =
    params.center.x * section.normal.x +
    params.center.y * section.normal.y +
    params.center.z * section.normal.z -
    section.offset;
  return sd <= 0;
}

/** A callout to render on view `viewIndex` (center/radius in that view's units). */
export interface HoleCallout {
  viewIndex: number;
  center: { x: number; y: number };
  radius: number;
  /** Pre-localized holeCalloutText output (the caller passes t('drawing.thru')). */
  text: string;
}

/**
 * Derive the callouts for a sheet: one per (unsuppressed, section-kept) hole
 * on every axis-on view. A −Y hole lands on the Top view; a +Z hole on the
 * Front view; oblique (iso) views are never axis-on and stay unannotated.
 */
export function collectHoleCallouts(
  holes: HoleFeature[],
  frames: CalloutViewFrame[],
  section: SectionPlane | undefined,
  thruWord: string,
): HoleCallout[] {
  const out: HoleCallout[] = [];
  const visible = holes.filter((h) => !h.suppressed && holeKeptBySection(h.params, section));
  for (let viewIndex = 0; viewIndex < frames.length; viewIndex++) {
    const frame = frames[viewIndex]!;
    const right = viewRightAxis(frame.up, frame.dir);
    for (const hole of visible) {
      const anchor = holeAnchor(hole.params, frame.dir, right, frame.up, frame.scale);
      if (!anchor.axisOn) continue;
      out.push({ viewIndex, center: anchor.center, radius: anchor.radius, text: holeCalloutText(hole.params, thruWord) });
    }
  }
  return out;
}
