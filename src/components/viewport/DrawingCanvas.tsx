import { useRef, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { projectBodies, exportDrawingSVG, type DrawingDimension, type SectionPlane } from '../../lib/io/drawing';
import { downloadFile } from '../../lib/io/studio3d';
import { exportDXF } from '../../lib/io/dxf';
import { exportCanvasAsPDF } from '../../lib/io/pdf';
import { showToast } from '../../lib/toast';
import { Download } from 'lucide-react';

type SectionAxis = 'off' | 'x' | 'y' | 'z';

export function DrawingCanvas() {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodies = useStore((s) => s.bodies);
  const [sectionAxis, setSectionAxis] = useState<SectionAxis>('off');
  // Editable-dimension hit targets (canvas px) recorded during the last paint.
  const dimHitsRef = useRef<{ id: string; x: number; y: number; dim: DrawingDimension }[]>([]);
  const [hoverHit, setHoverHit] = useState<string | null>(null);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || views.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dimHits: typeof dimHitsRef.current = [];

    const w = canvas.width;
    const h = canvas.height;
    const cols = 2;
    const rows = 2;
    const cellW = w / cols;
    const cellH = h / rows;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';

    for (let i = 0; i < views.length; i++) {
      const view = views[i]!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ox = col * cellW;
      const oy = row * cellH;

      // Title
      ctx.fillStyle = 'black';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(view.name, ox + cellW / 2, oy + 20);

      // Compute scale to fit view in cell
      const viewW = view.bounds.max.x - view.bounds.min.x;
      const viewH = view.bounds.max.y - view.bounds.min.y;
      const padding = 40;
      const scaleX = (cellW - padding * 2) / (viewW || 1);
      const scaleY = (cellH - padding * 2 - 20) / (viewH || 1);
      const scale = Math.min(scaleX, scaleY);
      const offsetX = ox + padding + (cellW - padding * 2 - viewW * scale) / 2;
      const offsetY = oy + 20 + padding + (cellH - padding * 2 - 20 - viewH * scale) / 2;

      const transform = (p: { x: number; y: number }) => ({
        x: (p.x - view.bounds.min.x) * scale + offsetX,
        y: cellH - ((p.y - view.bounds.min.y) * scale + offsetY) + oy,
      });

      // Draw lines
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      for (const line of view.lines) {
        const p1 = transform(line.start);
        const p2 = transform(line.end);
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
          const pts = face.map(transform);
          if (pts.length < 3) continue;
          ctx.beginPath();
          ctx.moveTo(pts[0]!.x, pts[0]!.y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
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
        const p1 = transform(dim.start);
        const p2 = transform(dim.end);
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

    // Grid lines between views
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cellW, 0);
    ctx.lineTo(cellW, h);
    ctx.moveTo(0, cellH);
    ctx.lineTo(w, cellH);
    ctx.stroke();

    // Title block (bottom-right corner, SolidWorks style).
    const tbW = 200, tbH = 60;
    const tbX = w - tbW - 4, tbY = h - tbH - 4;
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
  }, [views, t, hoverHit]);

  /** Client event → 800×600 canvas pixel coordinates (the canvas is CSS-stretched). */
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

  const handleCanvasMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = toCanvasCoords(e);
    const hit = p ? hitTest(p.x, p.y) : null;
    setHoverHit(hit ? hit.id : null);
    if (canvasRef.current) canvasRef.current.style.cursor = hit ? 'pointer' : 'default';
  };

  const handleCanvasClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = toCanvasCoords(e);
    if (!p) return;
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

  const handleExportSVG = () => {
    if (views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const svg = exportDrawingSVG(views, 800, 600);
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
        <div className="w-px h-4 bg-panel-border" aria-hidden="true" />
        <span className="text-xs text-text-muted">{t('drawing.editHint')}</span>
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
      <div className="flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          className="w-full h-full"
          role="img"
          aria-label="Drawing view"
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMove}
          onMouseLeave={() => setHoverHit(null)}
        />
      </div>
    </div>
  );
}
