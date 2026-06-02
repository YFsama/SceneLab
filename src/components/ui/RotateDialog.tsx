import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';

/** Precise rotate: rotate the selection by an arbitrary angle about X/Y/Z. */
export function RotateDialog() {
  const { t } = useT();
  const open = useStore((s) => s.rotateDialogOpen);
  if (!open) return null;
  return <Form t={t} />;
}

function Form({ t }: { t: (k: string) => string }) {
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('y');
  const [angle, setAngle] = useState('45');
  const close = () => useStore.getState().setRotateDialogOpen(false);

  const apply = () => {
    const deg = parseFloat(angle);
    if (!Number.isFinite(deg)) return;
    useStore.getState().rotateSelected(axis, deg);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('rotate.title')}>
      <div className="w-60 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('rotate.title')}</h2>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('pattern.axis')}</span>
          <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')} className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs">
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('rotate.angle')}</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              step={15}
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
              className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
            />
            <span className="text-text-muted">°</span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={apply} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('rotate.apply')}</button>
        </div>
      </div>
    </div>
  );
}
