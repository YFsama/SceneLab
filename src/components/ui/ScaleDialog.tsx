import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';

/** Scale the selection uniformly or per-axis about the combined centre. */
export function ScaleDialog() {
  const { t } = useT();
  const open = useStore((s) => s.scaleDialogOpen);
  if (!open) return null;
  return <Form t={t} />;
}

function Form({ t }: { t: (k: string) => string }) {
  const [uniform, setUniform] = useState(true);
  const [factor, setFactor] = useState('1');
  const [fx, setFx] = useState('1');
  const [fy, setFy] = useState('1');
  const [fz, setFz] = useState('1');
  const close = () => useStore.getState().setScaleDialogOpen(false);
  useEscapeClose(close);

  const apply = () => {
    const store = useStore.getState();
    if (uniform) {
      const f = parseFloat(factor);
      if (!Number.isFinite(f) || f <= 0) return;
      store.scaleSelected(f);
    } else {
      const x = parseFloat(fx), y = parseFloat(fy), z = parseFloat(fz);
      if (!Number.isFinite(x) || x <= 0 || !Number.isFinite(y) || y <= 0 || !Number.isFinite(z) || z <= 0) return;
      store.scaleSelectedXYZ(x, y, z);
    }
    close();
  };

  const numInput = (value: string, onChange: (v: string) => void) => (
    <input
      type="number"
      min={0}
      step={0.1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
      onFocus={(e) => e.currentTarget.select()}
      className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('scale.title')}>
      <div className="w-64 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('scale.title')}</h2>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} className="accent-accent" />
          <span>{t('scale.uniform')}</span>
        </label>
        {uniform ? (
          <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
            <span>{t('scale.factor')}</span>
            {numInput(factor, setFactor)}
          </label>
        ) : (
          <div className="space-y-1.5">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <label key={axis} className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                <span className="font-mono">{axis.toUpperCase()}</span>
                {numInput(axis === 'x' ? fx : axis === 'y' ? fy : fz, axis === 'x' ? setFx : axis === 'y' ? setFy : setFz)}
              </label>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={apply} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('scale.apply')}</button>
        </div>
      </div>
    </div>
  );
}
