/**
 * Drawing-sheet annotations: Fusion-style detail views and SolidWorks-style
 * text notes. Pure data + layout math shared by the drawing canvas, the SVG
 * exporter and the store; serialized with the project (see studio3d.ts).
 */

/** Which world-axis mid-plane the section view cuts along ('off' = none). */
export type DrawingSectionAxis = 'off' | 'x' | 'y' | 'z';

/** A text note pinned to a sheet position (canvas/sheet px of the drawing). */
export interface DrawingNote {
  id: string;
  x: number;
  y: number;
  text: string;
}

/**
 * A detail-view definition (Fusion "Detail" view): the projection of
 * `viewIndex` cropped to a circle of `radius` model mm around `center`
 * (model coords of that view's 2D projection), redrawn at `scale`× the
 * source view's on-sheet scale.
 */
export interface DrawingDetail {
  id: string;
  /** Index into the drawing's view list (0 Front, 1 Top, 2 Right, 3 Iso). */
  viewIndex: number;
  /** Circle centre in model coords of that view's projection. */
  center: { x: number; y: number };
  /** Circle radius in model units (mm). */
  radius: number;
  /** Magnification vs the source view (Fusion default 2). */
  scale: number;
}

/** Default detail circle radius (mm) and magnification. */
export const DETAIL_RADIUS_MM = 25;
export const DETAIL_SCALE = 2;

let nextNoteId = 1;
let nextDetailId = 1;

/** Session-unique note id (dnote_1, dnote_2, …). */
export function makeNoteId(): string {
  return `dnote_${nextNoteId++}`;
}

/** Session-unique detail id (ddetail_1, ddetail_2, …). */
export function makeDetailId(): string {
  return `ddetail_${nextDetailId++}`;
}

/** Detail letters A, B, … Z, AA, AB … (spreadsheet columns). */
export function detailLabel(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The letter the next detail would get, given the existing ones (A, B, C …). */
export function nextDetailLetter(existing: DrawingDetail[]): string {
  return detailLabel(existing.length);
}

/** Format a magnification like 2 or 2.5 for a "DETAIL A (2:1)" title. */
function formatScale(scale: number): string {
  return Number.isInteger(scale) ? String(scale) : scale.toFixed(1);
}

/** Sheet title of a detail panel, e.g. "DETAIL A (2:1)". */
export function detailTitle(letter: string, scale: number): string {
  return `DETAIL ${letter} (${formatScale(scale)}:1)`;
}

/** Where a detail's panel sits on the sheet (all values in sheet px). */
export interface DetailPanel {
  /** Index of the detail this panel renders (into the details array). */
  detailIndex: number;
  /** Border-circle centre. */
  cx: number;
  cy: number;
  /** Border-circle radius (after the panel size cap). */
  rPx: number;
  /** px per model mm of the source view on the sheet (content transform). */
  sourceScale: number;
  /**
   * Magnification actually applied (<= detail.scale): panels are size-capped
   * so huge crop circles may magnify less than asked; the title reflects it.
   */
  effectiveScale: number;
  letter: string;
  title: string;
}

export interface DetailPanelInput {
  /** Magnification requested for this detail (usually DETAIL_SCALE). */
  scale: number;
  /** Circle radius in model mm. */
  radius: number;
  /** px per model mm of this detail's source view on the sheet. */
  sourceScale: number;
}

/**
 * Lay out detail panels in a strip below the base sheet: circles at their
 * natural size (radius × source scale × magnification), capped at ~90% of a
 * view cell's smaller dimension so panels never dwarf the sheet; the sheet
 * grows downward to fit the rows. Inputs without a source view (sourceScale
 * <= 0, e.g. stale viewIndex) are skipped, but surviving panels keep their
 * original `detailIndex` so callers can index their details array with it.
 * Returns the panels (in order) and the strip height consumed (0 for none).
 */
export function layoutDetailPanels(
  inputs: DetailPanelInput[],
  sheetWidth: number,
  stripTop: number,
  cellW: number,
  cellH: number,
): { panels: DetailPanel[]; stripHeight: number } {
  if (inputs.length === 0) return { panels: [], stripHeight: 0 };
  const maxR = Math.max(8, 0.45 * Math.min(cellW, cellH));
  const labelGap = 22;
  const rowH = maxR * 2 + labelGap;
  const perRow = Math.max(1, Math.floor(sheetWidth / (maxR * 2 + 24)));

  const valid = inputs
    .map((input, i) => ({ input, i }))
    .filter(({ input }) => input.sourceScale > 0 && input.radius > 0);

  const panels: DetailPanel[] = [];
  for (let k = 0; k < valid.length; k++) {
    const { input, i } = valid[k]!;
    const row = Math.floor(k / perRow);
    const inRow = Math.min(perRow, valid.length - row * perRow);
    const col = k % perRow;
    const rowW = inRow * (maxR * 2 + 24) - 24;
    const rowX = (sheetWidth - rowW) / 2;
    const cx = rowX + col * (maxR * 2 + 24) + maxR;
    const cy = stripTop + row * rowH + maxR;
    const wanted = input.radius * input.sourceScale * input.scale;
    const rPx = Math.min(wanted, maxR);
    const effectiveScale = rPx / (input.radius * input.sourceScale);
    panels.push({
      detailIndex: i,
      cx,
      cy,
      rPx,
      sourceScale: input.sourceScale,
      effectiveScale,
      letter: detailLabel(k),
      title: detailTitle(detailLabel(k), effectiveScale),
    });
  }
  if (panels.length === 0) return { panels: [], stripHeight: 0 };
  const rows = Math.ceil(panels.length / perRow);
  return { panels, stripHeight: rows * rowH + 8 };
}

/** Map a model-space point of a detail's source view into its panel (sheet px). */
export function detailPointToSheet(
  p: { x: number; y: number },
  center: { x: number; y: number },
  panel: DetailPanel,
): { x: number; y: number } {
  const s = panel.sourceScale * panel.effectiveScale;
  return { x: panel.cx + (p.x - center.x) * s, y: panel.cy - (p.y - center.y) * s };
}
