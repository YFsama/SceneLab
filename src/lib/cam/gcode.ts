import type { Toolpath, GCodeLine, ToolpathPoint } from './types';
import { safeMargin } from './toolpath';
import { fitArcs, type ArcSpec } from './arcFit';

/**
 * Machine dialects for the post-processor.
 * - grbl: no canned cycles (peck drilling is expanded) and no M6 (tool
 *   changes become `; M6 T…` pause comments).
 * - linuxcnc: real G83/G80 peck cycles and M6 tool changes; ends with M30.
 */
export type MachineProfile = 'grbl' | 'linuxcnc';

/** Post-processor options. `arcTolerance` ≤ 0 disables arc fitting. */
export interface GCodeOptions {
  /** Max deviation between fitted arcs and the polyline (mm). Default 0.01. */
  arcTolerance?: number;
}

const DEFAULT_ARC_TOLERANCE = 0.01; // mm

function fmt(n: number): string {
  return n.toFixed(3);
}

/**
 * Arc coordinates and I/J offsets get one decimal more than linear moves:
 * GRBL's classic "error 33: arc target invalid" fires when rounding makes the
 * implied start/end radii inconsistent, so the arc path keeps 4 places while
 * G0/G1 stay at 3 to avoid diff noise in straight-move programs.
 */
function fmtArc(n: number): string {
  return (Math.abs(n) < 5e-5 ? 0 : n).toFixed(4);
}

function isArcSpec(item: ToolpathPoint | ArcSpec): item is ArcSpec {
  return 'center' in item;
}

/**
 * Program-level traverse height (machine Z). Always at least the op's
 * safeZAboveStock margin (serialized in the setup) and never below the
 * historical 10 mm envelope, so tool-change retractions clear a raised
 * safe margin too.
 */
function programSafeZ(tp: Toolpath | undefined): number {
  const base = tp?.params.stockTop ?? 0;
  const margin = tp ? safeMargin(tp.params) : 10;
  return base + Math.max(10, margin);
}

interface EmitState {
  /** Last feed word emitted; F is modal so it is only re-emitted on change. */
  lastFeed?: number;
}

/** Emit one G0/G1 move to a toolpath point (scene (x, y, z) → machine X = x, Y = z, Z = y). */
function emitPoint(tp: Toolpath, p: ToolpathPoint, state: EmitState, lines: GCodeLine[]): void {
  const xyz = `X${fmt(p.x)} Y${fmt(p.z)} Z${fmt(p.y)}`;
  if (p.rapid) {
    lines.push({ code: `G0 ${xyz}` });
  } else {
    const feed = p.feedRate ?? tp.params.feedRate;
    if (feed !== state.lastFeed) {
      lines.push({ code: `G1 ${xyz} F${feed}` });
      state.lastFeed = feed;
    } else {
      lines.push({ code: `G1 ${xyz}` });
    }
  }
}

/** Emit one fitted arc as `G2/G3 X Y Z I J [F]` — I/J are incremental center
 * offsets in the machine XY plane, ccw posts as G3. Feed follows the same
 * modal rule as G1 (re-emitted only on change, taken from the arc's end). */
function emitArc(tp: Toolpath, arc: ArcSpec, state: EmitState, lines: GCodeLine[]): void {
  // Defensive: fitArcs only forms arcs inside constant-y runs, so start and
  // end share the layer height. If one ever leaks through, degrade to the chord.
  if (Math.abs(arc.start.y - arc.end.y) > 1e-9) {
    emitPoint(tp, arc.end, state, lines);
    return;
  }
  const code =
    `${arc.ccw ? 'G3' : 'G2'} X${fmtArc(arc.end.x)} Y${fmtArc(arc.end.z)} Z${fmtArc(arc.end.y)}` +
    ` I${fmtArc(arc.center.x - arc.start.x)} J${fmtArc(arc.center.z - arc.start.z)}`;
  const feed = arc.end.feedRate ?? tp.params.feedRate;
  if (feed !== state.lastFeed) {
    lines.push({ code: `${code} F${feed}` });
    state.lastFeed = feed;
  } else {
    lines.push({ code });
  }
}

function emitMoves(
  tp: Toolpath,
  profile: MachineProfile,
  state: EmitState,
  lines: GCodeLine[],
  arcTolerance: number,
): void {
  if (tp.operation === 'drill') {
    emitDrillMoves(tp, profile, state, lines);
    return;
  }
  // Arc filtering (Mastercam-style): coplanar cutting runs post as G2/G3,
  // rapids/depth changes pass through untouched.
  const items = fitArcs(tp.points, arcTolerance);
  for (const item of items) {
    if (isArcSpec(item)) emitArc(tp, item, state, lines);
    else emitPoint(tp, item, state, lines);
  }
}

/**
 * Drill cycles. The generator emits one plunge cut per hole; the profile
 * decides how it is posted: GRBL gets an expanded peck cycle (G1 down at
 * plunge feed alternating with G0 retracts to the R plane), LinuxCNC gets a
 * canned G83 … R Q F followed by G80.
 */
function emitDrillMoves(
  tp: Toolpath,
  profile: MachineProfile,
  state: EmitState,
  lines: GCodeLine[],
): void {
  const { params } = tp;
  // Same R plane the generator used: the 2 mm approach clearance, never
  // above the op's safeZAboveStock margin (toolpath and G-code must agree).
  const retractR = params.stockTop + Math.min(2, safeMargin(params));
  const peck = Math.max(0.1, params.peckDepth ?? Math.max(0.5, tp.tool.diameter / 2));

  for (const p of tp.points) {
    if (p.rapid) {
      lines.push({ code: `G0 X${fmt(p.x)} Y${fmt(p.z)} Z${fmt(p.y)}` });
      continue;
    }

    const feed = p.feedRate ?? params.plungeRate;
    const depth = params.stockTop - p.y;
    if (depth <= 0) continue;

    if (profile === 'linuxcnc') {
      lines.push({
        code: `G83 X${fmt(p.x)} Y${fmt(p.z)} Z${fmt(p.y)} R${fmt(retractR)} Q${fmt(peck)} F${feed}`,
        comment: `Drill ⌀${tp.tool.diameter} to depth ${fmt(depth)}`,
      });
      state.lastFeed = feed;
    } else {
      const pecks = Math.max(1, Math.ceil(depth / peck - 1e-9));
      lines.push({
        code: '',
        comment: `Peck drill (${fmt(p.x)}, ${fmt(p.z)}) depth ${fmt(depth)} — ${pecks} peck(s)`,
      });
      for (let i = 1; i <= pecks; i++) {
        const y = params.stockTop - Math.min(i * peck, depth);
        if (feed !== state.lastFeed) {
          lines.push({ code: `G1 Z${fmt(y)} F${feed}` });
          state.lastFeed = feed;
        } else {
          lines.push({ code: `G1 Z${fmt(y)}` });
        }
        lines.push({ code: `G0 Z${fmt(retractR)}`, comment: 'Retract to R plane' });
      }
    }
  }

  if (profile === 'linuxcnc') {
    lines.push({ code: 'G80', comment: 'Cancel drill cycle' });
  }
}

/** Emit one complete program for the given toolpaths. */
function emitProgram(toolpaths: Toolpath[], profile: MachineProfile, arcTolerance: number): string {
  const lines: GCodeLine[] = [];
  const state: EmitState = {};
  const last = toolpaths[toolpaths.length - 1];
  const safeZ = programSafeZ(toolpaths[0] ?? last);

  lines.push({ code: '', comment: 'SceneLab CAM G-code' });
  lines.push({ code: '', comment: `Generated: ${new Date().toISOString()}` });
  lines.push({ code: '', comment: `Toolpaths: ${toolpaths.length}` });
  lines.push({ code: '', comment: `Profile: ${profile}` });
  lines.push({ code: 'G90', comment: 'Absolute positioning' });
  lines.push({ code: 'G21', comment: 'Metric (mm)' });
  lines.push({ code: 'G17', comment: 'XY plane' });
  lines.push({ code: 'G94', comment: 'Feed per minute' });
  // Z-only rapid FIRST so no XY traverse can happen below the safe height.
  lines.push({ code: `G0 Z${fmt(safeZ)}`, comment: 'Safe height before first XY move' });

  const toolNumbers = new Map<string, number>();
  const toolNumber = (id: string): number => {
    let n = toolNumbers.get(id);
    if (n === undefined) {
      n = toolNumbers.size + 1;
      toolNumbers.set(id, n);
    }
    return n;
  };

  let prevToolId: string | undefined;
  for (let i = 0; i < toolpaths.length; i++) {
    const tp = toolpaths[i]!;
    lines.push({ code: '', comment: `=== Toolpath ${i + 1}: ${tp.name} ===` });
    lines.push({ code: '', comment: `Tool: ${tp.tool.name} (T${toolNumber(tp.tool.id)})` });
    lines.push({ code: '', comment: `Operation: ${tp.operation}` });

    if (i > 0) {
      if (tp.tool.id !== prevToolId) {
        lines.push({ code: `G0 Z${fmt(programSafeZ(tp))}`, comment: 'Retract for tool change' });
        lines.push({ code: 'M5', comment: 'Stop spindle' });
        if (profile === 'linuxcnc') {
          lines.push({ code: `M6 T${toolNumber(tp.tool.id)}`, comment: 'Tool change' });
        } else {
          lines.push({ code: '', comment: `M6 T${toolNumber(tp.tool.id)} — pause and change tool, cycle start to resume` });
        }
      }
    }

    lines.push({ code: `M3 S${tp.params.spindleSpeed}`, comment: 'Start spindle' });
    lines.push({ code: 'G4 P1', comment: 'Dwell 1s for spindle ramp-up' });
    emitMoves(tp, profile, state, lines, arcTolerance);
    prevToolId = tp.tool.id;
  }

  // Single footer: spindle off, retract, park, end.
  lines.push({ code: 'M5', comment: 'Stop spindle' });
  lines.push({ code: `G0 Z${fmt(programSafeZ(last))}`, comment: 'Retract' });
  lines.push({ code: 'G0 X0 Y0', comment: 'Return to origin' });
  lines.push({ code: profile === 'linuxcnc' ? 'M30' : 'M2', comment: 'Program end' });

  return (
    lines
      .map((l) => {
        if (l.comment && l.code) return `${l.code} ; ${l.comment}`;
        if (l.comment) return `; ${l.comment}`;
        return l.code;
      })
      .join('\n') + '\n'
  );
}

/** Generate G-code for a single toolpath. */
export function generateGCode(
  toolpath: Toolpath,
  profile: MachineProfile = 'grbl',
  options: GCodeOptions = {},
): string {
  return emitProgram([toolpath], profile, options.arcTolerance ?? DEFAULT_ARC_TOLERANCE);
}

/** Generate one G-code program for multiple toolpaths (single M2/M30). */
export function generateMultiToolGCode(
  toolpaths: Toolpath[],
  profile: MachineProfile = 'grbl',
  options: GCodeOptions = {},
): string {
  return emitProgram(toolpaths, profile, options.arcTolerance ?? DEFAULT_ARC_TOLERANCE);
}

const RAPID_RATE = 5000; // mm/min

/** Estimate machining time in minutes. Returns 0 for non-positive feed rates. */
export function estimateMachiningTime(toolpath: Toolpath): number {
  let totalTime = 0;

  // Walk the moves in execution order so each segment's length reflects the
  // real motion (including rapid↔cut transitions). Rapids move at the rapid
  // rate; cuts at the per-move or default feed rate (guarding feed > 0).
  // Times are computed from the ORIGINAL polyline even when the post emits
  // fitted arcs: a chord understates its arc by Δθ²/24 per segment, well
  // under 0.01 % at CAM subdivision densities — the estimate's accuracy is
  // unchanged by arc filtering.
  const moves = toolpath.points;
  for (let i = 1; i < moves.length; i++) {
    const curr = moves[i]!;
    const seg = distance(moves[i - 1]!, curr);
    if (curr.rapid) {
      totalTime += seg / RAPID_RATE;
    } else {
      const feed = curr.feedRate ?? toolpath.params.feedRate;
      if (feed > 0) totalTime += seg / feed;
    }
  }

  return totalTime;
}

/** Alias kept for the setup/UI layer's naming. */
export const estimateTime = estimateMachiningTime;

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
