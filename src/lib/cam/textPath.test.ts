import { describe, expect, it } from 'vitest';
import { ENGRAVE_FONTS, textToPolylines } from './textPath';
import type { EngraveTextPoint } from './textPath';

/**
 * Expected values below are PARSED TRUTH measured from
 * node_modules/hersheytext/hersheytext.min.json (futural), not magic numbers:
 *   - cap height = 21 units, baseline at raw y = 22, raw y points DOWN;
 *   - 'A' = 'M9,1 L1,22 M9,1 L17,22 M4,15 L14,15' with advance o = 9
 *     (ink x ∈ [1, 17], nominal advance box [0, 2o]);
 *   - 'I' = 'M4,1 L4,22' (o = 4), 'g' ink bottom at y = 29 (7 below baseline);
 *   - the same metrics (H: y ∈ [1, 22]) hold for all four ENGRAVE_FONTS.
 */
const CAP_UNITS = 21;
const SCALE_10 = 10 / CAP_UNITS;

const xs = (lines: EngraveTextPoint[][]): number[] => lines.flat().map((p) => p.x);
const zs = (lines: EngraveTextPoint[][]): number[] => lines.flat().map((p) => p.z);

describe('textToPolylines', () => {
  it('renders "A" (futural, size 10) as its 3 measured strokes inside the advance box', () => {
    const lines = textToPolylines('A', { font: 'futural', size: 10 });
    expect(lines.length).toBe(3); // M…/M…/M… — one polyline per glyph stroke
    expect(lines.map((l) => l.length)).toEqual([2, 2, 2]);

    const advance = 2 * 9 * SCALE_10; // o = 9 → box width 18 units
    for (const x of xs(lines)) expect(x).toBeGreaterThanOrEqual(-0.1);
    for (const x of xs(lines)) expect(x).toBeLessThanOrEqual(advance + 0.1);
    for (const z of zs(lines)) expect(z).toBeGreaterThanOrEqual(0 - 0.1);
    for (const z of zs(lines)) expect(z).toBeLessThanOrEqual(10 + 0.1);

    // Exact parsed truth: ink x ∈ [1, 17] units, apex y = 1, feet y = 22.
    expect(Math.min(...xs(lines))).toBeCloseTo(1 * SCALE_10, 6);
    expect(Math.max(...xs(lines))).toBeCloseTo(17 * SCALE_10, 6);
    expect(Math.max(...zs(lines))).toBeCloseTo(10, 6);
    expect(Math.min(...zs(lines))).toBeCloseTo(0, 6);
  });

  it('places descenders below the baseline ("g" bottom = y 29 → z = −7·scale)', () => {
    const minZ = Math.min(...zs(textToPolylines('g', { font: 'futural', size: 10 })));
    expect(minZ).toBeLessThan(0);
    expect(minZ).toBeCloseTo(-7 * SCALE_10, 6);
  });

  it('scales linearly with size ("I" height ratio 0.5, absolute heights 5 and 10)', () => {
    const height = (lines: EngraveTextPoint[][]): number =>
      Math.max(...zs(lines)) - Math.min(...zs(lines));
    const h10 = height(textToPolylines('I', { font: 'futural', size: 10 }));
    const h5 = height(textToPolylines('I', { font: 'futural', size: 5 }));
    expect(h10).toBeCloseTo(10, 6); // I spans y 1..22 = full cap height
    expect(h5).toBeCloseTo(0.5 * h10, 6);
  });

  it('widens total advance linearly with spacing (interior gap grows 1·spacing per char)', () => {
    const width = (spacing: number): number => {
      const x = xs(textToPolylines('AB', { font: 'futural', size: 10, spacing }));
      return Math.max(...x) - Math.min(...x);
    };
    const base = width(0);
    // 'AB' has one interior advance, so the ink width grows by exactly spacing.
    expect(width(1)).toBeCloseTo(base + 1, 6);
    expect(width(2.5)).toBeCloseTo(base + 2.5, 6);
    // The second glyph's pen shifts by exactly box advance + spacing: 'A's
    // first stroke M9,1 lands at x = (18 units + spacing) + 9 units.
    const first = textToPolylines('AA', { font: 'futural', size: 10, spacing: 1 });
    expect(first.length).toBe(6); // 3 + 3 strokes
    expect(first[3]?.[0]?.x).toBeCloseTo(18 * SCALE_10 + 1 + 9 * SCALE_10, 6);
  });

  it('breaks lines on \\n (and CRLF): z centres 1.4 × size apart, pen x resets', () => {
    for (const text of ['A\nA', 'A\r\nA']) {
      const lines = textToPolylines(text, { font: 'futural', size: 10 });
      expect(lines.length).toBe(6); // 3 strokes per 'A'
      const line = (stroke: number): number[] => zs(lines.slice(stroke * 3, stroke * 3 + 3));
      const centre = (v: number[]): number => (Math.max(...v) + Math.min(...v)) / 2;
      expect(centre(line(0))).toBeCloseTo(5, 6); // z ∈ [0, 10]
      expect(centre(line(0)) - centre(line(1))).toBeCloseTo(1.4 * 10, 6);
      // Pen reset: both lines start at the same left bearing (x = 1·scale).
      expect(Math.min(...line(1))).toBeCloseTo(-14, 6); // baseline of line 2
      expect(
        lines.slice(0, 3).flat().every((p, i) => {
          const q = lines.slice(3).flat()[i];
          return q !== undefined && Math.abs(q.x - p.x) < 1e-9;
        }),
      ).toBe(true);
    }
  });

  it('returns [] for empty and blank-only text (spaces still advance, emit nothing)', () => {
    expect(textToPolylines('', { size: 10 })).toEqual([]);
    expect(textToPolylines('   \t\n', { size: 10 })).toEqual([]);
    // A space advances the pen by exactly 10 units: the same 'B' ink shifts
    // by the space advance (B ink starts at 4 units, so this is NOT > B width).
    const [plain, spaced] = [textToPolylines('B', { size: 10 }), textToPolylines(' B', { size: 10 })];
    expect(Math.min(...xs(spaced)) - Math.min(...xs(plain))).toBeCloseTo(10 * SCALE_10, 6);
  });

  it('falls back to ENGRAVE_FONTS[0] for unknown font ids without throwing', () => {
    const fallback = textToPolylines('Abc', { font: 'not-a-font', size: 10 });
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toEqual(textToPolylines('Abc', { font: 'futural', size: 10 }));
  });

  it('emits ≥ 2 points per polyline for mixed ASCII and non-ASCII input', () => {
    for (const text of ['Hello, World!', 'Åü中∮\nOK 42']) {
      for (const line of textToPolylines(text, { size: 8 })) {
        expect(line.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('is deterministic: identical calls deep-equal', () => {
    const a = textToPolylines('Scene\nLab 42', { font: 'timesr', size: 6, spacing: 0.4 });
    const b = textToPolylines('Scene\nLab 42', { font: 'timesr', size: 6, spacing: 0.4 });
    expect(a).toEqual(b);
  });

  it('defaults to futural at size 10 when options are omitted', () => {
    expect(textToPolylines('A')).toEqual(textToPolylines('A', { font: 'futural', size: 10 }));
  });

  it('exposes working fonts: every ENGRAVE_FONTS id caps exactly at size', () => {
    expect(ENGRAVE_FONTS.length).toBeGreaterThanOrEqual(3);
    for (const font of ENGRAVE_FONTS) {
      const cap = textToPolylines('H', { font, size: 10 });
      expect(cap.length).toBeGreaterThan(0);
      expect(Math.max(...zs(cap))).toBeCloseTo(10, 6); // H: y ∈ [1, 22] in all four
      expect(Math.min(...zs(cap))).toBeCloseTo(0, 6);
      const descender = Math.min(...zs(textToPolylines('g', { font, size: 10 })));
      expect(descender).toBeLessThan(0);
    }
  });
});

describe('textToPolylines — ink-aware advance (review pass #35 P1)', () => {
  // Polylines are appended in glyph order, so per-glyph attribution comes
  // from the stroke counts of each character rendered standalone.
  const strokeCount = (ch: string, font: string): number =>
    textToPolylines(ch, { font, size: 10 }).length;
  const inkMaxX = (polys: Array<Array<EngraveTextPoint>>): number =>
    Math.max(...polys.flat().map((p) => p.x));

  /**
   * Horizontal gap between consecutive glyphs in a zero-spacing render:
   * polylines[first glyph] then polylines[second glyph]; gap > 0 means the
   * strokes cannot touch at all. With the old nominal-2o advance these
   * pairs collided by 1–2 font units (≈0.5–1 mm at size 10).
   */
  const pairGap = (first: string, second: string, font: string): number => {
    const n = strokeCount(first, font);
    const polys = textToPolylines(first + second, { font, size: 10, spacing: 0 });
    expect(polys.length).toBe(n + strokeCount(second, font));
    const firstInk = inkMaxX(polys.slice(0, n));
    const secondStart = Math.min(...polys.slice(n).flat().map((p) => p.x));
    return secondStart - firstInk;
  };

  it("futural: 'L' and 'F' no longer collide with wide successors", () => {
    // Reviewer's measured collisions: LA/LT/LV/LY (L inks to 16 vs 2o=14),
    // 'F' inks to 17 vs 16. Each gap must be ≥ ~1 font unit of leading.
    const scale = 10 / 21;
    for (const second of ['A', 'T', 'V', 'Y']) {
      expect(pairGap('L', second, 'futural')).toBeGreaterThanOrEqual(scale - 1e-6);
    }
    expect(pairGap('F', 'A', 'futural')).toBeGreaterThanOrEqual(scale - 1e-6);
  });

  it("gothicita: 'ff' no longer collides ('f' inks to 12 vs 2o=10)", () => {
    expect(pairGap('f', 'f', 'gothicita')).toBeGreaterThanOrEqual(10 / 21 - 1e-6);
  });

  it('the reviewer\'s failing words render with no cross-glyph stroke contact', () => {
    for (const [word, font] of [['ONLY', 'futural'], ['SCENELAB', 'futural'], ['off', 'gothicita']] as const) {
      const counts = Array.from(word).map((ch) => strokeCount(ch, font));
      const polys = textToPolylines(word, { font, size: 10, spacing: 0 });
      expect(polys.length).toBe(counts.reduce((a, b) => a + b, 0));
      let before = 0;
      for (let i = 0; i + 1 < counts.length; i++) {
        before += counts[i]!;
        const leftInk = inkMaxX(polys.slice(0, before));
        const rightStart = Math.min(...polys.slice(before, before + counts[i + 1]!).flat().map((p) => p.x));
        expect(rightStart - leftInk).toBeGreaterThan(0);
      }
    }
  });
});
