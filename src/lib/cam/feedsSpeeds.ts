import type { ToolDefinition } from './types';

export type WorkMaterial =
  | 'aluminum'
  | 'brass'
  | 'softwood'
  | 'hardwood'
  | 'mdf'
  | 'acrylic'
  | 'steel'
  | 'pcb';

/** Baseline carbide cutting speed (Vc, m/min) and chip load (fz, mm/tooth at ~6mm). */
const MATERIAL_TABLE: Record<WorkMaterial, { vc: number; fz: number }> = {
  aluminum: { vc: 300, fz: 0.05 },
  brass: { vc: 200, fz: 0.05 },
  softwood: { vc: 200, fz: 0.1 },
  hardwood: { vc: 150, fz: 0.08 },
  mdf: { vc: 250, fz: 0.1 },
  acrylic: { vc: 150, fz: 0.05 },
  steel: { vc: 80, fz: 0.02 },
  pcb: { vc: 120, fz: 0.02 },
};

/** Tool-material derating relative to carbide. */
const TOOL_FACTOR: Record<ToolDefinition['material'], number> = {
  carbide: 1,
  cobalt: 0.8,
  hss: 0.55,
};

export interface FeedsSpeedsOptions {
  /** Spindle RPM ceiling (default 24000). */
  maxRpm?: number;
  /** Spindle RPM floor (default 1000). */
  minRpm?: number;
}

export interface FeedsSpeeds {
  spindleRpm: number;
  feedRate: number; // mm/min
  plungeRate: number; // mm/min
  surfaceSpeed: number; // Vc, m/min — actually achieved at the (clamped) RPM
  chipLoad: number; // fz, mm/tooth
}

/**
 * Recommend spindle speed and feed rate for a tool/material pair using standard
 * machining formulas:
 *   RPM  = Vc·1000 / (π·D)
 *   feed = RPM · fz · flutes
 * Chip load is scaled down for small-diameter tools, and RPM is clamped to the
 * spindle's range. A practical starting point, not a substitute for testing.
 */
export function computeFeedsAndSpeeds(
  tool: ToolDefinition,
  material: WorkMaterial,
  options: FeedsSpeedsOptions = {},
): FeedsSpeeds {
  const base = MATERIAL_TABLE[material];
  const toolFactor = TOOL_FACTOR[tool.material];
  const maxRpm = options.maxRpm ?? 24000;
  const minRpm = options.minRpm ?? 1000;

  const targetVc = base.vc * toolFactor; // m/min
  const diameter = Math.max(0.1, tool.diameter);
  const idealRpm = (targetVc * 1000) / (Math.PI * diameter);
  const spindleRpm = Math.max(minRpm, Math.min(maxRpm, idealRpm));

  // Surface speed actually achieved at the clamped RPM — when the spindle can't
  // reach idealRpm (tiny tool) or floors out (huge tool), the real Vc differs
  // from the target, so report what the tool will actually see.
  const achievedVc = (Math.PI * diameter * spindleRpm) / 1000;

  // Smaller tools take a lighter chip; scale fz down below ~6mm.
  const chipLoad = base.fz * Math.min(1, diameter / 6);
  const flutes = Math.max(1, tool.flutes);
  const feedRate = spindleRpm * chipLoad * flutes;

  return {
    spindleRpm: Math.round(spindleRpm),
    feedRate: Math.round(feedRate),
    plungeRate: Math.round(feedRate * 0.4),
    surfaceSpeed: Math.round(achievedVc),
    chipLoad: Number(chipLoad.toFixed(4)),
  };
}
