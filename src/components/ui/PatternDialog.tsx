import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { computeBoundingBox } from '../../lib/geometry';

/** Linear-pattern dialog: count, spacing and axis for the chosen body. */
export function PatternDialog() {
  const { t } = useT();
  const bodyId = useStore((s) => s.pendingPattern);
  if (!bodyId) return null;
  return <Form key={bodyId} bodyId={bodyId} t={t} />;
}

function Form({ bodyId, t }: { bodyId: string; t: (k: string) => string }) {
  const body = useStore.getState().bodies.find((b) => b.id === bodyId);
  // Default spacing = 1.5× the body's X extent so copies don't overlap.
  const defSpacing = body ? Math.max(1, (() => { const bb = computeBoundingBox(body); return (bb.max.x - bb.min.x) * 1.5; })()) : 20;
  const [count, setCount] = useState('3');
  const [spacing, setSpacing] = useState(defSpacing.toFixed(1));
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('x');
  const close = () => useStore.getState().setPendingPattern(null);

  const create = () => {
    const n = parseInt(count, 10);
    const s = parseFloat(spacing);
    if (!Number.isFinite(n) || n < 1 || !Number.isFinite(s) || s <= 0) return;
    useStore.getState().linearPatternBody(bodyId, axis, n, s);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('pattern.title')}>
      <div className="w-64 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('pattern.title')}</h2>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('pattern.axis')}</span>
          <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')} className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs">
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('pattern.count')}</span>
          <input type="number" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs" />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('pattern.spacing')}</span>
          <span className="flex items-center gap-1">
            <input type="number" min={0} step={0.5} value={spacing} onChange={(e) => setSpacing(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} className="w-16 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs" />
            <span className="text-text-muted">mm</span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={create} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('dialog.create')}</button>
        </div>
      </div>
    </div>
  );
}
