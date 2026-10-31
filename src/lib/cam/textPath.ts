/**
 * Text → single-line-font (Hershey) cutting polylines for the engrave op.
 *
 * Pure geometry in the CAM planning plane: millimetres, x to the right,
 * z up (top view), baseline at z = 0 — structurally compatible with the
 * EngravePoint `{ x, z }` contract. No DOM, no React, fully deterministic.
 *
 * Glyph data originates from the hersheytext npm package (MIT; the Hershey
 * font data itself is public domain). The package's JS entry pulls in
 * cheerio + node:fs, so this module ships only the curated 4-font subset
 * (`hersheyFonts.json`, generated from the package's font JSON) and imports
 * it as raw text. Measured coordinate conventions of that data:
 *   - Only `M`/`L` path commands; vertices are integers.
 *   - Raw y points DOWN (cap top at y = 1, baseline at y = 22, descenders
 *     reach y = 29), hence z = (baseline − y) · scale.
 *   - Cap height is 21 units in every bundled font.
 *   - The nominal `o` field UNDER-reports some glyphs' ink (futural 'L'
 *     inks to x = 16 against 2o = 14), so the advance is ink-aware:
 *     max(2o, ink maxX + 1 unit) — the same rule the stock hersheytext SVG
 *     faces use (review pass #35 P1: with plain 2o, "ONLY"/"SCENELAB"/"off"
 *     collide at default spacing).
 */

// Curated subset (4 fonts, ~51 KB raw vs 334 KB full table): keeps the io
// chunk lean and avoids a 327 KB JSON.parse on the startup path. Regenerate
// with `npm i -D hersheytext@2 && node` from node_modules/hersheytext/
// hersheytext.min.json (the package itself is no longer a dependency — its
// JS entry pulls in cheerio + node:fs, only the font data is needed).
import hersheyFontJson from './hersheyFonts.json?raw';

/** One point on the planning plane (millimetres), matching EngravePoint. */
export interface EngraveTextPoint {
  x: number;
  z: number;
}

/** Options for {@link textToPolylines}. */
export interface TextToPolylinesOptions {
  /** Font id from {@link ENGRAVE_FONTS}; anything else falls back to the first. */
  font?: string;
  /** Cap height in millimetres (default 10). */
  size?: number;
  /** Extra letter spacing in millimetres (default 0). */
  spacing?: number;
}

/** Available single-line font ids (subset of hersheytext fonts, explicitly curated). */
export const ENGRAVE_FONTS: readonly string[] = ['futural', 'futuram', 'gothicita', 'timesr'];

/** A glyph stroke in raw font units (y still pointing down). */
type Stroke = Array<{ x: number; y: number }>;

interface HersheyJsonGlyph {
  d: string | null;
  o: number | string;
}

interface HersheyJsonFont {
  name: string;
  chars: Array<HersheyJsonGlyph | null | undefined>;
}

/** Per-font unit metrics derived from the rendered data itself. */
interface FontMetrics {
  /** Raw y of the writing line (22 in every bundled font). */
  baseline: number;
  /** baseline y − cap-top y (21 in every bundled font). */
  capHeight: number;
}

const FONT_DATA: Record<string, HersheyJsonFont | undefined> = JSON.parse(
  hersheyFontJson,
) as Record<string, HersheyJsonFont | undefined>;
const DEFAULT_FONT: string = ENGRAVE_FONTS[0] ?? 'futural';
const DEFAULT_SIZE = 10;
/** Line height for '\n' as a multiple of size. */
const LINE_HEIGHT = 1.4;
/** The hershey char tables cover printable ASCII 33..126. */
const FIRST_CHAR = 33;
const LAST_CHAR = 126;
/** Space advance in font units (hersheytext hardcodes horiz-adv-x = 10). */
const SPACE_UNITS = 10;
/** Fallback metrics when a font has no measurable A–Z glyphs. */
const FALLBACK_BASELINE = 22;
const FALLBACK_CAP_HEIGHT = 21;

const metricsCache = new Map<string, FontMetrics>();
const strokeCache = new Map<string, Stroke[]>();

/** Only whitelisted ids are "available"; anything else falls back. */
function resolveFont(font: string | undefined): string {
  return font !== undefined && ENGRAVE_FONTS.includes(font) ? font : DEFAULT_FONT;
}

/** Inter-glyph leading in font units past the ink edge (the bundled SVG
 * faces advance ≈ +1 unit beyond the widest ink — review pass #35 P1). */
const LEADING_UNITS = 1;

/**
 * Horizontal advance of a glyph in font units: max(nominal box 2o, real ink
 * maxX + leading). Plain 2o collides wide-ink glyphs with their successors
 * at zero spacing ("LY"/"ff" overlap by 1–2 units); the parsed strokes' true
 * right edge is already cached, so this costs nothing extra.
 */
function advanceUnits(
  fontId: string,
  code: number,
  glyph: HersheyJsonGlyph | null | undefined,
): number {
  const raw = glyph?.o;
  const o = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  const nominal = Number.isFinite(o) && o > 0 ? o * 2 : SPACE_UNITS;
  if (typeof glyph?.d === 'string' && glyph.d.length > 0) {
    let inkMax = -Infinity;
    for (const stroke of cachedStrokes(fontId, code, glyph.d)) {
      for (const p of stroke) if (p.x > inkMax) inkMax = p.x;
    }
    if (inkMax !== -Infinity) return Math.max(nominal, inkMax + LEADING_UNITS);
  }
  return nominal;
}

/** Parse an SVG `d` string of Hershey `M`/`L` commands into strokes. */
function parseStrokes(d: string): Stroke[] {
  const strokes: Stroke[] = [];
  let current: Stroke | undefined;
  for (const match of d.matchAll(/([ML])([^ML]*)/g)) {
    const nums = (match[2] ?? '').match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const point = { x: Number(nums[i]), y: Number(nums[i + 1]) };
      if (match[1] === 'M') {
        current = [point];
        strokes.push(current);
      } else {
        current?.push(point);
      }
    }
  }
  return strokes.filter((stroke) => stroke.length >= 2);
}

function cachedStrokes(fontId: string, code: number, d: string): Stroke[] {
  const key = `${fontId}:${code}`;
  const cached = strokeCache.get(key);
  if (cached !== undefined) return cached;
  const strokes = parseStrokes(d);
  strokeCache.set(key, strokes);
  return strokes;
}

function majority(counts: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Derive baseline + cap height from the font's own A–Z glyphs (majority vote
 * over each glyph's top/bottom y), so the mapping self-corrects if the font
 * data ever changes. Falls back to the measured constants otherwise.
 */
function fontMetrics(fontId: string, font: HersheyJsonFont): FontMetrics {
  const cached = metricsCache.get(fontId);
  if (cached !== undefined) return cached;
  const bottoms = new Map<number, number>();
  const tops = new Map<number, number>();
  for (let code = 65; code <= 90; code++) {
    const d = font.chars[code - FIRST_CHAR]?.d;
    if (typeof d !== 'string') continue;
    const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 1; i < nums.length; i += 2) {
      const y = Number(nums[i]);
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    if (top === Infinity) continue;
    bottoms.set(bottom, (bottoms.get(bottom) ?? 0) + 1);
    tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const baseline = majority(bottoms) ?? FALLBACK_BASELINE;
  const capTop = majority(tops) ?? baseline - FALLBACK_CAP_HEIGHT;
  const capHeight = baseline - capTop > 0 ? baseline - capTop : FALLBACK_CAP_HEIGHT;
  const metrics: FontMetrics = { baseline, capHeight };
  metricsCache.set(fontId, metrics);
  return metrics;
}

/**
 * Render text to cutting polylines in millimetres (planning plane, +z up,
 * baseline at z = 0). size = cap height in mm; spacing = extra letter
 * spacing in mm (default 0); newline starts a new line 1.4 × size lower.
 * Each glyph stroke becomes one polyline (≥ 2 points); spaces advance the
 * pen without emitting geometry; empty or blank text yields [].
 */
export function textToPolylines(
  text: string,
  options?: TextToPolylinesOptions,
): Array<Array<EngraveTextPoint>> {
  const fontId = resolveFont(options?.font);
  const font = FONT_DATA[fontId];
  if (font === undefined) return [];
  const size =
    options?.size !== undefined && Number.isFinite(options.size) && options.size > 0
      ? options.size
      : DEFAULT_SIZE;
  const spacing =
    options?.spacing !== undefined && Number.isFinite(options.spacing) ? options.spacing : 0;
  const { baseline, capHeight } = fontMetrics(fontId, font);
  const scale = size / capHeight;

  const polylines: Array<Array<EngraveTextPoint>> = [];
  let penX = 0;
  let penZ = 0;
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      penX = 0;
      penZ -= LINE_HEIGHT * size;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    const glyph =
      code >= FIRST_CHAR && code <= LAST_CHAR ? font.chars[code - FIRST_CHAR] : undefined;
    if (typeof glyph?.d === 'string' && glyph.d.length > 0) {
      for (const stroke of cachedStrokes(fontId, code, glyph.d)) {
        polylines.push(
          stroke.map((p) => ({ x: penX + p.x * scale, z: penZ + (baseline - p.y) * scale })),
        );
      }
    }
    penX += advanceUnits(fontId, code, glyph) * scale + spacing;
  }
  return polylines;
}
