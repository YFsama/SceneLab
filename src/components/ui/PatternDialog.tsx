import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { computeBoundingBox } from '../../lib/geometry';

/** Pattern dialog: linear (axis/count/spacing) or circular (axis/count). */
export function PatternDialog() {
  const { t } = useT();
  const pending = useStore((s) => s.pendingPattern);
  if (!pending) return null;
  return <Form key={`${pending.bodyId}:${pending.mode}`} bodyId={pending.bodyId} mode={pending.mode} t={t} />;
}

function Form({ bodyId, mode, t }: { bodyId: string; mode: 'linear' | 'circular' | 'grid'; t: (k: string) => string }) {
  const body = useStore.getState().bodies.find((b) => b.id === bodyId);
  // Default spacing = 1.5× the body's X extent so copies don't overlap.
  const defSpacing = body ? Math.max(1, (() => { const bb = computeBoundingBox(body); return (bb.max.x - bb.min.x) * 1.5; })()) : 20;
  const [count, setCount] = useState(mode === 'circular' ? '6' : '3');
  const [spacing, setSpacing] = useState(defSpacing.toFixed(1));
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>(mode === 'circular' ? 'y' : 'x');
  const [countZ, setCountZ] = useState('3');
  const [spacingZ, setSpacingZ] = useState(defSpacing.toFixed(1));
  const close = () => useStore.getState().setPendingPattern(null);

  const create = () => {
    const n = parseInt(count, 10);
    if (!Number.isFinite(n) || n < 1) return;
    if (mode === 'circular') {
      useStore.getState().circularPatternBody(bodyId, axis, n);
    } else if (mode === 'grid') {
      const sx = parseFloat(spacing); const nz = parseInt(countZ, 10); const sz = parseFloat(spacingZ);
      if (![sx, sz].every((v) => Number.isFinite(v) && v > 0) || !(nz >= 1)) return;
      useStore.getState().gridPatternBody(bodyId, n, sx, nz, sz);
    } else {
      const s = parseFloat(spacing);
      if (!Number.isFinite(s) || s <= 0) return;
      useStore.getState().linearPatternBody(bodyId, axis, n, s);
    }
    close();
  };

  const numField = (label: string, value: string, set: (v: string) => void, unit?: string) => (
    <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input type="number" min={0} step={unit ? 0.5 : 1} value={value} onChange={(e) => set(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} className="w-16 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs" />
        {unit && <span className="text-text-muted">{unit}</span>}
      </span>
    </label>
  );

  const title = mode === 'circular' ? t('pattern.circularTitle') : mode === 'grid' ? t('pattern.gridTitle') : t('pattern.title');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-64 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {mode === 'grid' ? (
          <>
            {numField(`${t('pattern.count')} X`, count, setCount)}
            {numField(`${t('pattern.spacing')} X`, spacing, setSpacing, 'mm')}
            {numField(`${t('pattern.count')} Z`, countZ, setCountZ)}
            {numField(`${t('pattern.spacing')} Z`, spacingZ, setSpacingZ, 'mm')}
          </>
        ) : (
          <>
            <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span>{t('pattern.axis')}</span>
              <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')} className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs">
                <option value="x">X</option>
                <option value="y">Y</option>
                <option value="z">Z</option>
              </select>
            </label>
            {numField(t('pattern.count'), count, setCount)}
            {mode === 'linear' && numField(t('pattern.spacing'), spacing, setSpacing, 'mm')}
            {mode === 'circular' && <p className="text-[10px] text-text-muted">{t('pattern.circularHint')}</p>}
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={create} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('dialog.create')}</button>
        </div>
      </div>
    </div>
  );
}
