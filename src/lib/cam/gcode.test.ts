import { describe, it, expect } from 'vitest';
import { generateGCode, generateMultiToolGCode, estimateMachiningTime } from './gcode';
import type { Toolpath } from './types';

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
