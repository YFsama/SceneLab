import type { Toolpath, GCodeLine } from './types';

/** Generate G-code from a toolpath */
export function generateGCode(toolpath: Toolpath): string {
  const lines: GCodeLine[] = [];

  // Header
  lines.push({ code: 'G90', comment: 'Absolute positioning' });
  lines.push({ code: 'G21', comment: 'Metric (mm)' });
  lines.push({ code: 'G17', comment: 'XY plane' });
  lines.push({ code: '', comment: `Tool: ${toolpath.tool.name}` });
  lines.push({ code: '', comment: `Operation: ${toolpath.operation}` });
  lines.push({ code: '', comment: `Feed: ${toolpath.params.feedRate} mm/min` });
  lines.push({ code: '', comment: `Spindle: ${toolpath.params.spindleSpeed} RPM` });

  // Start spindle
  lines.push({ code: `M3 S${toolpath.params.spindleSpeed}`, comment: 'Start spindle' });
  lines.push({ code: 'G4 P1', comment: 'Dwell 1s for spindle ramp-up' });

  // Emit moves in their true execution order so the G-code matches the tool
  // motion: rapids (G0) and cuts (G1) are interleaved, not batched.
  for (const point of toolpath.points) {
    const xyz = `X${point.x.toFixed(3)} Y${point.y.toFixed(3)} Z${point.z.toFixed(3)}`;
    if (point.rapid) {
      lines.push({ code: `G0 ${xyz}` });
    } else {
      const feed = point.feedRate ?? toolpath.params.feedRate;
      lines.push({ code: `G1 ${xyz} F${feed}` });
    }
  }

  // End
  lines.push({ code: '', comment: 'End of toolpath' });
  lines.push({ code: 'G0 Z' + (toolpath.params.stockTop + 10).toFixed(1), comment: 'Retract' });
  lines.push({ code: 'M5', comment: 'Stop spindle' });
  lines.push({ code: 'G0 X0 Y0', comment: 'Return to origin' });
  lines.push({ code: 'M2', comment: 'Program end' });

  return lines
    .map((l) => {
      if (l.comment && l.code) return `${l.code} ; ${l.comment}`;
      if (l.comment) return `; ${l.comment}`;
      return l.code;
    })
    .join('\n');
}

/** Generate G-code for multiple toolpaths */
export function generateMultiToolGCode(toolpaths: Toolpath[]): string {
  const sections: string[] = [];

  sections.push('; SceneLab CAM G-code');
  sections.push(`; Generated: ${new Date().toISOString()}`);
  sections.push(`; Toolpaths: ${toolpaths.length}`);
  sections.push('');

  for (let i = 0; i < toolpaths.length; i++) {
    const tp = toolpaths[i]!;
    sections.push(`; === Toolpath ${i + 1}: ${tp.name} ===`);
    sections.push(generateGCode(tp));
    sections.push('');
  }

  return sections.join('\n');
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

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
