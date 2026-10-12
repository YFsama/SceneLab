/**
 * Setup sheet ("工艺卡") generator: turns the CAM setup summary into ONE
 * self-contained HTML document — inline styles, print-friendly
 * `@media print` rules, no external resources, no scripts — so it can be
 * previewed in a sandboxed-free iframe, saved as a .html hand-off and printed
 * straight from the browser. Pure string building throughout (lib/ has zero
 * DOM access; an HTML string is just a string).
 *
 * Document labels are deliberately locale-neutral English (the machining
 * hand-off convention): the owning PANEL localizes the UI chrome around the
 * document, while the document itself must read the same in every locale and
 * for every viewer that only receives the file.
 */

/** One row of the sheet: an operation with its resolved tool and estimates. */
export interface SetupSheetOp {
  name: string;
  /** Raw operation type ('pocket' | 'contour' | 'drill' | 'face'). */
  type: string;
  toolName: string;
  /** Post-processor tool number (first appearance over the posted order). */
  toolNumber: number;
  /** Tool diameter, mm. */
  diameter: number;
  /** Estimated machining time, minutes; 0 renders as "—" (no cache). */
  timeMin: number;
  feedRate: number;
  spindleSpeed: number;
  enabled: boolean;
}

export interface SetupSheetInput {
  projectName: string;
  profile: string;
  /** Human-readable stock description, e.g. "bbox +2 mm" / "20.0×15.0×10.0 mm". */
  stock: string;
  /** Program traverse height, mm (machine Z). */
  safeZ: number;
  /** Total estimated machining time, minutes. */
  totalTimeMin: number;
  ops: SetupSheetOp[];
  /** Stamp for the footer; defaults to now. Injectable for determinism. */
  generatedAt?: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape the five HTML-significant characters — every user-controlled string
 * (project/op/tool names) passes through here, so a body named `<script>`
 * prints as text instead of living in the document. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Compact numeric formatting: up to 2 decimals, trailing zeros stripped. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Time cell: 0 is the "no cached toolpath" sentinel — the sheet stays honest
 * with an em dash instead of promising a 0-minute cut. */
function timeCell(min: number): string {
  return min > 0 ? num(min) : '—';
}

const STYLE = `
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111827; margin: 24px; font-size: 12px; line-height: 1.45; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #6b7280; margin: 0 0 16px; }
  table { border-collapse: collapse; }
  .meta { margin-bottom: 16px; }
  .meta th, .meta td { text-align: left; padding: 3px 12px 3px 0; vertical-align: top; }
  .meta th { color: #6b7280; font-weight: 500; white-space: nowrap; }
  .ops { width: 100%; }
  .ops th, .ops td { border: 1px solid #d1d5db; padding: 5px 8px; text-align: left; }
  .ops th { background: #f3f4f6; }
  .ops td.num, .ops th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ops tr.off td { color: #9ca3af; text-decoration: line-through; }
  footer { margin-top: 16px; color: #9ca3af; font-size: 10px; }
  @media print {
    body { margin: 0; font-size: 11px; }
    .ops tr { break-inside: avoid; }
    h1 { break-after: avoid; }
  }
`;

/** Generate the complete setup sheet HTML document for the given input. */
export function generateSetupSheetHtml(input: SetupSheetInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const rows = input.ops
    .map(
      (op, i) => `        <tr class="${op.enabled ? '' : 'off'}" title="${esc(op.type)}">
          <td class="num">${i + 1}</td>
          <td>${esc(op.name)}</td>
          <td>T${op.toolNumber} ${esc(op.toolName)}</td>
          <td class="num">${op.diameter > 0 ? num(op.diameter) : '—'}</td>
          <td class="num">${num(op.feedRate)}</td>
          <td class="num">${num(op.spindleSpeed)}</td>
          <td class="num">${timeCell(op.timeMin)}</td>
        </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup Sheet — ${esc(input.projectName)}</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>Setup Sheet</h1>
  <p class="sub">${esc(input.projectName)}</p>
  <table class="meta">
    <tbody>
      <tr><th>Project</th><td>${esc(input.projectName)}</td></tr>
      <tr><th>Machine profile</th><td>${esc(input.profile)}</td></tr>
      <tr><th>Stock</th><td>${esc(input.stock)}</td></tr>
      <tr><th>Safe Z</th><td>${num(input.safeZ)} mm</td></tr>
      <tr><th>Total time</th><td>${timeCell(input.totalTimeMin)} min</td></tr>
    </tbody>
  </table>
  <table class="ops">
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Operation</th>
        <th>Tool</th>
        <th class="num">&Oslash; mm</th>
        <th class="num">F mm/min</th>
        <th class="num">S RPM</th>
        <th class="num">Time min</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <footer>Generated ${esc(generatedAt)} — SceneLab CAM</footer>
</body>
</html>
`;
}
