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
import { generateEngraveToolpath } from './engrave';

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
  type: 'pocket' | 'contour' | 'drill' | 'face' | 'engrave';
  bodyId: string;
  toolId: string;
  params: CAMParameters;
  /** Drill targets in the planning plane; auto-detected when omitted/empty. */
  holes?: Array<{ x: number; z: number; depth: number }>;
  /** Engrave source text (kept for re-editing); curves below are the baked source of truth. */
  text?: { content: string; font: string; size: number; spacing: number; origin: { x: number; z: number } };
  /** Engrave polylines in the planning plane (each = one continuous stroke, open or closed). */
  curves?: Array<Array<{ x: number; z: number }>>;
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
 * (detectCircularHoles). With neither, the operation THROWS — the old
 * silent fallback (one hole at the body's top-view centre, full depth) would
 * drill an unrequested hole straight through the part — and the caller's
 * try/catch (resolveCamToolpath) drops the op from the cache so the panel's
 * stale flag surfaces the problem instead. Engrave operations likewise throw
 * without op.curves (the baked source of truth; op.text is re-editing state
 * only).
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
      const holes: Array<{ x: number; z: number; depth: number }> =
        op.holes && op.holes.length > 0
          ? op.holes
          : detectCircularHoles(body).map((h) => ({
              x: h.centre.x,
              z: h.centre.z,
              depth: h.depth,
            }));
      if (holes.length === 0) {
        // No explicit pins and nothing detectable: refuse rather than guess.
        // The throw is descriptive on purpose — it names both remedies, and
        // callers that surface errors (instead of dropping the op) can show
        // it verbatim.
        throw new Error(
          `drill operation "${op.name}" found no circular holes on body "${body.name}" — ` +
            'pin holes explicitly or check the body',
        );
      }
      return generateDrillToolpath(holes, tool, op.params);
    }
    case 'engrave': {
      // curves are the baked source of truth; op.text is only the re-editing
      // source and is deliberately NOT consulted here (or anywhere in
      // generation) — regenerating from stale text would silently discard
      // user edits baked into curves.
      if (!op.curves || op.curves.length === 0) {
        // Same refusal style as drill without holes: name both remedies so
        // the error can be surfaced verbatim by callers that show it.
        throw new Error(
          `engrave operation "${op.name}" has no curves — enter text in the panel ` +
            'or bake curves before generating',
        );
      }
      return generateEngraveToolpath(op.curves, tool, op.params);
    }
  }
}
