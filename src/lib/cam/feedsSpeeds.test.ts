import { describe, it, expect } from 'vitest';
import { computeFeedsAndSpeeds } from './feedsSpeeds';
import type { ToolDefinition } from './types';

function tool(partial: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 't',
    name: 'test',
    type: 'endmill',
    diameter: 6,
    fluteLength: 20,
    overallLength: 50,
    flutes: 2,
    material: 'carbide',
    ...partial,
  };
}

describe('computeFeedsAndSpeeds', () => {
  it('uses the standard RPM and feed formulas for aluminium', () => {
    const fs = computeFeedsAndSpeeds(tool({ diameter: 6, flutes: 2 }), 'aluminum');
    // Vc 300 → RPM = 300000/(π·6) ≈ 15915
    expect(fs.surfaceSpeed).toBe(300);
    expect(fs.spindleRpm).toBeCloseTo(15915, -1);
    expect(fs.chipLoad).toBeCloseTo(0.05, 5);
    // feed = RPM · fz · flutes ≈ 15915 · 0.05 · 2 ≈ 1592
    expect(fs.feedRate).toBeCloseTo(1592, -1);
    expect(fs.plungeRate).toBeCloseTo(Math.round(fs.feedRate * 0.4), 0);
  });

  it('derates surface speed for HSS tools', () => {
    const fs = computeFeedsAndSpeeds(tool({ material: 'hss' }), 'steel');
    expect(fs.surfaceSpeed).toBe(Math.round(80 * 0.55)); // 44
  });

  it('clamps RPM to the spindle ceiling for tiny tools', () => {
    const fs = computeFeedsAndSpeeds(tool({ diameter: 1 }), 'aluminum', { maxRpm: 24000 });
    expect(fs.spindleRpm).toBe(24000);
    // chip load scales down for the small tool (reported to 4 dp)
    expect(fs.chipLoad).toBeCloseTo(0.0083, 4);
  });

  it('clamps RPM to the floor for large tools', () => {
    const fs = computeFeedsAndSpeeds(tool({ diameter: 100, material: 'hss' }), 'steel', { minRpm: 1000 });
    expect(fs.spindleRpm).toBe(1000);
  });
});
