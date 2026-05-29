import { useRef, useEffect, useMemo } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { projectBody, exportDrawingSVG } from '../../lib/io/drawing';
import { downloadFile } from '../../lib/io/studio3d';
import { exportDXF } from '../../lib/io/dxf';
import { showToast } from '../../lib/toast';
import { Download } from 'lucide-react';

export function DrawingCanvas() {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodies = useStore((s) => s.bodies);

  const views = useMemo(() => {
    if (bodies.length === 0) return [];
    const body = bodies[0]!;
    return [
      projectBody(body, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50), // Front
      projectBody(body, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50), // Top
      projectBody(body, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50), // Right
      projectBody(body, { x: 0.577, y: 0.577, z: 0.577 }, { x: 0, y: 1, z: 0 }, 50), // Iso
    ];
  }, [bodies]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || views.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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

      // Draw dimensions
      ctx.strokeStyle = 'red';
      ctx.fillStyle = 'red';
      ctx.font = '10px sans-serif';
      ctx.lineWidth = 0.5;
      for (const dim of view.dimensions) {
        const p1 = transform(dim.start);
        const p2 = transform(dim.end);
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        ctx.textAlign = 'center';
        ctx.fillText(`${dim.value.toFixed(1)} mm`, mx, my - 4);
      }
    }

    // Border
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cellW, 0);
    ctx.lineTo(cellW, h);
    ctx.moveTo(0, cellH);
    ctx.lineTo(w, cellH);
    ctx.stroke();
  }, [views]);

  const handleExportSVG = () => {
    if (views.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const svg = exportDrawingSVG(views[0]!, 800, 600);
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
    const dxf = exportDXF(bodies[0]!);
    downloadFile(dxf, 'drawing.dxf');
    showToast('DXF exported', 'success');
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
      </div>
      <div className="flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          className="w-full h-full"
          role="img"
          aria-label="Drawing view"
        />
      </div>
    </div>
  );
}
