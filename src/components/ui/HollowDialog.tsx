import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { showToast } from '../../lib/toast';

/** Hollow the chosen body into a closed shell of a given wall thickness (mm). */
export function HollowDialog() {
  const { t } = useT();
  const bodyId = useStore((s) => s.hollowDialogBody);
  if (!bodyId) return null;
  return <Form key={bodyId} bodyId={bodyId} t={t} />;
}

function Form({ bodyId, t }: { bodyId: string; t: (k: string) => string }) {
  const [thickness, setThickness] = useState('2');
  const [busy, setBusy] = useState(false);
  const close = () => useStore.getState().setHollowDialogBody(null);
  useEscapeClose(close);

  const apply = async () => {
    if (busy) return; // voxel hollowing runs in the worker — don't double-fire
    const w = parseFloat(thickness);
    if (!Number.isFinite(w) || w <= 0) return;
    setBusy(true);
    const id = await useStore.getState().hollowBodyById(bodyId, w);
    if (id) {
      close();
    } else {
      setBusy(false);
      // Keep the dialog open so the thickness can be retried smaller.
      showToast(t('toast.hollowFailed'), 'warning');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('hollow.title')}>
      <div className="w-60 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('hollow.title')}</h2>
        <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{t('hollow.thickness')}</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              step={0.5}
              value={thickness}
              onChange={(e) => setThickness(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
              onFocus={(e) => e.currentTarget.select()}
              className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
            />
            <span className="text-text-muted">mm</span>
          </span>
        </label>
        <p className="text-[10px] text-text-muted">{t('hollow.hint')}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={apply} disabled={busy} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed">{t('hollow.apply')}</button>
        </div>
      </div>
    </div>
  );
}
