import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import { safeMargin } from './toolpath';

/**
 * Engraving source geometry: one point of a stroke in the PLANNING plane,
 * (x, z) = (body x, body z) — the same pair every other generator plans in.
 */
export interface EngravePoint {
  x: number;
  z: number;
}

let nextId = 1;

/** Depth levels for engraving: stockTop down to stockTop − total, one doc at a
 * time (the depthLevels arithmetic, based on engraveDepth instead of the stock
 * thickness — an engrave cut is usually far shallower than the stock). */
function engraveLevels(params: CAMParameters, total: number): number[] {
  if (!(total > 0)) return [];
  const doc =
    Number.isFinite(params.depthOfCut) && params.depthOfCut > 0
      ? Math.max(params.depthOfCut, 0.01)
      : total; // no usable step: one full-depth pass rather than 0.01 mm shavings
  const n = Math.max(1, Math.ceil(total / doc - 1e-9));
  const levels: number[] = [];
  for (let i = 1; i <= n; i++) levels.push(params.stockTop - Math.min(i * doc, total));
  return levels;
}

/**
 * Engrave along polylines, stepping down by depthOfCut to engraveDepth
 * (default: one pass at depthOfCut). Scene coordinates follow the module
 * convention: {x: u, y: stockTop − depth, z: v}, plunge axis always y.
 *
 * Per level, per stroke (input order kept — no nearest-neighbour reordering,
 * so regeneration is deterministic): rapid to the stroke start at the safe
 * height, drop to the feed plane (stockTop + 1, never a G0 onto the estimated
 * surface), plunge to the level at the plunge feed, cut along the stroke at
 * the cut feed, then retract to safe at the stroke end. Strokes shorter than
 * two points are skipped; with nothing left (or no usable depth) the result
 * is an EMPTY toolpath the panel can show honestly at zero time.
 */
export function generateEngraveToolpath(
  curves: EngravePoint[][],
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  // MoveList semantics mirrored 1:1 from toolpath.ts (the class there is
  // module-private): rapid ⇒ G0, cut ⇒ G1 at params.feedRate, plunge ⇒ G1 at
  // params.plungeRate.
  const points: ToolpathPoint[] = [];
  const rapid = (p: { x: number; y: number; z: number }): void => {
    points.push({ ...p, rapid: true });
  };
  const cut = (p: { x: number; y: number; z: number }): void => {
    points.push({ ...p, rapid: false });
  };
  const plunge = (p: { x: number; y: number; z: number }): void => {
    points.push({ ...p, rapid: false, feedRate: params.plungeRate });
  };

  const make = (moves: ToolpathPoint[]): Toolpath => ({
    id: `engrave_${nextId++}`,
    name: 'Engrave',
    operation: 'engrave',
    tool,
    params,
    points: moves,
    rapidMoves: moves.filter((p) => p.rapid === true),
    cuttingMoves: moves.filter((p) => p.rapid !== true),
  });

  const strokes = curves.filter((c) => Array.isArray(c) && c.length >= 2);
  // Total engrave depth below the stock top: engraveDepth when valid, else
  // depthOfCut (the single-pass default); neither usable ⇒ nothing to cut.
  const ed = params.engraveDepth;
  const total =
    typeof ed === 'number' && Number.isFinite(ed) && ed > 0
      ? ed
      : Number.isFinite(params.depthOfCut) && params.depthOfCut > 0
        ? params.depthOfCut
        : 0;
  const levels = engraveLevels(params, total);
  if (strokes.length === 0 || levels.length === 0) return make([]);

  const safe = params.stockTop + safeMargin(params);
  const feedPlane = params.stockTop + 1;

  for (const yLevel of levels) {
    for (const stroke of strokes) {
      const start = stroke[0]!;
      rapid({ x: start.x, y: safe, z: start.z });
      rapid({ x: start.x, y: feedPlane, z: start.z });
      plunge({ x: start.x, y: yLevel, z: start.z });
      for (let i = 1; i < stroke.length; i++) {
        const p = stroke[i]!;
        cut({ x: p.x, y: yLevel, z: p.z });
      }
      const end = stroke[stroke.length - 1]!;
      rapid({ x: end.x, y: safe, z: end.z });
    }
  }

  return make(points);
}
