import type { Vec3, SolidBody } from '../geometry/types';
import { computeBoundingBox } from '../geometry/brep';
import { detectCircularHoles } from '../geometry/query';
import type { CAMParameters, CuttingTool, Toolpath } from './types';
import {
  generatePocketToolpath,
  generateContourToolpath,
  generateDrillToolpath,
  generateFaceToolpath,
} from './toolpath';

/**
 * Pure-data description of a CAM job: the stock plus the ordered list of
 * operations. No store or UI dependencies — the app layer owns instances and
 * calls generateOperationToolpath for each enabled operation.
 */
export interface CAMSetup {
  stock: { mode: 'bounding-box'; margin: number } | { mode: 'box'; min: Vec3; max: Vec3 };
  /** Traverse height above the stock top (machine Z, mm). */
  safeZAboveStock: number;
  operations: CAMOperation[];
}

export interface CAMOperation {
  id: string;
  name: string;
  /** Disabled operations are skipped by the caller; generation ignores this. */
  enabled: boolean;
  type: 'pocket' | 'contour' | 'drill' | 'face';
  bodyId: string;
  toolId: string;
  params: CAMParameters;
  /** Drill targets in the planning plane; auto-detected when omitted/empty. */
  holes?: Array<{ x: number; z: number; depth: number }>;
}

/** A fresh, empty setup: bounding-box stock with 2 mm margin and no ops. */
export function defaultCamSetup(): CAMSetup {
  return {
    stock: { mode: 'bounding-box', margin: 2 },
    safeZAboveStock: 5,
    operations: [],
  };
}

/**
 * Generate the toolpath for one operation against its body. Drill operations
 * use op.holes when non-empty, otherwise holes are auto-detected on the body
 * (detectCircularHoles); if none are found the operation falls back to a
 * single hole at the top-view centre of the body.
 */
export function generateOperationToolpath(
  op: CAMOperation,
  body: SolidBody,
  tool: CuttingTool,
): Toolpath {
  switch (op.type) {
    case 'contour':
      return generateContourToolpath(body, tool, op.params, {
        allowance: op.params.allowance,
      });
    case 'pocket':
      return generatePocketToolpath(computeBoundingBox(body), tool, op.params, {
        body,
        allowance: op.params.allowance,
      });
    case 'face':
      return generateFaceToolpath(computeBoundingBox(body), tool, op.params);
    case 'drill': {
      let holes: Array<{ x: number; z: number; depth: number }> =
        op.holes && op.holes.length > 0
          ? op.holes
          : detectCircularHoles(body).map((h) => ({
              x: h.centre.x,
              z: h.centre.z,
              depth: h.depth,
            }));
      if (holes.length === 0) {
        // Fallback: one hole at the body's top-view centre, full depth.
        const bb = computeBoundingBox(body);
        holes = [
          {
            x: (bb.min.x + bb.max.x) / 2,
            z: (bb.min.z + bb.max.z) / 2,
            depth: op.params.stockTop - op.params.stockBottom,
          },
        ];
      }
      return generateDrillToolpath(holes, tool, op.params);
    }
  }
}
