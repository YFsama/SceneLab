import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';

/** Scale the selection uniformly by an arbitrary factor about each body's centre. */
export function ScaleDialog() {
  const { t } = useT();
  const open = useStore((s) => s.scaleDialogOpen);
  if (!open) return null;
  return <Form t={t} />;
}

function Form({ t }: { t: (k: string) => string }) {
  const [factor, setFactor] = useState('1');
  const close = () => useStore.getState().setScaleDialogOpen(false);

  const apply = () => {
    const f = parseFloat(factor);
    if (!Number.isFinite(f) || f <= 0) return;
    useStore.getState().scaleSelected(f);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('scale.title')}>
      <div className="w-60 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('scale.title')}</h2>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('scale.factor')}</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={apply} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('scale.apply')}</button>
        </div>
      </div>
    </div>
  );
}
