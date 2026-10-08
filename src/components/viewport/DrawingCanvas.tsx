import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import {
  projectBodies,
  exportDrawingSVG,
  viewTransform,
  clipViewToCircle,
  clipSegmentToCircle,
  dimensionSheetGeometry,
  formatDimValue,
  formatViewScaleRatio,
  calloutSheetGeometry,
  CENTER_MARK_ARM_RATIO,
  CUT_PLANE_DASH,
  cutPlaneSheetTrace,
  sectionCutInfo,
  titleBlockLayout,
  SHEET_SCALE_NONE,
  SHEET_SCALE_VARIES,
  type DrawingView,
  type DrawingDimension,
  type DrawingViewKey,
  type SectionCutInfo,
  type SectionPlane,
  type SheetTitleBlock,
  type ViewTransform,
} from '../../lib/io/drawing';
import { collectHoleCallouts, type CalloutViewFrame, type HoleCallout } from '../../lib/io/drawingCallouts';
import type { HoleFeature } from '../../lib/features/types';
import {
  DETAIL_RADIUS_MM,
  DETAIL_SCALE,
  detailPointToSheet,
  layoutDetailPanels,
  makeDetailId,
  makeNoteId,
  type DetailPanel,
  type DrawingDetail,
  type DrawingNote,
} from '../../lib/io/drawingNotes';
import { downloadFile } from '../../lib/io/studio3d';
import { exportSheetDXF } from '../../lib/io/dxf';
import { exportCanvasAsPDF } from '../../lib/io/pdf';
import { showToast } from '../../lib/toast';
import { useDprChange } from '../../lib/hooks/useDprChange';
import { canvasBackingSize, clampedDpr, shouldApplyResize } from '../../lib/render/canvasMetrics';
import { Download, Eye, StickyNote, X, ZoomIn } from 'lucide-react';

type SectionAxis = 'off' | 'x' | 'y' | 'z';

/** Base sheet: a fixed 2×2 grid of views (sheet px; the canvas backs the
 *  container at CSS×DPR and scales this logical system onto it). */
const SHEET_W = 800;
const SHEET_H = 600;
const GRID_COLS = 2;
const CELL_W = SHEET_W / GRID_COLS;
const CELL_H = SHEET_H / GRID_COLS;
const PAD = 40;

/** Model→view scale the sheet projects at (view units = model mm × this). */
const PROJECTION_SCALE = 50;

/** The 2×2 grid's view frames (dir = toward the viewer, up = sheet-up). */
const VIEW_FRAMES: { name: string; frame: CalloutViewFrame }[] = [
  { name: 'Front', frame: { dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, scale: PROJECTION_SCALE } },
  { name: 'Top', frame: { dir: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 }, scale: PROJECTION_SCALE } },
  { name: 'Right', frame: { dir: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, scale: PROJECTION_SCALE } },
  { name: 'Iso', frame: { dir: { x: 0.577, y: 0.577, z: 0.577 }, up: { x: 0, y: 1, z: 0 }, scale: PROJECTION_SCALE } },
];

/** View keys in grid order — the store's drawingViewPlacements join key. */
const VIEW_KEYS: readonly DrawingViewKey[] = ['front', 'top', 'right', 'iso'];

/** Hit margin around a view's projected bounds (sheet px). */
const VIEW_HIT_MARGIN_PX = 6;
/** Pointer travel (sheet px) before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;

/**
 * A placed view: the view plus its grid cell, its model↔sheet transform and
 * the resolved store placement driving it (B6+B8). `offsetX/offsetY` are the
 * COMMITTED store offsets — an in-progress drag adds its live delta on top
 * inside `transform` only (one store write, one undo entry, on release).
 */
interface ViewPlacement {
  cellX: number;
  cellY: number;
  transform: ViewTransform;
  /** Store placement id (updateDrawingViewPlacement target). */
  id: string;
  visible: boolean;
  offsetX: number;
  offsetY: number;
  /** Store scaleOverride (px per model mm); null = auto-fit. */
  scaleOverride: number | null;
  /** Effective sheet px per model mm (transform.scale × PROJECTION_SCALE). */
  pxPerMm: number;
}

/** An in-progress view drag: live delta applied until pointer-up. */
interface ViewDragState {
  viewIndex: number;
  id: string;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  dx: number;
  dy: number;
  moved: boolean;
}

export function DrawingCanvas() {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The sheet's scrollable wrapper (owning the canvas's CSS size).
  const sheetWrapperRef = useRef<HTMLDivElement>(null);
  // Container CSS size + DPR the backing store was last sized for (null until
  // the resize observer reports — the JSX width/height attributes are the
  // pre-observer fallback). Investigated: the sheet previously rasterized at
  // a FIXED 800×600 attribute size stretched by CSS — container resizes and
  // DPR changes were both ignored.
  const [backingSize, setBackingSize] = useState<{ cssW: number; cssH: number; dpr: number } | null>(null);
  const bodies = useStore((s) => s.bodies);
  const drawingDetails = useStore((s) => s.drawingDetails);
  const drawingNotes = useStore((s) => s.drawingNotes);
  // Stored per-view placements (B6+B8): drag offsets, visibility, scale
  // overrides — undoable and serialized with the project (drawingDetails
  // keeps its own strip for detail views; they follow their base view).
  const drawingViewPlacements = useStore((s) => s.drawingViewPlacements);
  // Store-driven (undoable + serialized with the project).
  const sectionAxis = useStore((s) => s.drawingSectionAxis);
  const setSectionAxis = useStore((s) => s.setDrawingSectionAxis);
  // Editable-dimension hit targets (canvas px) recorded during the last paint.
  const dimHitsRef = useRef<{ id: string; x: number; y: number; dim: DrawingDimension }[]>([]);
  // Note hit targets (text box + the hover ×) recorded during the last paint.
  const noteHitsRef = useRef<{ id: string; x: number; y: number; w: number }[]>([]);
  const [hoverHit, setHoverHit] = useState<string | null>(null);
  const [hoverNoteId, setHoverNoteId] = useState<string | null>(null);
  // Hovered base view (index into VIEW_FRAMES) driving the per-view mini
  // toolbar (scale control + remove); null when over none.
  const [hoverView, setHoverView] = useState<number | null>(null);
  // In-progress view drag (B6+B8): the live delta rides the transform only;
  // the store is written ONCE on release (the drag-move precedent). The ref
  // is the truth (continuous mousemove events can outpace re-renders); the
  // state is what repaints the sheet.
  const [dragState, setDragState] = useState<ViewDragState | null>(null);
  const dragRef = useRef<ViewDragState | null>(null);
  const setDrag = (next: ViewDragState | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  // A drag that moved suppresses the click event that follows its mouseup.
  const suppressClickRef = useRef(false);
  // The mini toolbar's scale input (uncontrolled; committed on Enter/blur).
  const scaleInputRef = useRef<HTMLInputElement>(null);
  // Armed placement tools (one-shot: disarmed after each placement).
  const [detailArmed, setDetailArmed] = useState(false);
  const [noteArmed, setNoteArmed] = useState(false);
  // In-progress note text edit (inline input, BrowserTree-rename style).
  const [editingNote, setEditingNote] = useState<{ id: string; value: string } | null>(null);

  // Section plane: cuts the bodies in half at the middle of their combined
  // bounds along the chosen axis, removing the positive side (SolidWorks
  // "Section View" on a mid plane).
  const section: SectionPlane | undefined = useMemo(() => {
    if (sectionAxis === 'off' || bodies.length === 0) return undefined;
    let min = Infinity;
    let max = -Infinity;
    for (const b of bodies) {
      for (const v of b.vertices) {
        const c = sectionAxis === 'x' ? v.x : sectionAxis === 'y' ? v.y : v.z;
        min = Math.min(min, c);
        max = Math.max(max, c);
      }
    }
    const normal =
      sectionAxis === 'x' ? { x: 1, y: 0, z: 0 } : sectionAxis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    return { normal, offset: (min + max) / 2 };
  }, [sectionAxis, bodies]);

  const views = useMemo(() => {
    if (bodies.length === 0) return [];
    // Section-labeled views carry the pre-seeded SECTION A-A title as a
    // suffix (`Front — SECTION A-A`): every grid view is sectioned here, so
    // keeping the base name preserves view identity — the plain-title
    // variant would lose it.
    const suffix = sectionAxis === 'off' ? '' : ` — ${t('drawing.sectionTitle')}`;
    return VIEW_FRAMES.map(({ name, frame }) =>
      projectBodies(bodies, frame.dir, frame.up, frame.scale, `${name}${suffix}`, section),
    );
  }, [bodies, section, sectionAxis, t]);

  // Cutting-plane annotations (B10): one trace per axis-on PARENT view the
  // section axis cuts (front/top/right per the axis). The view looking along
  // the axis IS the section view and gets no trace; iso frames are skipped.
  const cutLabel = t('drawing.cutPlaneLabel');
  const sectionCuts = useMemo<SectionCutInfo[]>(() => {
    if (sectionAxis === 'off' || !section) return [];
    const out: SectionCutInfo[] = [];
    VIEW_FRAMES.forEach(({ frame }, i) => {
      const cut = sectionCutInfo(i, frame, { axis: sectionAxis, offset: section.offset }, cutLabel);
      if (cut) out.push(cut);
    });
    return out;
  }, [section, sectionAxis, cutLabel]);

  // Hole callouts are auto-derived from the feature tree (no store state of
  // their own): every unsuppressed HoleFeature gets a leader on each axis-on
  // view. The tree mutates in place, so featureVersion is the change signal
  // (the same pattern ParametersPanel uses).
  const featureVersion = useStore((s) => s.featureVersion);
  const thruWord = t('drawing.thru');
  const holeCallouts = useMemo<HoleCallout[]>(() => {
    const holes = useStore
      .getState()
      .featureTree.features.filter((f): f is HoleFeature => f.type === 'hole' && !f.suppressed);
    if (holes.length === 0) return [];
    return collectHoleCallouts(
      holes,
      VIEW_FRAMES.map((v) => v.frame),
      section,
      thruWord,
    );
    // featureVersion is the intentional change signal for the in-place-mutated
    // feature tree (the linter can't see it through getState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureVersion, section, thruWord]);

  // Grid placements of the base views (shared by painting and click
  // handling). Each resolves its stored placement (B6+B8): scaleOverride is
  // px per model mm, so the view-unit scale the transform needs is
  // scaleOverride / PROJECTION_SCALE (view units = mm × 50); hidden views
  // keep a valid transform (detail placement reads toModel) but paint
  // nothing. An in-progress drag adds its live delta to the transform only.
  const placements = useMemo(
    () =>
      views.map((view, i): ViewPlacement => {
        const cellX = (i % GRID_COLS) * CELL_W;
        const cellY = Math.floor(i / GRID_COLS) * CELL_H;
        const sp = drawingViewPlacements.find((p) => p.viewKey === VIEW_KEYS[i]);
        const dragging = dragState?.viewIndex === i;
        const offsetX = (sp?.offsetX ?? 0) + (dragging ? dragState.dx : 0);
        const offsetY = (sp?.offsetY ?? 0) + (dragging ? dragState.dy : 0);
        const scaleOverride = sp?.scaleOverride ?? null;
        const transform = viewTransform(view, { x: cellX, y: cellY, w: CELL_W, h: CELL_H }, PAD, {
          viewKey: VIEW_KEYS[i],
          offsetX,
          offsetY,
          scale: scaleOverride == null ? null : scaleOverride / PROJECTION_SCALE,
        });
        return {
          cellX,
          cellY,
          transform,
          id: sp?.id ?? VIEW_KEYS[i]!,
          visible: sp?.visible !== false,
          offsetX: sp?.offsetX ?? 0,
          offsetY: sp?.offsetY ?? 0,
          scaleOverride,
          pxPerMm: transform.scale * PROJECTION_SCALE,
        };
      }),
    [views, drawingViewPlacements, dragState],
  );

  // Each visible view's projected bounding box on the sheet (drag target +
  // mini-toolbar anchor). Later views win overlaps (they paint on top).
  const viewBoxes = useMemo(
    () =>
      views.map((view, i) => {
        const t = placements[i]!.transform;
        const c1 = t.toSheet({ x: view.bounds.min.x, y: view.bounds.min.y });
        const c2 = t.toSheet({ x: view.bounds.max.x, y: view.bounds.max.y });
        const m = VIEW_HIT_MARGIN_PX;
        return {
          minX: Math.min(c1.x, c2.x) - m,
          maxX: Math.max(c1.x, c2.x) + m,
          minY: Math.min(c1.y, c2.y) - m,
          maxY: Math.max(c1.y, c2.y) + m,
        };
      }),
    [views, placements],
  );

  // Detail panels: appended after the iso view in a strip below the base
  // sheet (the sheet grows to fit them). A HIDDEN base view hides its
  // details too (B6+B8): sourceScale 0 drops them from the layout exactly
  // like a stale viewIndex — the detail is positionally linked to its base
  // view, so it cannot outlive it on the sheet.
  const detailLayout = useMemo(() => {
    const inputs = drawingDetails.map((d) => {
      const p = placements[d.viewIndex];
      return { scale: d.scale, radius: d.radius, sourceScale: p && p.visible ? p.transform.scale : 0 };
    });
    return layoutDetailPanels(inputs, SHEET_W, SHEET_H, CELL_W, CELL_H);
  }, [drawingDetails, placements]);
  const sheetHeight = SHEET_H + detailLayout.stripHeight;

  /**
   * Title-block fields for the painted sheet and the SVG/DXF exports — one
   * source so the exports match what is on screen (B7 parity). projectName
   * is read fresh from the store (not a subscription) exactly like the old
   * inline paint code did.
   *
   * The scale field is HONEST since B6+B8: when every visible view is drawn
   * at one scale (auto-fit agreement or matching overrides) that ratio is
   * printed; otherwise VARIES (each view discloses its own ratio in the
   * caption under its title); no visible views print an em dash. The old
   * blanket "Auto (fit)" hid four different scales.
   */
  const buildTitleBlock = useCallback((): SheetTitleBlock => {
    const scales = placements.filter((p) => p.visible).map((p) => p.pxPerMm);
    const distinct = scales.filter((v, i) => scales.findIndex((u) => Math.abs(u - v) < 1e-9) === i);
    const scaleValue =
      distinct.length === 1
        ? formatViewScaleRatio(distinct[0]!)
        : distinct.length === 0
          ? SHEET_SCALE_NONE
          : SHEET_SCALE_VARIES;
    return {
      title: t('drawing.title'),
      projectName: useStore.getState().projectName || 'Untitled',
      scaleLabel: t('drawing.scale'),
      scaleValue,
      dateLabel: t('drawing.date'),
      dateValue: new Date().toLocaleDateString(),
      unitsLabel: t('drawing.units'),
      unitsValue: 'mm',
      version: `SceneLab v${__APP_VERSION__}`,
    };
  }, [t, placements]);

  /** Track the sheet wrapper's CSS size and the DPR for the backing store.
   * Deduped so ResizeObserver's per-frame firing during panel drags doesn't
   * churn state (the paint path reallocates the canvas on every change). */
  const applyBackingSize = useCallback(() => {
    const wrapper = sheetWrapperRef.current;
    if (!wrapper) return;
    // A zero client box means "not laid out / hidden" (always so under jsdom):
    // keep the attribute-size fallback until the observer reports a real size.
    if (wrapper.clientWidth <= 0 || wrapper.clientHeight <= 0) return;
    const next = { cssW: wrapper.clientWidth, cssH: wrapper.clientHeight, dpr: clampedDpr(window.devicePixelRatio) };
    setBackingSize((prev) =>
      prev && !shouldApplyResize(
        { w: prev.cssW, h: prev.cssH, dpr: prev.dpr },
        { w: next.cssW, h: next.cssH, dpr: next.dpr },
      ) ? prev : next,
    );
  }, []);
  const hasBodies = bodies.length > 0;
  useEffect(() => {
    if (!hasBodies) return; // no sheet wrapper is mounted without bodies
    applyBackingSize();
    // jsdom lacks ResizeObserver; the DPR hook below still covers ratio flips.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(applyBackingSize);
    ro.observe(sheetWrapperRef.current!);
    return () => ro.disconnect();
  }, [hasBodies, applyBackingSize]);
  // Cross-monitor drag / browser zoom keeps the CSS size — catch the ratio.
  useDprChange(applyBackingSize);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || views.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size the backing store to the container (CSS × clamped DPR) and scale
    // the context so every coordinate below stays in SHEET_* units — the
    // geometry, hit targets and exporters are all sheet-space. Sizing clears
    // the canvas, which is fine: this effect IS the repaint. Until the
    // observer reports (first paint), draw into the attribute-sized canvas
    // with an identity transform (the old fixed-size behaviour).
    if (backingSize) {
      const backing = canvasBackingSize(backingSize.cssW, backingSize.cssH, backingSize.dpr);
      if (canvas.width !== backing.width) canvas.width = backing.width;
      if (canvas.height !== backing.height) canvas.height = backing.height;
      ctx.setTransform(backing.width / SHEET_W, 0, 0, backing.height / sheetHeight, 0, 0);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const dimHits: typeof dimHitsRef.current = [];
    const noteHits: typeof noteHitsRef.current = [];

    const w = SHEET_W;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, sheetHeight);

    ctx.font = '12px sans-serif';

    for (let i = 0; i < views.length; i++) {
      const view = views[i]!;
      const placement = placements[i]!;
      // Hidden views (B6+B8) paint nothing — no title, geometry or
      // annotations (their hit targets are skipped too, so nothing is
      // editable or draggable through them).
      if (!placement.visible) continue;
      const { cellX, cellY, transform } = placement;
      const ox = cellX;
      const oy = cellY;

      // Hovered/dragged affordance (B6+B8): a light dashed box around the
      // view's projected bounds marks the drag target.
      if (hoverView === i || dragState?.viewIndex === i) {
        const b = viewBoxes[i]!;
        ctx.save();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        ctx.restore();
      }

      // Title
      ctx.fillStyle = 'black';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(view.name, ox + CELL_W / 2, oy + 20);

      // Honest per-view scale caption (B6+B8): every view discloses the
      // scale it is drawn at — auto-fit included (same string the SVG
      // exporter writes via view.placement.scaleLabel).
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#333';
      ctx.textAlign = 'center';
      ctx.fillText(formatViewScaleRatio(placement.pxPerMm), ox + CELL_W / 2, oy + 34);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'black';
      ctx.font = '12px sans-serif';

      // Draw lines
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      for (const line of view.lines) {
        const p1 = transform.toSheet(line.start);
        const p2 = transform.toSheet(line.end);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // Arcs detected among the lines (open constant-curvature chains, e.g.
      // sectioned cylinder caps): drawn as true arcs on the sheet. View +y
      // maps to sheet −y, so angles negate and the sweep direction flips —
      // CCW-in-view reads as canvas anticlockwise.
      for (const arc of view.arcs) {
        const c = transform.toSheet(arc.center);
        ctx.beginPath();
        ctx.arc(c.x, c.y, arc.radius * transform.scale, -arc.startAngle, -arc.endAngle, arc.ccw !== false);
        ctx.stroke();
      }

      // Center marks over detected circles: thin ASME crosses, arms 1.25×r.
      // Always on (no toggle) — annotation, not geometry.
      ctx.lineWidth = 0.5;
      for (const m of view.centers ?? []) {
        const c = transform.toSheet(m);
        const arm = m.radius * transform.scale * CENTER_MARK_ARM_RATIO;
        ctx.beginPath();
        ctx.moveTo(c.x - arm, c.y);
        ctx.lineTo(c.x + arm, c.y);
        ctx.moveTo(c.x, c.y - arm);
        ctx.lineTo(c.x, c.y + arm);
        ctx.stroke();
      }
      ctx.lineWidth = 1;

      // Section cut faces: hatched fill (45°, drafting convention).
      if (view.sectionFaces && view.sectionFaces.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 0.5;
        for (const face of view.sectionFaces) {
          const pts = face.map((p) => transform.toSheet(p));
          if (pts.length < 3) continue;
          ctx.beginPath();
          ctx.moveTo(pts[0]!.x, pts[0]!.y);
          for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k]!.x, pts[k]!.y);
          ctx.closePath();
          ctx.stroke();
          ctx.save();
          ctx.clip();
          // Hatch: 45° lines spaced 6 px, clipped to the face polygon above.
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          const height = maxY - minY;
          ctx.beginPath();
          for (let c = minX - height; c < maxX; c += 6) {
            ctx.moveTo(c, minY);
            ctx.lineTo(c + height, maxY);
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }

      // Draw dimensions; editable ones (with a driver) highlight on hover and
      // open the edit prompt on click. The dimension line sits a fixed
      // sheet-px offset from the measured geometry (dimensionSheetGeometry) —
      // auto-fit can no longer collapse the gap onto the outline.
      ctx.font = '10px sans-serif';
      for (let d = 0; d < view.dimensions.length; d++) {
        const dim = view.dimensions[d]!;
        const g = dimensionSheetGeometry(dim, transform.toSheet);
        const hitId = `${i}:${d}`;
        const hovered = dim.driver && hoverHit === hitId;
        const color = hovered ? '#3b82f6' : 'red';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(g.dim.start.x, g.dim.start.y);
        ctx.lineTo(g.dim.end.x, g.dim.end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const e of g.ext) {
          ctx.beginPath();
          ctx.moveTo(e.start.x, e.start.y);
          ctx.lineTo(e.end.x, e.end.y);
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        if (hovered) ctx.font = 'bold 11px sans-serif';
        ctx.fillText(formatDimValue(dim.value), g.text.x, g.text.y);
        if (hovered) ctx.font = '10px sans-serif';
        dimHits.push({ id: hitId, x: g.text.x, y: g.text.y, dim });
      }

      // Hole callouts on axis-on views: leader (rim → 45° elbow → shelf) +
      // localized GD&T text. Auto-derived from the feature tree above.
      const callouts = holeCallouts.filter((c) => c.viewIndex === i);
      if (callouts.length > 0) {
        ctx.strokeStyle = '#333';
        ctx.fillStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.textAlign = 'left';
        for (const c of callouts) {
          const cs = transform.toSheet(c.center);
          const g = calloutSheetGeometry(cs, c.radius * transform.scale);
          ctx.beginPath();
          ctx.moveTo(g.leader[0]!.x, g.leader[0]!.y);
          ctx.lineTo(g.leader[1]!.x, g.leader[1]!.y);
          ctx.lineTo(g.leader[2]!.x, g.leader[2]!.y);
          ctx.stroke();
          ctx.fillText(c.text, g.text.x, g.text.y);
        }
        ctx.lineWidth = 1;
      }

      // Cutting-plane trace (B10): phantom chain across the parent view with
      // view-direction arrows and the cut letter at both ends. Geometry is
      // shared with the SVG/DXF exporters (cutPlaneSheetTrace).
      for (const cut of sectionCuts) {
        if (cut.viewIndex !== i) continue;
        const trace = cutPlaneSheetTrace(view, transform.toSheet, cut);
        if (!trace) continue;
        ctx.strokeStyle = 'black';
        ctx.fillStyle = 'black';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([...CUT_PLANE_DASH]);
        ctx.beginPath();
        ctx.moveTo(trace.line.start.x, trace.line.start.y);
        ctx.lineTo(trace.line.end.x, trace.line.end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const a of trace.arrows) {
          ctx.beginPath();
          ctx.moveTo(a.tip.x, a.tip.y);
          ctx.lineTo(a.base1.x, a.base1.y);
          ctx.lineTo(a.base2.x, a.base2.y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        for (const l of trace.labels) ctx.fillText(cut.label, l.x, l.y);
      }
      ctx.lineWidth = 1;
      ctx.textAlign = 'left';
    }

    // Grid lines between views (base sheet only)
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(CELL_W, 0);
    ctx.lineTo(CELL_W, SHEET_H);
    ctx.moveTo(0, CELL_H);
    ctx.lineTo(SHEET_W, CELL_H);
    ctx.stroke();

    // Detail views: a thin source circle on the parent view (Fusion
    // convention) plus a magnified, circular-border panel in the strip.
    for (const panel of detailLayout.panels) {
      const detail = drawingDetails[panel.detailIndex]!;
      const source = placements[detail.viewIndex]!;

      const srcC = source.transform.toSheet(detail.center);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.arc(srcC.x, srcC.y, detail.radius * source.transform.scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Border circle + clipped geometry at the magnified scale.
      ctx.save();
      ctx.beginPath();
      ctx.arc(panel.cx, panel.cy, panel.rPx, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'black';
      ctx.stroke();
      ctx.clip();
      ctx.lineWidth = 1;
      const crop = { center: detail.center, radius: detail.radius };
      for (const line of clipViewToCircle(views[detail.viewIndex]!, crop)) {
        const p1 = detailPointToSheet(line.start, detail.center, panel);
        const p2 = detailPointToSheet(line.end, detail.center, panel);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      // Center marks inside the crop circle, arms clipped to it.
      ctx.lineWidth = 0.5;
      for (const m of views[detail.viewIndex]!.centers ?? []) {
        const arm = m.radius * CENTER_MARK_ARM_RATIO;
        if (Math.hypot(m.x - crop.center.x, m.y - crop.center.y) - arm > crop.radius) continue;
        for (const seg of [
          clipSegmentToCircle({ x: m.x - arm, y: m.y }, { x: m.x + arm, y: m.y }, crop),
          clipSegmentToCircle({ x: m.x, y: m.y - arm }, { x: m.x, y: m.y + arm }, crop),
        ]) {
          if (!seg) continue;
          const p1 = detailPointToSheet(seg.start, detail.center, panel);
          const p2 = detailPointToSheet(seg.end, detail.center, panel);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
      ctx.restore();

      ctx.fillStyle = 'black';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(panel.title, panel.cx, panel.cy + panel.rPx + 16);
    }

    // Notes: plain sheet-space text (survives the CSS stretch because it uses
    // the same logical coords as the dimension hit-testing). The note being
    // edited is drawn by the inline input instead.
    ctx.textAlign = 'left';
    for (const note of drawingNotes) {
      if (!note.text || editingNote?.id === note.id) continue;
      ctx.font = '12px sans-serif';
      const textW = ctx.measureText(note.text).width;
      ctx.fillStyle = hoverNoteId === note.id ? '#1d4ed8' : 'black';
      ctx.fillText(note.text, note.x, note.y);
      if (hoverNoteId === note.id) {
        // Small × affordance right of the text (click or right-click deletes).
        ctx.fillStyle = '#dc2626';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText('×', note.x + textW + 8, note.y - 1);
      }
      noteHits.push({ id: note.id, x: note.x, y: note.y, w: textW });
    }

    // Title block (bottom-right corner, SolidWorks style). Shared layout
    // with the SVG/DXF exporters (B7 parity — the exports draw this too).
    const tb = titleBlockLayout(buildTitleBlock(), w, sheetHeight);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(tb.rect.x, tb.rect.y, tb.rect.w, tb.rect.h);
    ctx.beginPath();
    ctx.moveTo(tb.dividerH.start.x, tb.dividerH.start.y);
    ctx.lineTo(tb.dividerH.end.x, tb.dividerH.end.y);
    ctx.moveTo(tb.dividerV.start.x, tb.dividerV.start.y);
    ctx.lineTo(tb.dividerV.end.x, tb.dividerV.end.y);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    for (const field of tb.fields) {
      ctx.font = `${field.bold ? 'bold ' : ''}${field.size}px sans-serif`;
      ctx.fillText(field.text, field.x, field.y);
    }

    dimHitsRef.current = dimHits;
    noteHitsRef.current = noteHits;
  }, [views, placements, viewBoxes, detailLayout, drawingDetails, drawingNotes, holeCallouts, sectionCuts, sheetHeight, hoverHit, hoverNoteId, hoverView, dragState, editingNote, buildTitleBlock, t, backingSize]);

  /** Client event → sheet coordinates. Maps through the bounding rect to the
   * SHEET_* logical system (NOT the backing store — that is CSS × DPR physical
   * px now). Multiply before dividing: (x/w)*w round-trips through a
   * non-representable fraction and loses ~1e-14 px, which accumulates into
   * drag offsets. */
  const toCanvasCoords = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * SHEET_W) / rect.width,
      y: ((e.clientY - rect.top) * sheetHeight) / rect.height,
    };
  };

  /** Nearest editable dimension within the click/hover radius, if any. */
  const hitTest = (x: number, y: number) => {
    let best: { id: string; dim: DrawingDimension; dist: number } | null = null;
    for (const hit of dimHitsRef.current) {
      if (!hit.dim.driver) continue;
      const dist = Math.hypot(hit.x - x, hit.y - y);
      if (dist <= 14 && (!best || dist < best.dist)) best = { id: hit.id, dim: hit.dim, dist };
    }
    return best;
  };

  /** Note under a sheet point: its text box or the hover × (onX). */
  const hitTestNote = (x: number, y: number): { id: string; onX: boolean } | null => {
    for (const hit of noteHitsRef.current) {
      if (x >= hit.x + hit.w + 4 && x <= hit.x + hit.w + 18 && y >= hit.y - 14 && y <= hit.y + 4) {
        return { id: hit.id, onX: true };
      }
      if (x >= hit.x - 2 && x <= hit.x + hit.w + 2 && y >= hit.y - 12 && y <= hit.y + 3) {
        return { id: hit.id, onX: false };
      }
    }
    return null;
  };

  /** Detail panel under a sheet point (inside its border circle), if any. */
  const hitTestDetailPanel = (x: number, y: number): { panel: DetailPanel; detail: DrawingDetail } | null => {
    for (const panel of detailLayout.panels) {
      if (Math.hypot(x - panel.cx, y - panel.cy) <= panel.rPx) {
        const detail = drawingDetails[panel.detailIndex];
        if (detail) return { panel, detail };
      }
    }
    return null;
  };

  /** Visible base view whose projected bounds contain the point, if any
   * (later views win overlaps — they paint on top). */
  const hitTestView = (x: number, y: number): number | null => {
    for (let i = views.length - 1; i >= 0; i--) {
      if (!placements[i]!.visible) continue;
      const b = viewBoxes[i]!;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return i;
    }
    return null;
  };

  /**
   * Commit an in-progress view drag: ONE store write (one undo entry) on
   * release — the drag-move precedent. Presses that never crossed the
   * threshold are plain clicks and commit nothing.
   */
  const finishViewDrag = (d: ViewDragState | null) => {
    if (!d) return;
    if (d.moved) {
      suppressClickRef.current = true; // the mouseup's click event must not edit a dim
      useStore.getState().updateDrawingViewPlacement(d.id, {
        offsetX: d.baseX + d.dx,
        offsetY: d.baseY + d.dy,
      });
    }
  };

  const handleWrapperMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Over the mini toolbar / note editor: keep the current hover states —
    // unmounting the toolbar mid-approach would make it unclickable.
    if (e.target !== canvasRef.current) return;
    const p = toCanvasCoords(e);
    if (!p) return;
    const drag = dragRef.current;
    if (drag) {
      // Button released outside the window: finalize instead of sticking.
      if (e.buttons === 0) {
        finishViewDrag(drag);
        setDrag(null);
        return;
      }
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      const next: ViewDragState = {
        ...drag,
        dx,
        dy,
        moved: drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX,
      };
      setDrag(next);
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
      return;
    }
    if (detailArmed || noteArmed) {
      setHoverHit(null);
      setHoverNoteId(null);
      setHoverView(null);
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      return;
    }
    const note = hitTestNote(p.x, p.y);
    setHoverNoteId(note ? note.id : null);
    const hit = note ? null : hitTest(p.x, p.y);
    setHoverHit(hit ? hit.id : null);
    const hv = note || hit ? null : hitTestView(p.x, p.y);
    setHoverView(hv);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = note || hit ? 'pointer' : hv !== null ? 'move' : 'default';
    }
  };

  /** Press on a visible view's bounds arms a drag (clicks on notes never do). */
  const handleWrapperDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    suppressClickRef.current = false; // a stale suppression never eats a real click
    if (e.target !== canvasRef.current) return; // toolbar/input presses never drag
    if (detailArmed || noteArmed || dragRef.current) return;
    if (e.button !== 0) return;
    const p = toCanvasCoords(e);
    if (!p) return;
    if (hitTestNote(p.x, p.y)) return;
    const i = hitTestView(p.x, p.y);
    if (i === null) return;
    const placement = placements[i]!;
    setDrag({
      viewIndex: i,
      id: placement.id,
      startX: p.x,
      startY: p.y,
      baseX: placement.offsetX,
      baseY: placement.offsetY,
      dx: 0,
      dy: 0,
      moved: false,
    });
  };

  const handleWrapperUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    finishViewDrag(drag);
    setDrag(null);
  };

  const handleWrapperLeave = () => {
    setHoverHit(null);
    setHoverNoteId(null);
    setHoverView(null);
    // An in-flight drag is NOT cancelled here: the button is still down and
    // the pointer may re-enter; a release outside is caught by the
    // buttons === 0 check on the next move.
  };

  /** Commit the mini toolbar's scale input: a positive number sets the
   * override (px per model mm); empty/invalid clears it back to auto-fit. */
  const commitScaleInput = (viewIndex: number) => {
    const el = scaleInputRef.current;
    const placement = placements[viewIndex];
    if (!el || !placement) return;
    const raw = el.value.trim();
    const v = Number(raw);
    const parsed = raw !== '' && Number.isFinite(v) && v > 0 ? v : null;
    if (parsed === (placement.scaleOverride ?? null)) return; // no no-op undo entries
    useStore.getState().updateDrawingViewPlacement(placement.id, { scaleOverride: parsed });
  };

  const handleCanvasClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    // The click that ends a moved drag is not an edit click.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const p = toCanvasCoords(e);
    if (!p) return;
    const store = useStore.getState();

    // Armed note tool: place an empty note and edit it immediately.
    if (noteArmed) {
      const note: DrawingNote = { id: makeNoteId(), x: p.x, y: p.y, text: '' };
      store.addDrawingNote(note);
      setNoteArmed(false);
      setEditingNote({ id: note.id, value: '' });
      return;
    }

    // Armed detail tool: crop the clicked view cell around the click point.
    // Hidden views take no details (B6+B8) — a detail cannot anchor to a
    // base view that is not on the sheet.
    if (detailArmed) {
      const col = p.x < CELL_W ? 0 : 1;
      const row = p.y < CELL_H ? 0 : 1;
      const viewIndex = row * GRID_COLS + col;
      if (p.y <= SHEET_H && viewIndex < views.length && placements[viewIndex]!.visible) {
        const center = placements[viewIndex]!.transform.toModel(p);
        const detail: DrawingDetail = {
          id: makeDetailId(),
          viewIndex,
          center,
          radius: DETAIL_RADIUS_MM,
          scale: DETAIL_SCALE,
        };
        store.addDrawingDetail(detail);
      }
      setDetailArmed(false);
      return;
    }

    // Hover × on a note deletes it.
    const note = hitTestNote(p.x, p.y);
    if (note?.onX) {
      store.removeDrawingNote(note.id);
      return;
    }

    // Otherwise: editable dimensions.
    const hit = hitTest(p.x, p.y);
    const driver = hit?.dim.driver;
    if (!hit || !driver) return;
    useStore.getState().openNumericPrompt({
      titleKey: 'drawing.dimTitle',
      labelKey: 'drawing.dimLabel',
      initial: Math.round(hit.dim.value * 1000) / 1000,
      min: 0.1,
      step: 0.5,
      onApply: (v) => {
        if (!useStore.getState().setDimensionTarget(driver, v)) {
          showToast(t('drawing.editFailed'), 'warning');
        }
      },
    });
  };

  /** Double-click a note to edit its text (BrowserTree-rename style input). */
  const handleCanvasDblClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = toCanvasCoords(e);
    if (!p) return;
    const note = hitTestNote(p.x, p.y);
    if (!note) return;
    const existing = useStore.getState().drawingNotes.find((n) => n.id === note.id);
    if (existing) setEditingNote({ id: note.id, value: existing.text });
  };

  /** Right-click: delete a note, or delete a detail view on its panel. */
  const handleCanvasContextMenu = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = toCanvasCoords(e);
    if (!p) return;
    const store = useStore.getState();
    const note = hitTestNote(p.x, p.y);
    if (note) {
      e.preventDefault();
      store.removeDrawingNote(note.id);
      return;
    }
    const panel = hitTestDetailPanel(p.x, p.y);
    if (panel) {
      e.preventDefault();
      store.removeDrawingDetail(panel.detail.id);
    }
  };

  const commitNoteEdit = () => {
    if (!editingNote) return;
    const { id, value } = editingNote;
    const text = value.trim();
    const existing = useStore.getState().drawingNotes.find((n) => n.id === id);
    setEditingNote(null);
    if (!existing) return;
    if (text) useStore.getState().updateDrawingNote(id, text);
    else useStore.getState().removeDrawingNote(id); // empty notes are dropped
  };

  const cancelNoteEdit = () => {
    if (!editingNote) return;
    const existing = useStore.getState().drawingNotes.find((n) => n.id === editingNote.id);
    setEditingNote(null);
    // A just-placed note that never got text shouldn't linger as a blank.
    if (existing && existing.text === '') useStore.getState().removeDrawingNote(existing.id);
  };

  const editingNoteRecord = editingNote ? drawingNotes.find((n) => n.id === editingNote.id) : undefined;

  /**
   * The views with their sheet placements attached (B6+B8) — what the SVG
   * and DXF sheet writers consume. The attached placement is the whole
   * export contract: geometry/dims/callouts/traces move with the offsets
   * and scale (viewTransform honours it), hidden views vanish (the SVG
   * writer skips them), and the per-view ratio caption travels along. The
   * DXF writer's title block gets the same scale string via titleBlock.
   */
  const buildExportViews = useCallback(
    (): DrawingView[] =>
      views.map((view, i) => {
        const pl = placements[i]!;
        return {
          ...view,
          placement: {
            viewKey: VIEW_KEYS[i],
            visible: pl.visible,
            offsetX: pl.offsetX,
            offsetY: pl.offsetY,
            scale: pl.scaleOverride == null ? null : pl.scaleOverride / PROJECTION_SCALE,
            scaleLabel: formatViewScaleRatio(pl.pxPerMm),
          },
        };
      }),
    [views, placements],
  );

  const handleExportSVG = () => {
    if (views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const svg = exportDrawingSVG(buildExportViews(), SHEET_W, SHEET_H, {
      details: drawingDetails,
      notes: drawingNotes,
      holeCallouts,
      sectionCuts,
      titleBlock: buildTitleBlock(),
    });
    downloadFile(svg, 'drawing.svg');
    showToast(t('toast.svgExported'), 'success');
  };

  const handleExportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'drawing.png';
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('toast.pngExported'), 'success');
    }, 'image/png');
  };

  const handleExportDXF = () => {
    if (views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    // The sheet as true 2D DXF (views at sheet scale, dims/callouts/notes/
    // traces as LINE/CIRCLE/ARC/TEXT/SOLID) — not the raw-body wireframe the
    // AI/io path's exportDXF still emits. Placements ride the views: the
    // writer's viewTransform calls honour them (offsets + scale), so DXF
    // entities follow the sheet exactly.
    const dxf = exportSheetDXF(buildExportViews(), SHEET_W, SHEET_H, {
      details: drawingDetails,
      notes: drawingNotes,
      holeCallouts,
      sectionCuts,
      titleBlock: buildTitleBlock(),
    });
    downloadFile(dxf, 'drawing.dxf');
    showToast(t('toast.dxfExported'), 'success');
  };

  const handleExportPDF = () => {
    const canvas = canvasRef.current;
    if (!canvas || views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const blob = exportCanvasAsPDF(canvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${useStore.getState().projectName || 'drawing'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t('toast.pdfExported'), 'success');
  };

  if (bodies.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-text-muted text-sm">
        {t('panel.noObjects')} — {t('viewport.clickPlane')}
      </div>
    );
  }

  const toolButton = (armed: boolean) =>
    `flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
      armed ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
    }`;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-panel-border">
        <label className="text-xs text-text-secondary" htmlFor="section-axis">
          {t('drawing.section')}:
        </label>
        <select
          id="section-axis"
          value={sectionAxis}
          onChange={(e) => setSectionAxis(e.target.value as SectionAxis)}
          className="px-2 py-1 text-xs bg-surface border border-panel-border rounded text-text-primary"
        >
          <option value="off">{t('drawing.sectionOff')}</option>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
        <button
          onClick={() => {
            setDetailArmed(!detailArmed);
            setNoteArmed(false);
          }}
          className={toolButton(detailArmed)}
          aria-pressed={detailArmed}
          aria-label={t('drawing.detail')}
        >
          <ZoomIn size={14} />
          {t('drawing.detail')}
        </button>
        <button
          onClick={() => {
            setNoteArmed(!noteArmed);
            setDetailArmed(false);
          }}
          className={toolButton(noteArmed)}
          aria-pressed={noteArmed}
          aria-label={t('drawing.note')}
        >
          <StickyNote size={14} />
          {t('drawing.note')}
        </button>
        <div className="w-px h-4 bg-panel-border" aria-hidden="true" />
        <span className="text-xs text-text-muted">
          {detailArmed ? t('drawing.detailHint') : noteArmed ? t('drawing.noteHint') : t('drawing.editHint')}
        </span>
        {/* Restore entries for hidden views (B6+B8): one chip per hidden base
            view — clicking brings it back (visible=true). */}
        {drawingViewPlacements
          .filter((p) => !p.visible)
          .map((p) => {
            const i = VIEW_KEYS.indexOf(p.viewKey);
            if (i === -1) return null;
            return (
              <button
                key={p.id}
                onClick={() => useStore.getState().updateDrawingViewPlacement(p.id, { visible: true })}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
                aria-label={VIEW_FRAMES[i]!.name}
              >
                <Eye size={12} />
                {VIEW_FRAMES[i]!.name}
              </button>
            );
          })}
        <div className="w-px h-4 bg-panel-border" aria-hidden="true" />
        <button
          onClick={handleExportSVG}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
          aria-label={t('export.svg')}
        >
          <Download size={14} />
          SVG
        </button>
        <button
          onClick={handleExportPNG}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
          aria-label={t('export.png')}
        >
          <Download size={14} />
          PNG
        </button>
        <button
          onClick={handleExportDXF}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
          aria-label={t('export.dxf')}
        >
          <Download size={14} />
          DXF
        </button>
        <button
          onClick={handleExportPDF}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded"
          aria-label={t('export.pdf')}
        >
          <Download size={14} />
          PDF
        </button>
      </div>
      <div
        ref={sheetWrapperRef}
        className="flex-1 overflow-hidden relative"
        onMouseMove={handleWrapperMove}
        onMouseDown={handleWrapperDown}
        onMouseUp={handleWrapperUp}
        onMouseLeave={handleWrapperLeave}
      >
        <canvas
          ref={canvasRef}
          width={SHEET_W}
          height={sheetHeight}
          className="w-full h-full block"
          role="img"
          aria-label={t('drawing.viewLabel')}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDblClick}
          onContextMenu={handleCanvasContextMenu}
        />
        {/* Per-view mini toolbar (B6+B8): hovering a view's bounds shows its
            honest scale (ratio + exact px/mm in the tooltip), a numeric
            field to set the override (empty = back to auto-fit) and the
            remove/hide button. The wrapper's hover tracking ignores moves
            over this toolbar so it stays mounted while approached. */}
        {hoverView !== null && !dragState && !detailArmed && !noteArmed && placements[hoverView]!.visible && (
          <div
            className="absolute z-10 flex items-center gap-1 px-1.5 py-0.5 rounded border border-panel-border bg-surface shadow-sm"
            style={{
              left: `${(Math.min(viewBoxes[hoverView]!.maxX, SHEET_W - 150) / SHEET_W) * 100}%`,
              top: `${(Math.max(viewBoxes[hoverView]!.minY - 24, 0) / sheetHeight) * 100}%`,
            }}
          >
            <span
              className="text-[10px] text-text-muted whitespace-nowrap"
              title={`${formatViewScaleRatio(placements[hoverView]!.pxPerMm)} (${placements[hoverView]!.pxPerMm.toFixed(3)} px/mm)`}
            >
              {formatViewScaleRatio(placements[hoverView]!.pxPerMm)}
            </span>
            <input
              ref={scaleInputRef}
              key={hoverView}
              type="number"
              step={0.1}
              min={0.05}
              defaultValue={placements[hoverView]!.scaleOverride ?? ''}
              aria-label={t('drawing.viewScale')}
              title={t('drawing.viewScale')}
              className="w-16 px-1 py-0.5 text-xs bg-white border border-panel-border rounded text-black"
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitScaleInput(hoverView);
              }}
              onBlur={() => commitScaleInput(hoverView)}
            />
            <button
              onClick={() => useStore.getState().updateDrawingViewPlacement(placements[hoverView]!.id, { visible: false })}
              className="flex items-center justify-center w-5 h-5 text-text-secondary hover:text-red-600 hover:bg-surface-hover rounded"
              aria-label={t('drawing.removeView')}
              title={t('drawing.removeView')}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {editingNote && editingNoteRecord && (
          <input
            autoFocus
            value={editingNote.value}
            onChange={(e) => setEditingNote({ id: editingNote.id, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNoteEdit();
              else if (e.key === 'Escape') cancelNoteEdit();
            }}
            onBlur={commitNoteEdit}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t('drawing.noteLabel')}
            placeholder={t('drawing.noteLabel')}
            className="absolute z-10 px-1 py-0.5 text-xs bg-white border border-accent rounded text-black shadow-sm"
            style={{
              left: `${(editingNoteRecord.x / SHEET_W) * 100}%`,
              top: `${((editingNoteRecord.y - 13) / sheetHeight) * 100}%`,
              minWidth: '120px',
            }}
          />
        )}
      </div>
    </div>
  );
}
