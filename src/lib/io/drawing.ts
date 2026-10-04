import type { SolidBody, Vec3 } from '../geometry/types';
import { layoutDetailPanels, detailPointToSheet, type DetailPanelInput, type DrawingDetail, type DrawingNote } from './drawingNotes';
import { detectCircles } from './drawingCircles';
import type { HoleCallout } from './drawingCallouts';

export interface DrawingLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface DrawingArc {
  center: { x: number; y: number };
  radius: number;
  startAngle: number;
  endAngle: number;
  /**
   * Sweep direction from startAngle to endAngle in view coords (default true
   * = counter-clockwise). Needed whenever the sweep differs from the default
   * minor-arc reading — e.g. a sectioned cylinder cap.
   */
  ccw?: boolean;
}

/** An ASME center mark: a detected circle's centre and radius (view units). */
export interface DrawingCenterMark {
  x: number;
  y: number;
  radius: number;
}

export interface DrawingDimension {
  type: 'linear' | 'angular' | 'radius';
  start: { x: number; y: number };
  end: { x: number; y: number };
  value: number;
  /**
   * Advisory stacking offset (view units) from generation time. Sheet
   * renderers ignore it: dimension lines are placed a fixed SHEET-PIXEL
   * distance from the measured geometry (see dimensionSheetGeometry), so the
   * gap survives any auto-fit scale.
   */
  offset: number;
  /**
   * Editable dimensions carry a driver: the dimension measures (and can set)
   * this body's extent along a world axis. Only axis-aligned views (front,
   * top, right, …) produce drivers — an iso view measures no single axis.
   */
  driver?: { bodyId: string; axis: 'x' | 'y' | 'z' };
}

export interface DrawingView {
  name: string;
  lines: DrawingLine[];
  arcs: DrawingArc[];
  dimensions: DrawingDimension[];
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  /** Section-view cut faces (planar polygons on the cutting plane), hatched. */
  sectionFaces?: { x: number; y: number }[][];
  /**
   * Detected circle centres for center marks (see drawingCircles.ts). Always
   * on — no toggle. Rendered by the canvas + SVG exporter; detail views clip
   * them via clipSegmentToCircle. The DXF exporter does not consume views
   * (it exports raw body edges) and is deliberately left without marks.
   */
  centers?: DrawingCenterMark[];
}

/** Half-space section clip: keep the geometry on the negative side of the plane. */
export interface SectionPlane {
  /** Plane normal (unit-ish); the positive side is removed. */
  normal: Vec3;
  /** Plane offset: the plane is the set {p : p·normal = offset}. */
  offset: number;
}

/** Circular crop region for detail views (model coords of a view's projection). */
export interface ClipCircle {
  center: { x: number; y: number };
  radius: number;
}

/**
 * Clip a segment to the interior of a circle (detail-view crop): keep it whole
 * when both endpoints lie inside, drop it when entirely outside, and trim it
 * to the chord where it crosses the border. Returns null for no overlap
 * (tangency counts as no overlap — a zero-length chord draws nothing).
 */
export function clipSegmentToCircle(
  start: { x: number; y: number },
  end: { x: number; y: number },
  circle: ClipCircle,
): DrawingLine | null {
  const { center, radius } = circle;
  const r2 = radius * radius;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fx = start.x - center.x;
  const fy = start.y - center.y;
  const da = fx * fx + fy * fy;
  const db = (end.x - center.x) ** 2 + (end.y - center.y) ** 2;
  if (da <= r2 && db <= r2) return { start, end };
  const a = dx * dx + dy * dy;
  if (a === 0) return null; // degenerate point segment
  // |start + t·d − center|² = r²  →  a·t² + 2b·t + c = 0
  const b = fx * dx + fy * dy;
  const c = da - r2;
  const disc = b * b - a * c;
  if (disc < 0) return null; // the segment's line misses the circle
  const sq = Math.sqrt(disc);
  const lo = Math.max((-b - sq) / a, 0);
  const hi = Math.min((-b + sq) / a, 1);
  if (lo > hi || hi - lo < 1e-12) return null;
  return {
    start: { x: start.x + dx * lo, y: start.y + dy * lo },
    end: { x: start.x + dx * hi, y: start.y + dy * hi },
  };
}

/** Crop a view's projected lines to a circle (detail-view geometry). */
export function clipViewToCircle(view: DrawingView, circle: ClipCircle): DrawingLine[] {
  const out: DrawingLine[] = [];
  for (const line of view.lines) {
    const seg = clipSegmentToCircle(line.start, line.end, circle);
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * How a view is placed in one grid cell of the sheet: fit into the cell
 * (minus padding and the 20px title strip) and centre, with model +y mapped
 * to sheet-up. `toModel` is the exact inverse of `toSheet` (used to turn a
 * sheet click on a view into model coords, e.g. placing a detail view).
 */
export interface ViewTransform {
  /** px per model unit. */
  scale: number;
  toSheet(p: { x: number; y: number }): { x: number; y: number };
  toModel(p: { x: number; y: number }): { x: number; y: number };
}

/** Compute a view's placement in a grid cell (origin at the cell's top-left). */
export function viewTransform(
  view: DrawingView,
  cell: { x: number; y: number; w: number; h: number },
  padding = 40,
): ViewTransform {
  const viewW = view.bounds.max.x - view.bounds.min.x;
  const viewH = view.bounds.max.y - view.bounds.min.y;
  const scaleX = (cell.w - padding * 2) / (viewW || 1);
  const scaleY = (cell.h - padding * 2 - 20) / (viewH || 1);
  const scale = Math.min(scaleX, scaleY);
  const offsetX = cell.x + padding + (cell.w - padding * 2 - viewW * scale) / 2;
  const offsetY = cell.y + 20 + padding + (cell.h - padding * 2 - 20 - viewH * scale) / 2;
  return {
    scale,
    toSheet(p) {
      return {
        x: (p.x - view.bounds.min.x) * scale + offsetX,
        y: cell.h - ((p.y - view.bounds.min.y) * scale + offsetY) + cell.y,
      };
    },
    toModel(p) {
      return {
        x: view.bounds.min.x + (p.x - offsetX) / scale,
        y: view.bounds.min.y + (cell.h + cell.y - offsetY - p.y) / scale,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Dimension sheet geometry.
//
// Dimension offsets used to be baked into the generated dim coordinates in
// PROJECTED units (8 / 26), which auto-fit then scaled: a 1000 mm body fit
// into a cell at ~0.006 px per unit collapsed the "8 unit" gap to ~0.05 px —
// the dimension line sat ON the outline. The placement now lives in SHEET
// pixels, computed per render from the measured points.
// ---------------------------------------------------------------------------

/** Dimension-line standoff from the measured geometry (sheet px). */
export const DIM_OFFSET_PX = 24;
/** Gap between the measured point and the start of its extension line (px). */
export const DIM_EXT_GAP_PX = 1.5;
/** Extension-line overshoot past the dimension line (px). */
export const DIM_EXT_OVERSHOOT_PX = 2;

export interface SheetDimGeometry {
  /** The dimension line, DIM_OFFSET_PX off the measured span (perpendicular). */
  dim: { start: { x: number; y: number }; end: { x: number; y: number } };
  /** Extension lines from each measured point (gap → overshoot). */
  ext: { start: { x: number; y: number }; end: { x: number; y: number } }[];
  /** Text anchor: midpoint of the dimension line, a little above it. */
  text: { x: number; y: number };
}

/**
 * Place a dimension on the sheet: the measured points are projected with
 * `toSheet`, the dimension line is offset perpendicular by DIM_OFFSET_PX (on
 * the same side the old generator used — below width dims, right of height
 * dims — because the perpendicular follows the sheet-space start→end
 * direction), with extension lines in between. Arrowheads are a later pass.
 */
export function dimensionSheetGeometry(
  dim: DrawingDimension,
  toSheet: (p: { x: number; y: number }) => { x: number; y: number },
): SheetDimGeometry {
  const a = toSheet(dim.start);
  const b = toSheet(dim.end);
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const len = Math.hypot(ux, uy) || 1;
  const nx = -uy / len;
  const ny = ux / len;
  const at = (p: { x: number; y: number }, d: number) => ({ x: p.x + nx * d, y: p.y + ny * d });
  const start = at(a, DIM_OFFSET_PX);
  const end = at(b, DIM_OFFSET_PX);
  return {
    dim: { start, end },
    ext: [
      { start: at(a, DIM_EXT_GAP_PX), end: at(a, DIM_OFFSET_PX + DIM_EXT_OVERSHOOT_PX) },
      { start: at(b, DIM_EXT_GAP_PX), end: at(b, DIM_OFFSET_PX + DIM_EXT_OVERSHOOT_PX) },
    ],
    text: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4 },
  };
}

/** One shared dimension-text format for the canvas and the SVG exporter. */
export function formatDimValue(v: number): string {
  return `${v.toFixed(1)} mm`;
}

// ---------------------------------------------------------------------------
// Hole-callout leader geometry (sheet px), shared by the canvas and the SVG
// exporter; see drawingCallouts.ts for how callouts are derived.
// ---------------------------------------------------------------------------

/** Horizontal text shelf length after the elbow (sheet px). */
export const CALLOUT_SHELF_PX = 18;

export interface CalloutSheetGeometry {
  /** Leader polyline: circle rim → 45° elbow → end of the text shelf. */
  leader: { x: number; y: number }[];
  /** Text anchor just past the shelf end. */
  text: { x: number; y: number };
}

/** Leader from a hole's rim at 45° up-right to an ~18 px text shelf. */
export function calloutSheetGeometry(
  center: { x: number; y: number },
  radius: number,
): CalloutSheetGeometry {
  const k = Math.SQRT1_2;
  const reach = radius + 10;
  const elbow = { x: center.x + k * reach, y: center.y - k * reach };
  const shelfEnd = { x: elbow.x + CALLOUT_SHELF_PX, y: elbow.y };
  return {
    leader: [
      { x: center.x + k * radius, y: center.y - k * radius },
      elbow,
      shelfEnd,
    ],
    text: { x: shelfEnd.x + 2, y: shelfEnd.y - 3 },
  };
}

/** Project a 3D body onto a 2D plane for drawing */
export function projectBody(
  body: SolidBody,
  viewDir: Vec3,
  upDir: Vec3,
  scale = 1,
): DrawingView {
  return projectBodies([body], viewDir, upDir, scale, `${body.name} - ${getViewName(viewDir)}`);
}

/**
 * Project a multi-body scene onto a 2D plane, merging every body's edges into
 * one view (like Fusion 360's "Project Full View" of the whole design). The
 * auto-dimensions span the combined bounds, not the first body's.
 */
export function projectBodies(
  bodies: SolidBody[],
  viewDir: Vec3,
  upDir: Vec3,
  scale = 1,
  name = getViewName(viewDir),
  section?: SectionPlane,
): DrawingView {
  // Screen right-axis for a right-handed view frame (right × up = viewDir,
  // i.e. +Z out of the screen toward the viewer). Using cross(viewDir, up)
  // instead would flip the drawing horizontally — a front view of +X would
  // project to the left.
  const right = viewRightAxis(upDir, viewDir);
  const lines: DrawingLine[] = [];
  const sectionFaces: { x: number; y: number }[][] = [];
  // Projected geometry per body: each body's own dimensions are measured from
  // the geometry it actually contributed (post section-clip), not scene bounds.
  const perBodyPts: { body: SolidBody; pts: { x: number; y: number }[] }[] = [];

  const sd = (p: Vec3): number =>
    section ? p.x * section.normal.x + p.y * section.normal.y + p.z * section.normal.z - section.offset : -1;
  // Clip a segment to the kept half-space (n·p <= offset); null when fully cut.
  const clipSeg = (a: Vec3, b: Vec3): [Vec3, Vec3] | null => {
    if (!section) return [a, b];
    const da = sd(a);
    const db = sd(b);
    if (da > 0 && db > 0) return null;
    if (da <= 0 && db <= 0) return [a, b];
    const t = da / (da - db);
    const cut: Vec3 = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
    return da <= 0 ? [a, cut] : [cut, b];
  };

  for (const body of bodies) {
    const bodyPts: { x: number; y: number }[] = [];
    for (const edge of body.edges) {
      const seg = clipSeg(edge.start, edge.end);
      if (!seg) continue;
      const p1 = projectPoint(seg[0], viewDir, right, upDir, scale);
      const p2 = projectPoint(seg[1], viewDir, right, upDir, scale);
      lines.push({ start: p1, end: p2 });
      bodyPts.push(p1, p2);
    }
    if (bodyPts.length > 0) perBodyPts.push({ body, pts: bodyPts });
    // Section cut faces: clip each face polygon to the kept side and collect
    // the edges the clip created ON the plane; chain those into closed loops —
    // the cross-section outline(s) of the cut.
    if (section) {
      const segs: [Vec3, Vec3][] = [];
      for (const face of body.faces) {
        const poly = clipPolygonToHalfSpace(face.vertices, section.normal, section.offset);
        if (poly.length < 3) continue;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          if (Math.abs(sd(a)) < 1e-6 && Math.abs(sd(b)) < 1e-6) {
            segs.push([a, b]);
          }
        }
      }
      for (const loop of chainOnPlaneLoops(segs)) {
        sectionFaces.push(loop.map((p) => projectPoint(p, viewDir, right, upDir, scale)));
      }
    }
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.start.x, line.end.x);
    minY = Math.min(minY, line.start.y, line.end.y);
    maxX = Math.max(maxX, line.start.x, line.end.x);
    maxY = Math.max(maxY, line.start.y, line.end.y);
  }
  if (lines.length === 0) { minX = minY = maxX = maxY = 0; }

  // Dimensions: per-body width/height (editable when the view is axis-aligned)
  // plus overall scene dims when several bodies are in view. A single body's
  // own dimensions already span the view, so the overall pair would duplicate.
  const widthAxis = dominantWorldAxis(right);
  const heightAxis = dominantWorldAxis(upDir);
  const dimensions = bodyDimensions(perBodyPts, widthAxis, heightAxis, scale);

  // Circle/arc detection over the (post section-clip) projected lines: center
  // marks for closed circular loops, fitted arcs for open constant-curvature
  // chains. Tessellation lines are kept — the detections annotate them.
  const { centers, arcs } = detectCircles(lines);

  return {
    name,
    lines,
    arcs,
    dimensions,
    centers: centers.length > 0 ? centers : undefined,
    sectionFaces: sectionFaces.length > 0 ? sectionFaces : undefined,
    bounds: {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
    },
  };
}

/** Sutherland–Hodgman: clip a polygon to {p : p·n <= offset}. */
function clipPolygonToHalfSpace(poly: Vec3[], n: Vec3, offset: number): Vec3[] {
  if (poly.length < 3) return [];
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = a.x * n.x + a.y * n.y + a.z * n.z - offset;
    const db = b.x * n.x + b.y * n.y + b.z * n.z - offset;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      });
    }
  }
  return out;
}

/** Chain coplanar segments sharing endpoints into closed loops (>= 3 points). */
function chainOnPlaneLoops(segs: [Vec3, Vec3][]): Vec3[][] {
  const key = (p: Vec3) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
  const adj = new Map<string, { seg: number; other: Vec3 }[]>();
  segs.forEach(([a, b], i) => {
    (adj.get(key(a)) ?? adj.set(key(a), []).get(key(a))!).push({ seg: i, other: b });
    (adj.get(key(b)) ?? adj.set(key(b), []).get(key(b))!).push({ seg: i, other: a });
  });

  const loops: Vec3[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const start = segs[i]![0];
    const loop: Vec3[] = [start, segs[i]![1]];
    let cur = segs[i]![1];
    for (let guard = 0; guard <= segs.length; guard++) {
      if (key(cur) === key(start)) {
        loop.pop(); // drop the duplicated closing point
        break;
      }
      const next = (adj.get(key(cur)) ?? []).find((c) => !used.has(c.seg));
      if (!next) break;
      used.add(next.seg);
      cur = next.other;
      loop.push(cur);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Orthographic projection of a 3D point onto a view's 2D plane (× scale). */
export function projectPoint(
  p: Vec3,
  _viewDir: Vec3,
  right: Vec3,
  up: Vec3,
  scale: number,
): { x: number; y: number } {
  return {
    x: (p.x * right.x + p.y * right.y + p.z * right.z) * scale,
    y: (p.x * up.x + p.y * up.y + p.z * up.z) * scale,
  };
}

/**
 * The screen right-axis of a view frame: right × up = viewDir (+Z out of the
 * screen). Exported so callout anchoring reuses the exact projection frame
 * projectBodies uses (a flipped right-axis would mirror hole positions).
 */
export function viewRightAxis(upDir: Vec3, viewDir: Vec3): Vec3 {
  return cross(upDir, viewDir);
}

/**
 * The world axis a view frame direction measures, when it is (close to)
 * axis-aligned. Oblique directions measure no single world axis.
 */
function dominantWorldAxis(v: Vec3): 'x' | 'y' | 'z' | undefined {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  const m = Math.max(ax, ay, az);
  if (m < 0.9) return undefined;
  return ax === m ? 'x' : ay === m ? 'y' : 'z';
}

/** Per-body width/height dimensions, plus overall scene dims when >1 body.
 *  start/end sit ON the measured geometry extent — the renderers offset the
 *  dimension line a fixed sheet-px distance from them (dimensionSheetGeometry);
 *  `offset` is kept only as advisory stacking info. */
function bodyDimensions(
  perBody: { body: SolidBody; pts: { x: number; y: number }[] }[],
  widthAxis: 'x' | 'y' | 'z' | undefined,
  heightAxis: 'x' | 'y' | 'z' | undefined,
  scale: number,
): DrawingDimension[] {
  const dims: DrawingDimension[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { body, pts } of perBody) {
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const p of pts) {
      bMinX = Math.min(bMinX, p.x); bMinY = Math.min(bMinY, p.y);
      bMaxX = Math.max(bMaxX, p.x); bMaxY = Math.max(bMaxY, p.y);
    }
    minX = Math.min(minX, bMinX); minY = Math.min(minY, bMinY);
    maxX = Math.max(maxX, bMaxX); maxY = Math.max(maxY, bMaxY);
    dims.push({
      type: 'linear',
      start: { x: bMinX, y: bMinY },
      end: { x: bMaxX, y: bMinY },
      value: (bMaxX - bMinX) / scale,
      offset: 8,
      ...(widthAxis ? { driver: { bodyId: body.id, axis: widthAxis } } : {}),
    });
    dims.push({
      type: 'linear',
      start: { x: bMaxX, y: bMinY },
      end: { x: bMaxX, y: bMaxY },
      value: (bMaxY - bMinY) / scale,
      offset: 8,
      ...(heightAxis ? { driver: { bodyId: body.id, axis: heightAxis } } : {}),
    });
  }
  if (perBody.length > 1) {
    dims.push(
      {
        type: 'linear',
        start: { x: minX, y: minY },
        end: { x: maxX, y: minY },
        value: (maxX - minX) / scale,
        offset: 26,
      },
      {
        type: 'linear',
        start: { x: maxX, y: minY },
        end: { x: maxX, y: maxY },
        value: (maxY - minY) / scale,
        offset: 26,
      },
    );
  }
  return dims;
}

function getViewName(dir: Vec3): string {
  const { x, y, z } = dir;
  if (Math.abs(y) > 0.9) return y > 0 ? 'Top' : 'Bottom';
  if (Math.abs(z) > 0.9) return z > 0 ? 'Front' : 'Back';
  if (Math.abs(x) > 0.9) return x > 0 ? 'Right' : 'Left';
  return 'Iso';
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Extra sheet annotations the SVG exporter can include alongside the views. */
export interface DrawingSheetExtras {
  /** Detail-view definitions (see drawingNotes.ts); viewIndex indexes `views`. */
  details?: DrawingDetail[];
  /** Text notes at sheet px ({x, y} of an 800×600-base sheet). */
  notes?: DrawingNote[];
  /** Hole callouts (see drawingCallouts.ts); viewIndex indexes `views`. */
  holeCallouts?: HoleCallout[];
}

/** Center-mark arm half-length as a multiple of the circle radius (ASME). */
export const CENTER_MARK_ARM_RATIO = 1.25;

/** The two cross arms of a center mark, as view-coord segments. */
function centerMarkArms(m: DrawingCenterMark): DrawingLine[] {
  const arm = m.radius * CENTER_MARK_ARM_RATIO;
  return [
    { start: { x: m.x - arm, y: m.y }, end: { x: m.x + arm, y: m.y } },
    { start: { x: m.x, y: m.y - arm }, end: { x: m.x, y: m.y + arm } },
  ];
}

/** SVG arc path honoring start/end angles (the old export drew full circles). */
function arcToSvgPath(
  c: { x: number; y: number },
  r: number,
  arc: DrawingArc,
): string {
  // View coords are +y up, the SHEET's +y is down (viewTransform flips) —
  // mirror ONLY the y component (c.y − r·sin). The sweep direction is
  // unchanged by this mapping (view-CCW stays visually CCW on screen =
  // SVG sweep-flag 0); the original bug was drawing at c.y + r·sin, which
  // placed the arc on the WRONG side of its center.
  const at = (angle: number) => ({
    x: c.x + r * Math.cos(angle),
    y: c.y - r * Math.sin(angle),
  });
  const p1 = at(arc.startAngle);
  const p2 = at(arc.endAngle);
  const ccw = arc.ccw !== false;
  let sweepAngle = ccw ? arc.endAngle - arc.startAngle : arc.startAngle - arc.endAngle;
  while (sweepAngle < 0) sweepAngle += 2 * Math.PI;
  while (sweepAngle >= 2 * Math.PI) sweepAngle -= 2 * Math.PI;
  const largeArc = sweepAngle > Math.PI ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} ${ccw ? 0 : 1} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

/** Export one or more drawing views as SVG, laid out in a grid like the canvas */
export function exportDrawingSVG(
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

  // Detail panels live in a strip below the base sheet, sized off the
  // first-view grid cells (the canvas uses the same math). Details whose
  // viewIndex is stale (no source view) get sourceScale 0 and are skipped.
  const detailInputs: DetailPanelInput[] = (extras.details ?? []).map((d) => {
    const source = d.viewIndex >= 0 && d.viewIndex < list.length ? list[d.viewIndex]! : undefined;
    return {
      scale: d.scale,
      radius: d.radius,
      sourceScale: source ? viewTransform(source, { x: 0, y: 0, w: cellW, h: cellH }, padding).scale : 0,
    };
  });
  const { panels, stripHeight } = layoutDetailPanels(detailInputs, width, height, cellW, cellH);
  const totalHeight = height + stripHeight;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <defs>
    <pattern id="sectionHatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#555" stroke-width="0.5" />
    </pattern>
  </defs>
  <rect width="${width}" height="${totalHeight}" fill="white" />
`;

  const placements = list.map((view, i) => ({
    view,
    viewIndex: i,
    ox: (i % cols) * cellW,
    oy: Math.floor(i / cols) * cellH,
    transform: viewTransform(view, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, w: cellW, h: cellH }, padding),
  }));

  for (const { view, viewIndex, ox, oy, transform } of placements) {
    svg += `  <g stroke="black" stroke-width="1" fill="none">\n`;
    for (const line of view.lines) {
      const p1 = transform.toSheet(line.start);
      const p2 = transform.toSheet(line.end);
      svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" />\n`;
    }
    for (const arc of view.arcs) {
      const c = transform.toSheet(arc.center);
      svg += `    <path d="${arcToSvgPath(c, arc.radius * transform.scale, arc)}" />\n`;
    }
    // Center marks: thin ASME crosses over detected circles.
    if (view.centers && view.centers.length > 0) {
      svg += `    <g stroke-width="0.5">\n`;
      for (const m of view.centers) {
        const c = transform.toSheet(m);
        const arm = m.radius * transform.scale * CENTER_MARK_ARM_RATIO;
        svg += `      <line x1="${(c.x - arm).toFixed(2)}" y1="${c.y.toFixed(2)}" x2="${(c.x + arm).toFixed(2)}" y2="${c.y.toFixed(2)}" />\n`;
        svg += `      <line x1="${c.x.toFixed(2)}" y1="${(c.y - arm).toFixed(2)}" x2="${c.x.toFixed(2)}" y2="${(c.y + arm).toFixed(2)}" />\n`;
      }
      svg += `    </g>\n`;
    }
    svg += '  </g>\n';

    // Section cut faces: hatched with the SVG pattern (45° drafting lines).
    if (view.sectionFaces && view.sectionFaces.length > 0) {
      svg += `  <g fill="url(#sectionHatch)" stroke="#555" stroke-width="0.5">\n`;
      for (const face of view.sectionFaces) {
        const pts = face.map((p) => transform.toSheet(p));
        if (pts.length < 3) continue;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z';
        svg += `    <path d="${d}" />\n`;
      }
      svg += '  </g>\n';
    }

    // Dimensions: fixed sheet-px offsets (see dimensionSheetGeometry).
    svg += `  <g stroke="red" stroke-width="0.5" fill="red" font-size="10">\n`;
    for (const dim of view.dimensions) {
      const g = dimensionSheetGeometry(dim, transform.toSheet);
      svg += `    <line x1="${g.dim.start.x.toFixed(2)}" y1="${g.dim.start.y.toFixed(2)}" x2="${g.dim.end.x.toFixed(2)}" y2="${g.dim.end.y.toFixed(2)}" stroke-dasharray="2,2" />\n`;
      for (const e of g.ext) {
        svg += `    <line x1="${e.start.x.toFixed(2)}" y1="${e.start.y.toFixed(2)}" x2="${e.end.x.toFixed(2)}" y2="${e.end.y.toFixed(2)}" />\n`;
      }
      svg += `    <text x="${g.text.x.toFixed(2)}" y="${g.text.y.toFixed(2)}" text-anchor="middle">${formatDimValue(dim.value)}</text>\n`;
    }
    svg += '  </g>\n';

    // Hole callouts: leader + shelf + text (after the dims group).
    const callouts = (extras.holeCallouts ?? []).filter((c) => c.viewIndex === viewIndex);
    if (callouts.length > 0) {
      svg += `  <g stroke="#333" stroke-width="0.5" fill="#333" font-size="10">\n`;
      for (const c of callouts) {
        const g = calloutSheetGeometry(transform.toSheet(c.center), c.radius * transform.scale);
        svg += `    <path d="M${g.leader[0]!.x.toFixed(2)} ${g.leader[0]!.y.toFixed(2)} L${g.leader[1]!.x.toFixed(2)} ${g.leader[1]!.y.toFixed(2)} L${g.leader[2]!.x.toFixed(2)} ${g.leader[2]!.y.toFixed(2)}" fill="none" />\n`;
        svg += `    <text x="${g.text.x.toFixed(2)}" y="${g.text.y.toFixed(2)}">${escapeXml(c.text)}</text>\n`;
      }
      svg += '  </g>\n';
    }

    // View title (top-centre of the cell)
    svg += `  <text x="${ox + cellW / 2}" y="${oy + 20}" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(view.name)}</text>\n`;
  }

  // Detail views: thin source circle on the parent view + magnified panel.
  const details = extras.details ?? [];
  for (const panel of panels) {
    const detail = details[panel.detailIndex]!;
    const source = placements[detail.viewIndex]!;
    const srcC = source.transform.toSheet(detail.center);
    const srcR = detail.radius * source.transform.scale;
    svg += `  <circle cx="${srcC.x.toFixed(2)}" cy="${srcC.y.toFixed(2)}" r="${srcR.toFixed(2)}" fill="none" stroke="#555" stroke-width="0.5" />\n`;

    svg += `  <g stroke="black" stroke-width="1" fill="none">\n`;
    svg += `    <clipPath id="detailClip${panel.detailIndex}"><circle cx="${panel.cx.toFixed(2)}" cy="${panel.cy.toFixed(2)}" r="${panel.rPx.toFixed(2)}" /></clipPath>\n`;
    svg += `    <circle cx="${panel.cx.toFixed(2)}" cy="${panel.cy.toFixed(2)}" r="${panel.rPx.toFixed(2)}" fill="white" stroke="black" stroke-width="1.5" />\n`;
    svg += `    <g clip-path="url(#detailClip${panel.detailIndex})">\n`;
    const crop = { center: detail.center, radius: detail.radius };
    for (const line of clipViewToCircle(source.view, crop)) {
      const p1 = detailPointToSheet(line.start, detail.center, panel);
      const p2 = detailPointToSheet(line.end, detail.center, panel);
      svg += `      <line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" />\n`;
    }
    // Center marks inside the crop circle, arms clipped to it.
    for (const m of source.view.centers ?? []) {
      const dMc = Math.hypot(m.x - crop.center.x, m.y - crop.center.y);
      if (dMc - m.radius * CENTER_MARK_ARM_RATIO > crop.radius) continue;
      svg += `      <g stroke-width="0.5">\n`;
      for (const armSeg of centerMarkArms(m)) {
        const seg = clipSegmentToCircle(armSeg.start, armSeg.end, crop);
        if (!seg) continue;
        const p1 = detailPointToSheet(seg.start, detail.center, panel);
        const p2 = detailPointToSheet(seg.end, detail.center, panel);
        svg += `        <line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" />\n`;
      }
      svg += `      </g>\n`;
    }
    svg += `    </g>\n`;
    svg += '  </g>\n';
    svg += `  <text x="${panel.cx.toFixed(2)}" y="${(panel.cy + panel.rPx + 16).toFixed(2)}" text-anchor="middle" font-size="12" font-weight="bold">${escapeXml(panel.title)}</text>\n`;
  }

  // Notes: plain text at sheet positions.
  for (const note of extras.notes ?? []) {
    if (!note.text) continue;
    svg += `  <text x="${note.x.toFixed(2)}" y="${note.y.toFixed(2)}" font-size="12" fill="black">${escapeXml(note.text)}</text>\n`;
  }

  svg += '</svg>';
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
