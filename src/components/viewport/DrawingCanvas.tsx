import { useRef, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { projectBodies, exportDrawingSVG, viewTransform, clipViewToCircle, type DrawingDimension, type SectionPlane, type ViewTransform } from '../../lib/io/drawing';
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
import { exportDXF } from '../../lib/io/dxf';
import { exportCanvasAsPDF } from '../../lib/io/pdf';
import { showToast } from '../../lib/toast';
import { Download, ZoomIn, StickyNote } from 'lucide-react';

type SectionAxis = 'off' | 'x' | 'y' | 'z';

/** Base sheet: a fixed 2×2 grid of views (canvas px; CSS-stretched on screen). */
const SHEET_W = 800;
const SHEET_H = 600;
const GRID_COLS = 2;
const CELL_W = SHEET_W / GRID_COLS;
const CELL_H = SHEET_H / GRID_COLS;
const PAD = 40;

/** A placed view: the view plus its grid cell and model↔sheet transform. */
interface ViewPlacement {
  cellX: number;
  cellY: number;
  transform: ViewTransform;
}

export function DrawingCanvas() {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodies = useStore((s) => s.bodies);
  const drawingDetails = useStore((s) => s.drawingDetails);
  const drawingNotes = useStore((s) => s.drawingNotes);
  // Store-driven (undoable + serialized with the project).
  const sectionAxis = useStore((s) => s.drawingSectionAxis);
  const setSectionAxis = useStore((s) => s.setDrawingSectionAxis);
  // Editable-dimension hit targets (canvas px) recorded during the last paint.
  const dimHitsRef = useRef<{ id: string; x: number; y: number; dim: DrawingDimension }[]>([]);
  // Note hit targets (text box + the hover ×) recorded during the last paint.
  const noteHitsRef = useRef<{ id: string; x: number; y: number; w: number }[]>([]);
  const [hoverHit, setHoverHit] = useState<string | null>(null);
  const [hoverNoteId, setHoverNoteId] = useState<string | null>(null);
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
    const suffix = sectionAxis === 'off' ? '' : ` — ${t('drawing.section')} ${sectionAxis.toUpperCase()}`;
    return [
      projectBodies(bodies, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, `Front${suffix}`, section), // Front
      projectBodies(bodies, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, `Top${suffix}`, section), // Top
      projectBodies(bodies, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, `Right${suffix}`, section), // Right
      projectBodies(bodies, { x: 0.577, y: 0.577, z: 0.577 }, { x: 0, y: 1, z: 0 }, 50, `Iso${suffix}`, section), // Iso
    ];
  }, [bodies, section, sectionAxis, t]);

  // Grid placements of the base views (shared by painting and click handling).
  const placements = useMemo(
    () =>
      views.map((_, i): ViewPlacement => {
        const cellX = (i % GRID_COLS) * CELL_W;
        const cellY = Math.floor(i / GRID_COLS) * CELL_H;
        return { cellX, cellY, transform: viewTransform(views[i]!, { x: cellX, y: cellY, w: CELL_W, h: CELL_H }, PAD) };
      }),
    [views],
  );

  // Detail panels: appended after the iso view in a strip below the base
  // sheet (the sheet grows to fit them).
  const detailLayout = useMemo(() => {
    const inputs = drawingDetails.map((d) => {
      const p = placements[d.viewIndex];
      return { scale: d.scale, radius: d.radius, sourceScale: p ? p.transform.scale : 0 };
    });
    return layoutDetailPanels(inputs, SHEET_W, SHEET_H, CELL_W, CELL_H);
  }, [drawingDetails, placements]);
  const sheetHeight = SHEET_H + detailLayout.stripHeight;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || views.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dimHits: typeof dimHitsRef.current = [];
    const noteHits: typeof noteHitsRef.current = [];

    const w = canvas.width;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, sheetHeight);

    ctx.font = '12px sans-serif';

    for (let i = 0; i < views.length; i++) {
      const view = views[i]!;
      const { cellX, cellY, transform } = placements[i]!;
      const ox = cellX;
      const oy = cellY;

      // Title
      ctx.fillStyle = 'black';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(view.name, ox + CELL_W / 2, oy + 20);

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
      // open the edit prompt on click.
      ctx.lineWidth = 0.5;
      ctx.font = '10px sans-serif';
      for (let d = 0; d < view.dimensions.length; d++) {
        const dim = view.dimensions[d]!;
        const p1 = transform.toSheet(dim.start);
        const p2 = transform.toSheet(dim.end);
        const hitId = `${i}:${d}`;
        const hovered = dim.driver && hoverHit === hitId;
        const color = hovered ? '#3b82f6' : 'red';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        ctx.textAlign = 'center';
        if (hovered) ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`${dim.value.toFixed(1)} mm`, mx, my - 4);
        if (hovered) ctx.font = '10px sans-serif';
        dimHits.push({ id: hitId, x: mx, y: my, dim });
      }
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
      for (const line of clipViewToCircle(views[detail.viewIndex]!, {
        center: detail.center,
        radius: detail.radius,
      })) {
        const p1 = detailPointToSheet(line.start, detail.center, panel);
        const p2 = detailPointToSheet(line.end, detail.center, panel);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
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

    // Title block (bottom-right corner, SolidWorks style).
    const tbW = 200, tbH = 60;
    const tbX = w - tbW - 4, tbY = sheetHeight - tbH - 4;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(tbX, tbY, tbW, tbH);
    // Horizontal divider
    ctx.beginPath();
    ctx.moveTo(tbX, tbY + tbH / 2);
    ctx.lineTo(tbX + tbW, tbY + tbH / 2);
    ctx.stroke();
    // Vertical divider
    ctx.beginPath();
    ctx.moveTo(tbX + tbW * 0.4, tbY);
    ctx.lineTo(tbX + tbW * 0.4, tbY + tbH);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(t('drawing.title'), tbX + 5, tbY + 18);
    ctx.font = '10px sans-serif';
    ctx.fillText(useStore.getState().projectName || 'Untitled', tbX + 5, tbY + 35);
    ctx.fillText(`${t('drawing.scale')}: ${t('drawing.autoScale')}`, tbX + 5, tbY + 52);
    ctx.textAlign = 'left';
    ctx.fillText(`${t('drawing.date')}: ${new Date().toLocaleDateString()}`, tbX + tbW * 0.4 + 5, tbY + 18);
    ctx.fillText(`${t('drawing.units')}: mm`, tbX + tbW * 0.4 + 5, tbY + 35);
    ctx.fillText(`SceneLab v${__APP_VERSION__}`, tbX + tbW * 0.4 + 5, tbY + 52);

    dimHitsRef.current = dimHits;
    noteHitsRef.current = noteHits;
  }, [views, placements, detailLayout, drawingDetails, drawingNotes, sheetHeight, hoverHit, hoverNoteId, editingNote, t]);

  /** Client event → sheet (canvas px) coordinates (the canvas is CSS-stretched). */
  const toCanvasCoords = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
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

  const handleCanvasMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = toCanvasCoords(e);
    if (!p) return;
    if (detailArmed || noteArmed) {
      setHoverHit(null);
      setHoverNoteId(null);
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      return;
    }
    const note = hitTestNote(p.x, p.y);
    setHoverNoteId(note ? note.id : null);
    const hit = note ? null : hitTest(p.x, p.y);
    setHoverHit(hit ? hit.id : null);
    if (canvasRef.current) canvasRef.current.style.cursor = note || hit ? 'pointer' : 'default';
  };

  const handleCanvasClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
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
    if (detailArmed) {
      const col = p.x < CELL_W ? 0 : 1;
      const row = p.y < CELL_H ? 0 : 1;
      const viewIndex = row * GRID_COLS + col;
      if (p.y <= SHEET_H && viewIndex < views.length) {
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

  const handleExportSVG = () => {
    if (views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const svg = exportDrawingSVG(views, SHEET_W, SHEET_H, { details: drawingDetails, notes: drawingNotes });
    downloadFile(svg, 'drawing.svg');
    showToast('SVG exported', 'success');
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
      showToast('PNG exported', 'success');
    }, 'image/png');
  };

  const handleExportDXF = () => {
    if (bodies.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const dxf = exportDXF(bodies);
    downloadFile(dxf, 'drawing.dxf');
    showToast('DXF exported', 'success');
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
    showToast('PDF exported', 'success');
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
      <div className="flex-1 overflow-hidden relative">
        <canvas
          ref={canvasRef}
          width={SHEET_W}
          height={sheetHeight}
          className="w-full h-full block"
          role="img"
          aria-label="Drawing view"
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDblClick}
          onContextMenu={handleCanvasContextMenu}
          onMouseMove={handleCanvasMove}
          onMouseLeave={() => {
            setHoverHit(null);
            setHoverNoteId(null);
          }}
        />
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
