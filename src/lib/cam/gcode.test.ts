import { describe, it, expect } from 'vitest';
import { generateGCode, generateMultiToolGCode, estimateMachiningTime } from './gcode';
import { generateContourToolpath } from './toolpath';
import { createCylinder, createBox } from '../geometry/brep';
import type { Toolpath, ToolpathPoint } from './types';

const em6 = { id: 'em-6mm', name: '6mm Endmill', diameter: 6, flutes: 2, type: 'endmill' as const, fluteLength: 20, overallLength: 50, material: 'carbide' as const };
const em3 = { ...em6, id: 'em-3mm', name: '3mm Endmill', diameter: 3 };

const PARAMS = { feedRate: 1000, plungeRate: 500, spindleSpeed: 10000, depthOfCut: 2, stepover: 3, stockTop: 5, stockBottom: -5 };

const makeToolpath = (overrides: Partial<Toolpath> = {}): Toolpath => ({
  id: 'tp-test',
  name: 'Test Toolpath',
  operation: 'pocket',
  tool: em6,
  params: { ...PARAMS },
  points: [
    { x: 0, y: 15, z: 10, rapid: true },
    { x: 0, y: 5, z: 10, rapid: false },
    { x: 10, y: 5, z: 0, rapid: false },
    { x: 10, y: 5, z: 10, rapid: false },
  ],
  rapidMoves: [],
  cuttingMoves: [],
  ...overrides,
});

describe('generateGCode — program shape', () => {
  it('starts with G90/G21/G17/G94 header', () => {
    const lines = generateGCode(makeToolpath()).split('\n');
    const codes = lines.filter((l) => /^[GM]\d/.test(l)).map((l) => l.split(/[ ;]/)[0]);
    expect(codes.slice(0, 4)).toEqual(['G90', 'G21', 'G17', 'G94']);
  });

  it('the first motion is a Z-only rapid to safe height', () => {
    const lines = generateGCode(makeToolpath()).split('\n');
    const firstMotion = lines.find((l) => /^G[01] /.test(l))!;
    const code = firstMotion.split(' ;')[0]!;
    expect(code).toMatch(/^G0 Z/);
    expect(code).not.toMatch(/[XY]/);
    expect(code).toContain(`Z${(PARAMS.stockTop + 10).toFixed(3)}`);
  });

  it('footer order is M5 → safe Z retract → X0 Y0 → M2', () => {
    const lines = generateGCode(makeToolpath()).split('\n');
    const lastIdx = (re: RegExp) => lines.reduce((acc, l, i) => (re.test(l) ? i : acc), -1);
    const m2 = lines.findIndex((l) => /^M2/.test(l));
    const origin = lines.findIndex((l) => /^G0 X0 Y0/.test(l));
    const retract = lastIdx(/^G0 Z/);
    const m5 = lastIdx(/^M5/);
    expect(m5).toBeGreaterThan(-1);
    expect(m5).toBeLessThan(retract);
    expect(retract).toBeLessThan(origin);
    expect(origin).toBeLessThan(m2);
  });

  it('ends with exactly one M2 and a single trailing newline', () => {
    const g = generateGCode(makeToolpath());
    expect(g.match(/^M2/gm)).toHaveLength(1);
    expect(g.endsWith('\n')).toBe(true);
    expect(g.endsWith('\n\n')).toBe(false);
  });

  it('maps scene (x, y, z) to machine X = x, Y = z, Z = y', () => {
    const g = generateGCode(
      makeToolpath({ points: [{ x: 1, y: 2, z: 3, rapid: true }] }),
    );
    expect(g).toContain('G0 X1.000 Y3.000 Z2.000');
  });

  it('starts spindle with M3 S…', () => {
    expect(generateGCode(makeToolpath())).toContain('M3 S10000');
  });

  it('emits F modally — once per feed change, not per G1', () => {
    const g = generateGCode(makeToolpath());
    const g1s = g.split('\n').filter((l) => /^G1 /.test(l));
    expect(g1s.length).toBeGreaterThanOrEqual(3);
    expect(g.match(/ F\d+(\.\d+)?/g)).toHaveLength(1); // all cuts share F1000
  });
});

describe('generateMultiToolGCode — one program for many toolpaths', () => {
  it('contains exactly ONE M2 across two operations', () => {
    const g = generateMultiToolGCode([makeToolpath(), makeToolpath({ name: 'Second' })]);
    expect(g.match(/^M2/gm)).toHaveLength(1);
    expect(g).toContain('Toolpaths: 2');
    expect(g).toContain('Toolpath 1');
    expect(g).toContain('Toolpath 2');
  });

  it('no XY traverse before the initial Z-only G0', () => {
    const g = generateMultiToolGCode([makeToolpath(), makeToolpath({ name: 'Second', tool: em3 })]);
    const lines = g.split('\n');
    const firstMotionIdx = lines.findIndex((l) => /^G[01] /.test(l));
    expect(firstMotionIdx).toBeGreaterThan(-1);
    expect(lines[firstMotionIdx]!).toMatch(/^G0 Z[-\d]/);
    for (let i = 0; i < firstMotionIdx; i++) {
      expect(lines[i]!).not.toMatch(/X-?\d/);
    }
  });

  it('retracts and stops the spindle before a tool change', () => {
    const g = generateMultiToolGCode([makeToolpath(), makeToolpath({ name: 'Second', tool: em3 })]);
    const lines = g.split('\n');
    const retractIdx = lines.findIndex((l) => /^G0 Z[\d.]+ ; Retract for tool change/.test(l));
    const m5Idx = lines.findIndex((l) => l.startsWith('M5'));
    const m6Idx = lines.findIndex((l) => /M6 T2/.test(l));
    const m3Idxs = lines.map((l, i) => (l.startsWith('M3') ? i : -1)).filter((i) => i >= 0);
    expect(retractIdx).toBeGreaterThan(-1);
    expect(m5Idx).toBeGreaterThan(retractIdx);
    expect(m6Idx).toBeGreaterThan(m5Idx);
    expect(m3Idxs[1]!).toBeGreaterThan(m6Idx);
  });

  it('GRBL profile: tool change is a pause comment, not a real M6', () => {
    const g = generateMultiToolGCode(
      [makeToolpath(), makeToolpath({ name: 'Second', tool: em3 })],
      'grbl',
    );
    expect(g).toMatch(/^; M6 T2/gm);
    expect(g).not.toMatch(/^M6 /gm);
  });

  it('LinuxCNC profile: real M6 and ends with M30', () => {
    const g = generateMultiToolGCode(
      [makeToolpath(), makeToolpath({ name: 'Second', tool: em3 })],
      'linuxcnc',
    );
    expect(g).toMatch(/^M6 T2/gm);
    const lines = g.split('\n');
    expect(lines[lines.length - 2]!).toMatch(/^M30/); // last code line
    expect(g).not.toMatch(/^M2 /gm);
  });

  it('F stays modal across operations with the same feed', () => {
    const a = makeToolpath();
    const b = makeToolpath({ name: 'Second', tool: em3, params: { ...PARAMS, spindleSpeed: 12000 } });
    const g = generateMultiToolGCode([a, b]);
    expect(g.match(/ F\d+(\.\d+)?/g)).toHaveLength(1);
  });
});

describe('drill cycles per machine profile', () => {
  const drillTp = makeToolpath({
    operation: 'drill',
    tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
    params: { ...PARAMS, peckDepth: 2 },
    points: [
      { x: 10, y: 10, z: 4, rapid: true }, // safe
      { x: 10, y: 7, z: 4, rapid: true }, // R plane (stockTop+2)
      { x: 10, y: 0, z: 4, rapid: false, feedRate: 500 }, // plunge: depth 5
      { x: 10, y: 10, z: 4, rapid: true }, // retract
    ],
  });

  it('GRBL expands pecking: ceil(depth/peckDepth) G1 plunges at plunge feed', () => {
    const g = generateGCode(drillTp, 'grbl');
    const pecks = g.split('\n').filter((l) => /^G1 Z/.test(l));
    expect(pecks).toHaveLength(Math.ceil(5 / 2)); // 3 pecks
    expect(g.match(/ F500/g)).toHaveLength(1); // modal F
    // Each peck retracts to the R plane.
    expect(g.split('\n').filter((l) => /^G0 Z7\.000/.test(l))).toHaveLength(3);
    expect(g).not.toContain('G83');
  });

  it('LinuxCNC emits a canned G83 with R/Q/F followed by G80', () => {
    const g = generateGCode(drillTp, 'linuxcnc');
    expect(g).toMatch(/G83 X10\.000 Y4\.000 Z0\.000 R7\.000 Q2\.000 F500/);
    const g83 = g.indexOf('G83');
    const g80 = g.indexOf('G80');
    expect(g80).toBeGreaterThan(g83);
    expect(g).not.toMatch(/^G1 Z/gm);
  });

  it('default peck depth is derived from the tool when not set', () => {
    const noPeck = makeToolpath({
      operation: 'drill',
      tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
      points: drillTp.points,
    });
    const g = generateGCode(noPeck, 'linuxcnc');
    expect(g).toMatch(/Q3\.000/); // max(0.5, 6/2)
  });
});

// ---------------------------------------------------------------------------
// Drill cycle variants (simple / dwell / peck) and the optional G54 WCS word
// ---------------------------------------------------------------------------

/** Contract drill-cycle fields on CAMParameters (the parameters owner lands
 * them; spread into the fixture so it type-checks before that merge). */
type DrillCycleFields = { drillCycle?: 'peck' | 'simple' | 'dwell'; dwellSeconds?: number };

/** Same hole as the legacy drillTp above (depth 5, R plane Z7, F500). */
const drillCycleTp = (fields: DrillCycleFields = {}): Toolpath =>
  makeToolpath({
    operation: 'drill',
    tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
    params: { ...PARAMS, peckDepth: 2, ...fields },
    points: [
      { x: 10, y: 10, z: 4, rapid: true }, // safe
      { x: 10, y: 7, z: 4, rapid: true }, // R plane (stockTop+2)
      { x: 10, y: 0, z: 4, rapid: false, feedRate: 500 }, // plunge: depth 5
      { x: 10, y: 10, z: 4, rapid: true }, // retract
    ],
  });

describe('drill cycle variants — 3 cycles × 2 profiles', () => {
  it("LinuxCNC 'simple': canned G81 (no Q/P), cancelled by G80, no expansion", () => {
    const g = generateGCode(drillCycleTp({ drillCycle: 'simple' }), 'linuxcnc');
    expect(g).toMatch(/^G81 X10\.000 Y4\.000 Z0\.000 R7\.000 F500 ; Simple drill /m);
    expect(g).not.toContain('G82');
    expect(g).not.toContain('G83');
    expect(g.indexOf('G80')).toBeGreaterThan(g.indexOf('G81'));
    expect(g).not.toMatch(/^G1 Z/gm);
  });

  it("LinuxCNC 'dwell': canned G82 with P seconds before F, cancelled by G80", () => {
    const g = generateGCode(drillCycleTp({ drillCycle: 'dwell' }), 'linuxcnc');
    expect(g).toMatch(/^G82 X10\.000 Y4\.000 Z0\.000 R7\.000 P0\.5 F500 ; Drill \+ dwell /m);
    expect(g).not.toContain('G81');
    expect(g).not.toContain('G83');
    expect(g.indexOf('G80')).toBeGreaterThan(g.indexOf('G82'));
  });

  it("LinuxCNC 'peck': still the legacy G83 R Q F + G80", () => {
    const g = generateGCode(drillCycleTp({ drillCycle: 'peck' }), 'linuxcnc');
    expect(g).toMatch(/^G83 X10\.000 Y4\.000 Z0\.000 R7\.000 Q2\.000 F500 ; Drill /m);
    expect(g.indexOf('G80')).toBeGreaterThan(g.indexOf('G83'));
  });

  it("GRBL 'simple': one plunge straight to depth, no intermediate retracts", () => {
    const g = generateGCode(drillCycleTp({ drillCycle: 'simple' }), 'grbl');
    const plunges = g.split('\n').filter((l) => /^G1 Z/.test(l));
    expect(plunges).toHaveLength(1); // single plunge to the bottom…
    expect(plunges[0]).toBe('G1 Z0.000 F500');
    // …then exactly ONE retract to the R plane (no per-peck G0 retractions).
    expect(g.split('\n').filter((l) => /^G0 Z7\.000/.test(l))).toHaveLength(1);
    expect(g).toContain('; Simple drill (10.000, 4.000) depth 5.000');
    expect(g).not.toContain('G8');
    expect(g.match(/^G4 /gm)).toHaveLength(1); // only the spindle ramp-up dwell
  });

  it("GRBL 'dwell': G4 P0.5 sits between the plunge and the R-plane retract", () => {
    const g = generateGCode(drillCycleTp({ drillCycle: 'dwell' }), 'grbl');
    const lines = g.split('\n');
    const plunge = lines.findIndex((l) => l.startsWith('G1 Z0.000'));
    const dwell = lines.findIndex((l) => /^G4 P0\.5 ; Dwell at full depth$/.test(l));
    const retract = lines.findIndex((l) => /^G0 Z7\.000 ; Retract to R plane$/.test(l));
    expect(plunge).toBeGreaterThan(-1);
    expect(dwell).toBeGreaterThan(plunge);
    expect(retract).toBeGreaterThan(dwell);
    expect(lines.filter((l) => /^G1 Z/.test(l))).toHaveLength(1);
    expect(g).toContain('; Drill + dwell (10.000, 4.000) depth 5.000');
  });

  it("GRBL 'peck': identical to the legacy default output, byte for byte", () => {
    const legacy = makeToolpath({
      operation: 'drill',
      tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
      params: { ...PARAMS, peckDepth: 2 },
      points: drillCycleTp().points,
    });
    for (const profile of ['grbl', 'linuxcnc'] as const) {
      expect(generateGCode(drillCycleTp({ drillCycle: 'peck' }), profile))
        .toBe(generateGCode(legacy, profile));
    }
  });

  it('dwell seconds clamp into [0.01, 5] on both profiles', () => {
    for (const profile of ['grbl', 'linuxcnc'] as const) {
      const lo = generateGCode(drillCycleTp({ drillCycle: 'dwell', dwellSeconds: 0 }), profile);
      const hi = generateGCode(drillCycleTp({ drillCycle: 'dwell', dwellSeconds: 10 }), profile);
      expect(lo).toMatch(/P0\.01(?!\d)/);
      expect(hi).toMatch(/P5(?![\d.])/);
    }
  });

  it('modal F still applies across variants: two dwell holes, F once but G4 twice', () => {
    const tp = makeToolpath({
      operation: 'drill',
      tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
      params: { ...PARAMS, peckDepth: 2, ...({ drillCycle: 'dwell', dwellSeconds: 0.25 } as DrillCycleFields) },
      points: [
        { x: 10, y: 10, z: 4, rapid: true },
        { x: 10, y: 7, z: 4, rapid: true },
        { x: 10, y: 0, z: 4, rapid: false, feedRate: 500 },
        { x: 10, y: 10, z: 4, rapid: true },
        { x: 30, y: 7, z: 4, rapid: true },
        { x: 30, y: 0, z: 4, rapid: false, feedRate: 500 },
        { x: 30, y: 10, z: 4, rapid: true },
      ],
    });
    const g = generateGCode(tp, 'grbl');
    expect(g.match(/ F500/g)).toHaveLength(1); // modal: second hole reuses F
    expect(g.match(/^G4 P0\.25 /gm)).toHaveLength(2); // dwell per hole
    expect(g.split('\n').filter((l) => /^G1 Z0\.000/.test(l))).toHaveLength(2);
  });
});

describe('wcs option — optional G54 in the program header', () => {
  it('wcs on: G54 lands after G94 and before the first Z rapid (both profiles)', () => {
    for (const profile of ['grbl', 'linuxcnc'] as const) {
      const lines = generateGCode(makeToolpath(), profile, { wcs: true }).split('\n');
      const codes = lines.filter((l) => /^[GM]\d/.test(l)).map((l) => l.split(/[ ;]/)[0]);
      expect(codes.slice(0, 5)).toEqual(['G90', 'G21', 'G17', 'G94', 'G54']);
      const g54 = lines.findIndex((l) => l.startsWith('G54 '));
      const firstZ = lines.findIndex((l) => /^G0 Z/.test(l));
      expect(g54).toBeGreaterThan(-1);
      expect(firstZ).toBeGreaterThan(g54);
      expect(lines[g54]).toContain('Work coordinate system 1');
    }
  });

  it('wcs off (default): no G54 and the header ends right after G94', () => {
    const g = generateGCode(makeToolpath());
    expect(g).not.toContain('G54');
    const lines = g.split('\n');
    const g94 = lines.findIndex((l) => l.startsWith('G94'));
    expect(lines[g94 + 1]).toMatch(/^G0 Z/);
    // Passing an empty options object changes nothing either. The Generated
    // timestamp line is stripped first — two separate calls can straddle a
    // millisecond boundary and the raw toBe would flake (observed pass #35).
    const stripStamp = (s: string): string => s.split('\n').filter((l) => !l.startsWith('; Generated:')).join('\n');
    expect(stripStamp(generateGCode(makeToolpath(), 'grbl', {}))).toBe(stripStamp(generateGCode(makeToolpath())));
  });
});

describe('arc fitting and drill cycles coexist in one program', () => {
  it('cylinder contour + dwell drill post without interfering', () => {
    const contour = generateContourToolpath(createCylinder(15, 20, 128), em6, {
      ...PARAMS,
      depthOfCut: 20,
      stockTop: 20,
      stockBottom: 0,
    });
    const drill = drillCycleTp({ drillCycle: 'dwell' }); // different tool → tool change
    const g = generateMultiToolGCode([contour, drill], 'grbl');

    // Arc section intact: same arc count as the contour-only program.
    const arcCount = (s: string) => s.split('\n').filter((l) => /^G[23] /.test(l)).length;
    expect(arcCount(g)).toBe(arcCount(generateGCode(contour, 'grbl')));
    expect(arcCount(g)).toBeGreaterThanOrEqual(3);

    // Drill section intact after the tool change: plunge → G4 dwell → retract.
    const drillSection = g.split('\n').slice(g.split('\n').findIndex((l) => /=== Toolpath 2/.test(l)));
    expect(drillSection.some((l) => l.startsWith('G1 Z0.000 F500'))).toBe(true);
    const plunge = drillSection.findIndex((l) => l.startsWith('G1 Z0.000'));
    const dwell = drillSection.findIndex((l) => /^G4 P0\.5 /.test(l));
    const retract = drillSection.findIndex((l) => /^G0 Z7\.000 ; Retract to R plane$/.test(l));
    expect(dwell).toBeGreaterThan(plunge);
    expect(retract).toBeGreaterThan(dwell);
    // No arcs leaked into the drill section, no drill expansion into the arcs.
    expect(drillSection.filter((l) => /^G[23] /.test(l))).toHaveLength(0);
    expect(g).toContain('; M6 T2');
  });
});

describe('estimateMachiningTime', () => {
  it('returns positive time for a toolpath', () => {
    expect(estimateMachiningTime(makeToolpath())).toBeGreaterThan(0);
  });

  it('counts plunges at the plunge rate, not the cut rate', () => {
    // 10 mm vertical plunge at 500 mm/min, then 10 mm cut at 1000 mm/min.
    const tp = makeToolpath({
      points: [
        { x: 0, y: 10, z: 0, rapid: false },
        { x: 0, y: 0, z: 0, rapid: false, feedRate: 500 },
        { x: 10, y: 0, z: 0, rapid: false },
      ],
    });
    expect(estimateMachiningTime(tp)).toBeCloseTo(10 / 500 + 10 / 1000, 6);
  });

  it('rapids are faster than cuts', () => {
    const rapidOnly = makeToolpath({
      points: [
        { x: 0, y: 0, z: 0, rapid: true },
        { x: 100, y: 0, z: 0, rapid: true },
      ],
    });
    const cutOnly = makeToolpath({
      points: [
        { x: 0, y: 0, z: 0, rapid: false },
        { x: 100, y: 0, z: 0, rapid: false },
      ],
    });
    expect(estimateMachiningTime(rapidOnly)).toBeLessThan(estimateMachiningTime(cutOnly));
  });

  it('returns 0 for a single-point toolpath and stays finite at feed 0', () => {
    expect(estimateMachiningTime(makeToolpath({ points: [{ x: 0, y: 0, z: 0, rapid: false }] }))).toBe(0);
    const zeroFeed = makeToolpath({ params: { ...PARAMS, feedRate: 0, plungeRate: 0 } });
    expect(estimateMachiningTime(zeroFeed)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(estimateMachiningTime(zeroFeed))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G2/G3 arc output (Mastercam-style arc filter)
// ---------------------------------------------------------------------------

interface ParsedMove {
  code: string;
  /** Machine coordinates (X = scene x, Y = scene z, Z = scene y). */
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  /** Arc center in machine XY, reconstructed from I/J (arcs only). */
  center?: { x: number; y: number };
}

/** Parse G0–G3 motion lines in execution order, tracking the absolute (G90)
 * position so each move's start is known and arc centers can be rebuilt. */
function parseMoves(g: string): ParsedMove[] {
  const moves: ParsedMove[] = [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const line of g.split('\n')) {
    if (!/^G[0-3](?:\.\d+)? /.test(line)) continue;
    const words: Record<string, number> = {};
    for (const w of line.match(/[A-Z]-?\d+(?:\.\d+)?/g) ?? []) {
      const letter = w[0]!;
      if (words[letter] === undefined) words[letter] = Number(w.slice(1));
    }
    const end = { x: words.X ?? cx, y: words.Y ?? cy, z: words.Z ?? cz };
    const move: ParsedMove = { code: `G${words.G}`, start: { x: cx, y: cy, z: cz }, end };
    if (words.G === 2 || words.G === 3) {
      move.center = { x: cx + (words.I ?? 0), y: cy + (words.J ?? 0) };
    }
    moves.push(move);
    cx = end.x;
    cy = end.y;
    cz = end.z;
  }
  return moves;
}

/** Find the toolpath point matching a machine position (from index `from`). */
function findPointIdx(
  tp: Toolpath,
  m: { x: number; y: number; z: number },
  from: number,
): number {
  const idx = tp.points.findIndex(
    (p, k) =>
      k >= from && Math.abs(p.x - m.x) < 1e-3 && Math.abs(p.z - m.y) < 1e-3 && Math.abs(p.y - m.z) < 1e-3,
  );
  expect(idx, `no toolpath point matches machine (${m.x}, ${m.y}, ${m.z})`).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('G2/G3 arc fitting — round parts', () => {
  // 128-gon cylinder: the offset path's sagitta R·(1 − cos(π/128)) ≈ 5.4 µm
  // sits inside the default 0.01 mm tolerance, so the loop collapses to arcs.
  const cylinderTp = (): Toolpath =>
    generateContourToolpath(createCylinder(15, 20, 128), em6, {
      ...PARAMS,
      depthOfCut: 20,
      stockTop: 20,
      stockBottom: 0,
    });

  it('collapses the polyline: G1 count drops ~100×, arcs appear', () => {
    const tp = cylinderTp();
    const fitted = generateGCode(tp);
    const plain = generateGCode(tp, 'grbl', { arcTolerance: 0 });
    const count = (g: string, re: RegExp) => g.split('\n').filter((l) => re.test(l)).length;
    const plainG1 = count(plain, /^G1 /);
    const fittedG1 = count(fitted, /^G1 /);
    const fittedArcs = count(fitted, /^G[23] /);
    expect(plainG1).toBeGreaterThanOrEqual(120); // plunge + 128-gon loop
    expect(count(plain, /^G[23] /)).toBe(0); // arcTolerance 0 disables fitting
    expect(fittedArcs).toBeGreaterThanOrEqual(3);
    expect(fittedG1).toBeLessThan(plainG1 / 10); // only the plunge remains
  });

  it('arc lines carry 4-decimal X/Y/Z/I/J and modal F', () => {
    const g = generateGCode(cylinderTp());
    const arcLines = g.split('\n').filter((l) => /^G[23] /.test(l));
    expect(arcLines.length).toBeGreaterThanOrEqual(3);
    for (const line of arcLines) {
      expect(line).toMatch(/^G[23] X-?\d+\.\d{4} Y-?\d+\.\d{4} Z-?\d+\.\d{4} I-?\d+\.\d{4} J-?\d+\.\d{4}( F\d+)?$/);
    }
    // F500 on the plunge, F1000 on the first arc, modal afterwards.
    expect(g.match(/ F\d+/g)).toHaveLength(2);
    expect(arcLines[0]).toMatch(/ F1000$/);
    expect(arcLines[1]).not.toMatch(/ F\d+$/);
  });

  it('reverse-solving X/Y/I/J reproduces the offset circle within tolerance', () => {
    const tp = cylinderTp();
    const arcs = parseMoves(generateGCode(tp)).filter((m) => m.code === 'G2' || m.code === 'G3');
    expect(arcs.length).toBeGreaterThanOrEqual(3);
    const trueRadius = 15 + 3 / Math.cos(Math.PI / 128); // miter offset vertex radius
    let cursor = 0;
    for (const a of arcs) {
      const s = findPointIdx(tp, a.start, cursor);
      const e = findPointIdx(tp, a.end, s);
      cursor = e;
      expect(a.center).toBeDefined();
      const c = a.center!;
      const rStart = Math.hypot(a.start.x - c.x, a.start.y - c.y);
      const rEnd = Math.hypot(a.end.x - c.x, a.end.y - c.y);
      // I/J + start must give the same radius as X/Y (the GRBL error-33 check).
      expect(Math.abs(rStart - rEnd)).toBeLessThan(1e-3);
      expect(Math.abs(rStart - trueRadius)).toBeLessThan(5e-3);
      // Every original polyline point of the span stays within tolerance.
      for (let k = s; k <= e; k++) {
        const p = tp.points[k]!;
        expect(Math.abs(Math.hypot(p.x - c.x, p.z - c.y) - rStart)).toBeLessThanOrEqual(0.0101);
      }
      // G2/G3 word matches the polyline's actual turn direction.
      const ps = tp.points[s]!;
      const pm = tp.points[(s + e) >> 1]!;
      const pe = tp.points[e]!;
      const cross = (pm.x - ps.x) * (pe.z - ps.z) - (pm.z - ps.z) * (pe.x - ps.x);
      expect(a.code).toBe(cross > 0 ? 'G3' : 'G2');
    }
  });

  it('both profiles post arcs (grbl and linuxcnc)', () => {
    for (const profile of ['grbl', 'linuxcnc'] as const) {
      const g = generateGCode(cylinderTp(), profile);
      expect(g.split('\n').filter((l) => /^G[23] /.test(l)).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('the toolpath itself is untouched — fitting only affects the post', () => {
    const tp = cylinderTp();
    const before = tp.points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`).join(';');
    generateGCode(tp);
    expect(tp.points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`).join(';')).toBe(before);
  });
});

describe('G2/G3 arc fitting — straight parts and breaks', () => {
  it('box contour stays pure G1 — straight walls never become arcs', () => {
    const tp = generateContourToolpath(createBox(50, 10, 30), em6, {
      ...PARAMS,
      depthOfCut: 10,
      stockTop: 10,
      stockBottom: 0,
    });
    const g = generateGCode(tp);
    expect(g.match(/^G[23] /gm)).toBeNull();
    expect(g.match(/^G1 /gm)).not.toBeNull();
    expect(g.match(/^G1 /gm)!.length).toBeGreaterThan(0);
  });

  it('arcs never span a rapid or a depth change', () => {
    const quarter = (startDeg: number): ToolpathPoint[] =>
      Array.from({ length: 25 }, (_, k) => {
        const a = ((startDeg + (90 * k) / 24) * Math.PI) / 180;
        return { x: 10 * Math.cos(a), y: 5, z: 10 * Math.sin(a), rapid: false };
      });
    // Helix: same circle in xz but y drops every step (a tab climb).
    const helix: ToolpathPoint[] = Array.from({ length: 20 }, (_, k) => {
      const a = ((90 + (90 * k) / 19) * Math.PI) / 180;
      return { x: 10 * Math.cos(a), y: 5 - k * 0.05, z: 10 * Math.sin(a), rapid: false };
    });
    const points: ToolpathPoint[] = [
      { x: 10, y: 15, z: 0, rapid: true },
      ...quarter(0), // indices 1..25 — flat, arc-able
      { x: 0, y: 15, z: 10, rapid: true }, // index 26 — rapid break
      ...helix, // indices 27..46 — y changes every step
      ...quarter(180), // indices 47..71 — flat, arc-able
    ];
    const tp = makeToolpath({ operation: 'contour', points });
    const arcs = parseMoves(generateGCode(tp)).filter((m) => m.code === 'G2' || m.code === 'G3');
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    let cursor = 0;
    for (const a of arcs) {
      const s = findPointIdx(tp, a.start, cursor);
      const e = findPointIdx(tp, a.end, s);
      cursor = e;
      const insideFlat = (i: number) => (i >= 1 && i <= 25) || (i >= 47 && i <= 71);
      expect(insideFlat(s), `arc start ${s} must lie in a flat run`).toBe(true);
      expect(insideFlat(e), `arc end ${e} must lie in the same flat run`).toBe(true);
    }
    // The helical climb stays linear: every one of its points is a G1 target.
    const g1Ends = parseMoves(generateGCode(tp)).filter((m) => m.code === 'G1');
    for (let k = 27; k <= 46; k++) {
      const p = tp.points[k]!;
      expect(
        g1Ends.some((m) => Math.abs(m.end.x - p.x) < 1e-3 && Math.abs(m.end.y - p.z) < 1e-3 && Math.abs(m.end.z - p.y) < 1e-3),
        `helix point ${k} must be posted as G1`,
      ).toBe(true);
    }
  });

  it('drill programs never contain arcs', () => {
    const drillTp = makeToolpath({
      operation: 'drill',
      tool: { ...em6, id: 'drill-6mm', name: '6mm Drill', type: 'drill' as const },
      params: { ...PARAMS, peckDepth: 2 },
      points: [
        { x: 10, y: 10, z: 4, rapid: true },
        { x: 10, y: 7, z: 4, rapid: true },
        { x: 10, y: 0, z: 4, rapid: false, feedRate: 500 },
        { x: 10, y: 10, z: 4, rapid: true },
      ],
    });
    for (const profile of ['grbl', 'linuxcnc'] as const) {
      const g = generateGCode(drillTp, profile);
      expect(g.match(/^G[23] /gm)).toBeNull();
    }
    // The GRBL peck expansion is untouched by the arc filter.
    expect(generateGCode(drillTp, 'grbl')).toContain('G1 Z3.000 F500');
  });
});
