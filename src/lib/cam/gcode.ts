import type { Toolpath, GCodeLine } from './types';

/**
 * Machine dialects for the post-processor.
 * - grbl: no canned cycles (peck drilling is expanded) and no M6 (tool
 *   changes become `; M6 T…` pause comments).
 * - linuxcnc: real G83/G80 peck cycles and M6 tool changes; ends with M30.
 */
export type MachineProfile = 'grbl' | 'linuxcnc';

function fmt(n: number): string {
  return n.toFixed(3);
}

/** Safe program-level traverse height (machine Z). */
function programSafeZ(tp: Toolpath | undefined): number {
  return (tp?.params.stockTop ?? 0) + 10;
}

interface EmitState {
  /** Last feed word emitted; F is modal so it is only re-emitted on change. */
  lastFeed?: number;
}

function emitMoves(tp: Toolpath, profile: MachineProfile, state: EmitState, lines: GCodeLine[]): void {
  if (tp.operation === 'drill') {
    emitDrillMoves(tp, profile, state, lines);
    return;
  }
  for (const p of tp.points) {
    // Scene (x, y, z) → machine X = x, Y = z, Z = y.
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
  const retractR = params.stockTop + 2;
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
function emitProgram(toolpaths: Toolpath[], profile: MachineProfile): string {
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
    emitMoves(tp, profile, state, lines);
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
export function generateGCode(toolpath: Toolpath, profile: MachineProfile = 'grbl'): string {
  return emitProgram([toolpath], profile);
}

/** Generate one G-code program for multiple toolpaths (single M2/M30). */
export function generateMultiToolGCode(toolpaths: Toolpath[], profile: MachineProfile = 'grbl'): string {
  return emitProgram(toolpaths, profile);
}

const RAPID_RATE = 5000; // mm/min

/** Estimate machining time in minutes. Returns 0 for non-positive feed rates. */
export function estimateMachiningTime(toolpath: Toolpath): number {
  let totalTime = 0;

  // Walk the moves in execution order so each segment's length reflects the
  // real motion (including rapid↔cut transitions). Rapids move at the rapid
  // rate; cuts at the per-move or default feed rate (guarding feed > 0).
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
