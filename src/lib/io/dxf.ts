import type { SolidBody, Vec3 } from '../geometry/types';
import {
  CENTER_MARK_ARM_RATIO,
  calloutSheetGeometry,
  clipSegmentToCircle,
  clipViewToCircle,
  cutPlaneSheetTrace,
  defaultTitleBlock,
  dimensionSheetGeometry,
  formatDimValue,
  titleBlockLayout,
  viewTransform,
  type DrawingArc,
  type DrawingSheetExtras,
  type DrawingView,
} from './drawing';
import { detailPointToSheet, layoutDetailPanels } from './drawingNotes';

/** Export one or more bodies as DXF (AutoCAD Drawing Exchange Format) */
export function exportDXF(bodies: SolidBody | SolidBody[]): string {
  const list = Array.isArray(bodies) ? bodies : [bodies];
  const lines: string[] = [];

  // DXF Header
  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1009');
  lines.push('0', 'ENDSEC');

  // Tables section. The HIDDEN layer references DASHED, so DASHED needs an
  // LTYPE table entry — an undefined linetype name is exactly the class of
  // bug R12 importers reject the file over.
  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push(
    '0', 'TABLE', '2', 'LTYPE', '70', '1',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed __ __ __ __ __ __ __ __ __ __',
    '72', '65', '73', '2', '40', '1.5', '49', '1', '49', '-0.5',
    '0', 'ENDTAB',
  );
  lines.push('0', 'TABLE', '2', 'LAYER', '70', '3');
  lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'EDGES', '70', '0', '62', '1', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'HIDDEN', '70', '0', '62', '5', '6', 'DASHED');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  // Entities section
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  for (const body of list) {
    // Project edges to XY plane (top view) for 2D DXF
    for (const edge of body.edges) {
      addLine(lines, edge.start, edge.end, 'EDGES');
    }

    // Also add face outlines projected to XY
    for (const face of body.faces) {
      for (let i = 0; i < face.vertices.length; i++) {
        const next = (i + 1) % face.vertices.length;
        addLine(lines, face.vertices[i]!, face.vertices[next]!, '0');
      }
    }
  }

  lines.push('0', 'ENDSEC');

  // EOF
  lines.push('0', 'EOF');

  return lines.join('\r\n');
}

function addLine(lines: string[], start: Vec3, end: Vec3, layer: string): void {
  lines.push('0', 'LINE');
  lines.push('8', layer);
  lines.push('10', start.x.toFixed(6));
  lines.push('20', start.y.toFixed(6));
  lines.push('30', start.z.toFixed(6));
  lines.push('11', end.x.toFixed(6));
  lines.push('21', end.y.toFixed(6));
  lines.push('31', end.z.toFixed(6));
}

/** Emit one triangular 3DFACE entity (the 4th vertex repeats the 3rd). */
function add3DFace(lines: string[], v0: Vec3, v1: Vec3, v2: Vec3): void {
  lines.push('0', '3DFACE');
  lines.push('8', 'FACES');
  lines.push('10', v0.x.toFixed(6), '20', v0.y.toFixed(6), '30', v0.z.toFixed(6));
  lines.push('11', v1.x.toFixed(6), '21', v1.y.toFixed(6), '31', v1.z.toFixed(6));
  lines.push('12', v2.x.toFixed(6), '22', v2.y.toFixed(6), '32', v2.z.toFixed(6));
  lines.push('13', v2.x.toFixed(6), '23', v2.y.toFixed(6), '33', v2.z.toFixed(6));
}

/** Export body as 3D DXF with POLYLINE faces */
export function exportDXF3D(body: SolidBody): string {
  const lines: string[] = [];

  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$ACADVER', '1', 'AC1009');
  lines.push('0', 'ENDSEC');

  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER', '70', '2');
  lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  lines.push('0', 'LAYER', '2', 'FACES', '70', '0', '62', '3', '6', 'CONTINUOUS');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  lines.push('0', 'SECTION', '2', 'ENTITIES');

  // Write faces as 3DFACE entities. A 3DFACE holds at most 4 vertices, so
  // fan-triangulate any larger polygon (e.g. an n-gon cylinder/cone cap) —
  // writing only the first four would silently drop the rest of the face.
  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    for (let i = 1; i < verts.length - 1; i++) {
      add3DFace(lines, verts[0]!, verts[i]!, verts[i + 1]!);
    }
  }

  // Also write edges as LINE entities
  for (const edge of body.edges) {
    addLine(lines, edge.start, edge.end, '0');
  }

  lines.push('0', 'ENDSEC');
  lines.push('0', 'EOF');

  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Sheet DXF (R12): the drawing SHEET as true 2D CAD entities — a proper
// drawing for LibreCAD/AutoCAD users instead of exportDXF's raw 3D wireframe
// (kept untouched for the AI/io path). Sheet px are written as mm at 1:1 —
// the sheet is the source of truth, each view's auto-fit scale is baked into
// its viewTransform — and the y axis is flipped to CAD's +y-up convention
// (fy = totalHeight − y). The double flip (view y-up → sheet y-down → DXF
// y-up) preserves angles, so view arcs map 1:1 onto DXF CCW arcs.
// ---------------------------------------------------------------------------

/** Layers of the sheet DXF: geometry, annotation and hatching separated. */
const SHEET_LAYERS: { name: string; color: number; linetype: string }[] = [
  { name: 'OUTLINE', color: 7, linetype: 'CONTINUOUS' }, // view geometry
  { name: 'CENTER', color: 3, linetype: 'CENTER' }, // center-mark crosses
  { name: 'CALLOUT', color: 8, linetype: 'CONTINUOUS' }, // hole callouts
  { name: 'NOTES', color: 7, linetype: 'CONTINUOUS' }, // names, notes, letters
  { name: 'DIMENSIONS', color: 1, linetype: 'CONTINUOUS' }, // red, like the canvas
  { name: 'HATCH', color: 8, linetype: 'CONTINUOUS' }, // section hatch
];

/** Standard annotation text height (mm on the sheet). */
const SHEET_TEXT_HEIGHT = 2.5;
/** Dimension SOLID-arrowhead size (sheet mm). */
const DXF_ARROW_LEN = 3.5;
const DXF_ARROW_HALF_W = 1.2;
/** Section hatch spacing along the scanline normal (sheet mm). */
const HATCH_SPACING = 6;

const f = (n: number) => n.toFixed(6);

/** DXF TEXT payload: one line, ⌀ as AutoCAD's %%c diameter code. */
function dxfTextValue(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/⌀/g, '%%c');
}

function emitLine(
  out: string[],
  layer: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  linetype?: string,
): void {
  out.push(
    '0', 'LINE', '8', layer, ...(linetype ? ['6', linetype] : []),
    '10', f(x1), '20', f(y1), '30', '0',
    '11', f(x2), '21', f(y2), '31', '0',
  );
}

function emitCircle(out: string[], layer: string, cx: number, cy: number, r: number): void {
  if (r < 1e-9) return;
  out.push('0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0', '40', f(r));
}

function emitArc(
  out: string[],
  layer: string,
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): void {
  out.push(
    '0', 'ARC', '8', layer,
    '10', f(cx), '20', f(cy), '30', '0', '40', f(r),
    '50', startDeg.toFixed(4), '51', endDeg.toFixed(4),
  );
}

function emitText(
  out: string[],
  layer: string,
  x: number,
  y: number,
  height: number,
  text: string,
  align: 'left' | 'center' = 'left',
): void {
  const value = dxfTextValue(text);
  if (!value) return;
  out.push(
    '0', 'TEXT', '8', layer,
    '10', f(x), '20', f(y), '30', '0',
    '40', f(height), '1', value,
  );
  if (align === 'center') {
    // R12 centered TEXT: horizontal justification 1 + the 11/21 alignment point.
    out.push('72', '1', '11', f(x), '21', f(y), '31', '0');
  }
}

function emitSolidTriangle(
  out: string[],
  layer: string,
  tip: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): void {
  out.push(
    '0', 'SOLID', '8', layer,
    '10', f(tip.x), '20', f(tip.y), '30', '0',
    '11', f(b1.x), '21', f(b1.y), '31', '0',
    '12', f(b2.x), '22', f(b2.y), '32', '0',
    '13', f(b2.x), '23', f(b2.y), '33', '0',
  );
}

/**
 * A view arc → DXF ARC degrees. DXF arcs always sweep CCW from group 50 to
 * 51; view angles live in a +y-up frame the writer's y-flip restores, so
 * view angle θ IS the DXF angle. CW view arcs (ccw === false) swap their
 * endpoints; full sweeps degrade to CIRCLE.
 */
function sheetArcDegrees(arc: DrawingArc): { start: number; end: number; full: boolean; skip: boolean } {
  const TAU = Math.PI * 2;
  const ccw = arc.ccw !== false;
  let sweep = ccw ? arc.endAngle - arc.startAngle : arc.startAngle - arc.endAngle;
  while (sweep < 0) sweep += TAU;
  while (sweep >= TAU) sweep -= TAU;
  if (sweep >= TAU - 1e-6) return { start: 0, end: 360, full: true, skip: false };
  if (sweep <= 1e-9) return { start: 0, end: 0, full: false, skip: true };
  const deg = 180 / Math.PI;
  return {
    start: (ccw ? arc.startAngle : arc.endAngle) * deg,
    end: (ccw ? arc.endAngle : arc.startAngle) * deg,
    full: false,
    skip: false,
  };
}

/** 45° hatch scanlines through a sheet-space polygon (even-odd pairing). */
function hatchFace(
  poly: { x: number; y: number }[],
  spacing = HATCH_SPACING,
): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const out: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  const cOf = (p: { x: number; y: number }) => p.y - p.x; // constant along (1,1)
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const p of poly) {
    cMin = Math.min(cMin, cOf(p));
    cMax = Math.max(cMax, cOf(p));
  }
  const step = spacing * Math.SQRT2;
  for (let c = cMin; c <= cMax + 1e-9; c += step) {
    const hits: { x: number; y: number }[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const fp = cOf(p);
      const fq = cOf(q);
      if (Math.abs(fq - fp) < 1e-12) continue; // edge parallel to the scanline
      const t = (c - fp) / (fq - fp);
      if (t < 0 || t >= 1) continue;
      hits.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
    if (hits.length < 2) continue;
    hits.sort((u, v) => u.x - v.x);
    for (let k = 0; k + 1 < hits.length; k += 2) out.push({ a: hits[k]!, b: hits[k + 1]! });
  }
  return out;
}

/** One dimension arrowhead: a SOLID triangle at `at`, pointing along (ux, uy). */
function emitDimArrow(
  out: string[],
  at: { x: number; y: number },
  ux: number,
  uy: number,
  fy: (y: number) => number,
): void {
  const tip = { x: at.x + ux * DXF_ARROW_LEN, y: at.y + uy * DXF_ARROW_LEN };
  const b1 = { x: at.x - uy * DXF_ARROW_HALF_W, y: at.y + ux * DXF_ARROW_HALF_W };
  const b2 = { x: at.x + uy * DXF_ARROW_HALF_W, y: at.y - ux * DXF_ARROW_HALF_W };
  emitSolidTriangle(
    out,
    'DIMENSIONS',
    { x: tip.x, y: fy(tip.y) },
    { x: b1.x, y: fy(b1.y) },
    { x: b2.x, y: fy(b2.y) },
  );
}

/**
 * Export the drawing SHEET as a 2D R12 DXF: the same grid layout, view
 * transforms, annotations and title block the canvas shows. Entity mapping:
 * view LINEs → LINE (OUTLINE), detected circles → CIRCLE, fitted arcs → ARC,
 * center marks → CENTER-linetype crosses, section faces → outline + HATCH,
 * dimensions → LINE + SOLID arrowheads + TEXT, callouts/notes/names → TEXT.
 */
export function exportSheetDXF(
  views: DrawingView | DrawingView[],
  width = 800,
  height = 600,
  extras: DrawingSheetExtras = {},
): string {
  const list = Array.isArray(views) ? views : [views];
  const cols = Math.min(2, Math.max(1, list.length));
  const rows = Math.ceil(list.length / cols) || 1;
  const cellW = width / cols;
  const cellH = height / rows;
  const padding = 40;

  // Detail strip below the base sheet — identical math to exportDrawingSVG.
  const detailInputs = (extras.details ?? []).map((d) => {
    const source = d.viewIndex >= 0 && d.viewIndex < list.length ? list[d.viewIndex]! : undefined;
    return {
      scale: d.scale,
      radius: d.radius,
      sourceScale: source ? viewTransform(source, { x: 0, y: 0, w: cellW, h: cellH }, padding).scale : 0,
    };
  });
  const { panels, stripHeight } = layoutDetailPanels(detailInputs, width, height, cellW, cellH);
  const totalHeight = height + stripHeight;

  // Sheet px → CAD mm with the y axis flipped to +y-up.
  const fy = (y: number) => totalHeight - y;

  const out: string[] = [];

  // Header (R12 / AC1009).
  out.push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC');

  // Tables: the CENTER linetype (the CENTER layer + cutting-plane traces need
  // it — never reference an LTYPE that has no table entry), a STANDARD text
  // style for TEXT entities, and the layer table.
  out.push('0', 'SECTION', '2', 'TABLES');
  out.push(
    '0', 'TABLE', '2', 'LTYPE', '70', '1',
    '0', 'LTYPE', '2', 'CENTER', '70', '0', '3', 'Center ____ _ ____ _ ____ _ ____ _ ____ _ ____',
    // Group 40 (total pattern length) must equal the dash-element sum:
    // 1.25 + 0.25 + 0.25 + 0.25 = 2.0 (was 2.5 — a spec mismatch some readers tolerate).
    '72', '65', '73', '4', '40', '2.0', '49', '1.25', '49', '-0.25', '49', '0.25', '49', '-0.25',
    '0', 'ENDTAB',
  );
  out.push(
    '0', 'TABLE', '2', 'STYLE', '70', '1',
    '0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0', '41', '1', '50', '0', '71', '0',
    '42', f(SHEET_TEXT_HEIGHT), '3', 'txt', '4', '',
    '0', 'ENDTAB',
  );
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(SHEET_LAYERS.length + 1));
  out.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  for (const l of SHEET_LAYERS) {
    out.push('0', 'LAYER', '2', l.name, '70', '0', '62', String(l.color), '6', l.linetype);
  }
  out.push('0', 'ENDTAB');
  out.push('0', 'ENDSEC');

  out.push('0', 'SECTION', '2', 'ENTITIES');

  const placements = list.map((view, i) => ({
    view,
    viewIndex: i,
    ox: (i % cols) * cellW,
    oy: Math.floor(i / cols) * cellH,
    transform: viewTransform(
      view,
      { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, w: cellW, h: cellH },
      padding,
    ),
  }));

  for (const { view, viewIndex, ox, oy, transform } of placements) {
    // Hidden views (per-view placement) are skipped exactly like the SVG
    // writer — the sheet shows only what the canvas shows.
    if (view.placement?.visible === false) continue;
    // View name: the canvas title position (top-centre, baseline +20).
    emitText(out, 'NOTES', ox + cellW / 2, fy(oy + 20), SHEET_TEXT_HEIGHT, view.name, 'center');
    // Scale caption under the title, mirroring the canvas/SVG ratio label.
    if (view.placement?.scaleLabel) {
      emitText(out, 'NOTES', ox + cellW / 2, fy(oy + 34), SHEET_TEXT_HEIGHT * 0.8, view.placement.scaleLabel, 'center');
    }

    for (const line of view.lines) {
      const p1 = transform.toSheet(line.start);
      const p2 = transform.toSheet(line.end);
      emitLine(out, 'OUTLINE', p1.x, fy(p1.y), p2.x, fy(p2.y));
    }

    // Detected circles as true CIRCLEs (the coincident tessellation LINEs
    // stay too — view.lines does not tag them apart).
    for (const m of view.centers ?? []) {
      const c = transform.toSheet(m);
      emitCircle(out, 'OUTLINE', c.x, fy(c.y), m.radius * transform.scale);
    }

    for (const arc of view.arcs) {
      const r = arc.radius * transform.scale;
      if (r < 1e-9) continue;
      const a = sheetArcDegrees(arc);
      if (a.skip) continue;
      const c = transform.toSheet(arc.center);
      if (a.full) emitCircle(out, 'OUTLINE', c.x, fy(c.y), r);
      else emitArc(out, 'OUTLINE', c.x, fy(c.y), r, a.start, a.end);
    }

    // Center-mark crosses (the CENTER linetype rides on the entities).
    for (const m of view.centers ?? []) {
      const c = transform.toSheet(m);
      const arm = m.radius * transform.scale * CENTER_MARK_ARM_RATIO;
      emitLine(out, 'CENTER', c.x - arm, fy(c.y), c.x + arm, fy(c.y), 'CENTER');
      emitLine(out, 'CENTER', c.x, fy(c.y - arm), c.x, fy(c.y + arm), 'CENTER');
    }

    // Section cut faces: outline loop + 45° hatch.
    for (const face of view.sectionFaces ?? []) {
      const pts = face.map((p) => transform.toSheet(p));
      if (pts.length < 3) continue;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k]!;
        const b = pts[(k + 1) % pts.length]!;
        emitLine(out, 'OUTLINE', a.x, fy(a.y), b.x, fy(b.y));
      }
      for (const seg of hatchFace(pts)) {
        emitLine(out, 'HATCH', seg.a.x, fy(seg.a.y), seg.b.x, fy(seg.b.y));
      }
    }

    // Dimensions: the shared sheet geometry + SOLID arrowheads + value TEXT.
    for (const dim of view.dimensions) {
      const g = dimensionSheetGeometry(dim, transform.toSheet);
      emitLine(out, 'DIMENSIONS', g.dim.start.x, fy(g.dim.start.y), g.dim.end.x, fy(g.dim.end.y));
      for (const e of g.ext) {
        emitLine(out, 'DIMENSIONS', e.start.x, fy(e.start.y), e.end.x, fy(e.end.y));
      }
      const dx = g.dim.end.x - g.dim.start.x;
      const dy = g.dim.end.y - g.dim.start.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      emitDimArrow(out, g.dim.start, -ux, -uy, fy);
      emitDimArrow(out, g.dim.end, ux, uy, fy);
      emitText(out, 'DIMENSIONS', g.text.x, fy(g.text.y), SHEET_TEXT_HEIGHT, formatDimValue(dim.value), 'center');
    }

    // Hole callouts: leader LINEs + localized text.
    for (const c of (extras.holeCallouts ?? []).filter((h) => h.viewIndex === viewIndex)) {
      const g = calloutSheetGeometry(transform.toSheet(c.center), c.radius * transform.scale);
      emitLine(out, 'CALLOUT', g.leader[0]!.x, fy(g.leader[0]!.y), g.leader[1]!.x, fy(g.leader[1]!.y));
      emitLine(out, 'CALLOUT', g.leader[1]!.x, fy(g.leader[1]!.y), g.leader[2]!.x, fy(g.leader[2]!.y));
      emitText(out, 'CALLOUT', g.text.x, fy(g.text.y), SHEET_TEXT_HEIGHT, c.text);
    }

    // Cutting-plane trace: chain LINE (CENTER linetype override) + arrows +
    // the cut letter.
    for (const cut of extras.sectionCuts ?? []) {
      if (cut.viewIndex !== viewIndex) continue;
      const trace = cutPlaneSheetTrace(view, transform.toSheet, cut);
      if (!trace) continue;
      emitLine(
        out,
        'OUTLINE',
        trace.line.start.x,
        fy(trace.line.start.y),
        trace.line.end.x,
        fy(trace.line.end.y),
        'CENTER',
      );
      for (const a of trace.arrows) {
        emitSolidTriangle(
          out,
          'OUTLINE',
          { x: a.tip.x, y: fy(a.tip.y) },
          { x: a.base1.x, y: fy(a.base1.y) },
          { x: a.base2.x, y: fy(a.base2.y) },
        );
      }
      for (const l of trace.labels) {
        emitText(out, 'NOTES', l.x, fy(l.y), 3.5, cut.label || 'A', 'center');
      }
    }
  }

  // Detail views: source circle + border + clipped geometry + panel title.
  const details = extras.details ?? [];
  for (const panel of panels) {
    const detail = details[panel.detailIndex]!;
    const source = placements[detail.viewIndex]!;
    const srcC = source.transform.toSheet(detail.center);
    emitCircle(out, 'NOTES', srcC.x, fy(srcC.y), detail.radius * source.transform.scale);
    emitCircle(out, 'OUTLINE', panel.cx, fy(panel.cy), panel.rPx);
    const crop = { center: detail.center, radius: detail.radius };
    for (const line of clipViewToCircle(source.view, crop)) {
      const p1 = detailPointToSheet(line.start, detail.center, panel);
      const p2 = detailPointToSheet(line.end, detail.center, panel);
      emitLine(out, 'OUTLINE', p1.x, fy(p1.y), p2.x, fy(p2.y));
    }
    // Center marks inside the crop circle, arms clipped to it.
    for (const m of source.view.centers ?? []) {
      const arm = m.radius * CENTER_MARK_ARM_RATIO;
      if (Math.hypot(m.x - crop.center.x, m.y - crop.center.y) - arm > crop.radius) continue;
      const spans = [
        clipSegmentToCircle({ x: m.x - arm, y: m.y }, { x: m.x + arm, y: m.y }, crop),
        clipSegmentToCircle({ x: m.x, y: m.y - arm }, { x: m.x, y: m.y + arm }, crop),
      ];
      for (const seg of spans) {
        if (!seg) continue;
        const p1 = detailPointToSheet(seg.start, detail.center, panel);
        const p2 = detailPointToSheet(seg.end, detail.center, panel);
        emitLine(out, 'CENTER', p1.x, fy(p1.y), p2.x, fy(p2.y), 'CENTER');
      }
    }
    emitText(out, 'NOTES', panel.cx, fy(panel.cy + panel.rPx + 16), SHEET_TEXT_HEIGHT, panel.title, 'center');
  }

  // Notes: plain text at sheet positions (baseline-anchored like the canvas).
  for (const note of extras.notes ?? []) {
    if (!note.text) continue;
    emitText(out, 'NOTES', note.x, fy(note.y), SHEET_TEXT_HEIGHT, note.text);
  }

  // Title block as LINE frame + dividers + TEXT fields (shared layout).
  const tb = titleBlockLayout({ ...defaultTitleBlock(), ...extras.titleBlock }, width, totalHeight);
  const r = tb.rect;
  emitLine(out, 'OUTLINE', r.x, fy(r.y), r.x + r.w, fy(r.y));
  emitLine(out, 'OUTLINE', r.x + r.w, fy(r.y), r.x + r.w, fy(r.y + r.h));
  emitLine(out, 'OUTLINE', r.x + r.w, fy(r.y + r.h), r.x, fy(r.y + r.h));
  emitLine(out, 'OUTLINE', r.x, fy(r.y + r.h), r.x, fy(r.y));
  emitLine(out, 'OUTLINE', tb.dividerH.start.x, fy(tb.dividerH.start.y), tb.dividerH.end.x, fy(tb.dividerH.end.y));
  emitLine(out, 'OUTLINE', tb.dividerV.start.x, fy(tb.dividerV.start.y), tb.dividerV.end.x, fy(tb.dividerV.end.y));
  for (const field of tb.fields) {
    emitText(out, 'NOTES', field.x, fy(field.y), field.size / 4, field.text);
  }

  out.push('0', 'ENDSEC');
  out.push('0', 'EOF');

  return out.join('\r\n');
}
