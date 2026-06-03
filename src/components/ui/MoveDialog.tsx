import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';

/** Precise move: translate the current selection by exact ΔX/ΔY/ΔZ (mm). */
export function MoveDialog() {
  const { t } = useT();
  const open = useStore((s) => s.moveDialogOpen);
  if (!open) return null;
  return <Form t={t} />;
}

function Form({ t }: { t: (k: string) => string }) {
  const [dx, setDx] = useState('0');
  const [dy, setDy] = useState('0');
  const [dz, setDz] = useState('0');
  const [mode, setMode] = useState<'relative' | 'absolute'>('relative');
  const close = () => useStore.getState().setMoveDialogOpen(false);
  useEscapeClose(close);

  const apply = () => {
    const x = parseFloat(dx) || 0;
    const y = parseFloat(dy) || 0;
    const z = parseFloat(dz) || 0;
    if (mode === 'absolute') useStore.getState().moveSelectionTo({ x, y, z });
    else useStore.getState().nudgeSelected(x, y, z);
    close();
  };

  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
      <span className="w-4">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step={0.5}
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
          onFocus={(e) => e.currentTarget.select()}
          className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
        />
        <span className="text-text-muted">mm</span>
      </span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close} role="dialog" aria-modal="true" aria-label={t('move.title')}>
      <div className="w-60 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-text-primary">{t('move.title')}</h2>
        <div className="flex gap-1 text-xs">
          {(['relative', 'absolute'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 px-2 py-1 rounded border ${mode === m ? 'border-accent text-accent' : 'border-panel-border text-text-secondary hover:text-text-primary'}`}
              aria-pressed={mode === m}
            >
              {t(`move.${m}`)}
            </button>
          ))}
        </div>
        {field(mode === 'absolute' ? 'X' : 'ΔX', dx, setDx)}
        {field(mode === 'absolute' ? 'Y' : 'ΔY', dy, setDy)}
        {field(mode === 'absolute' ? 'Z' : 'ΔZ', dz, setDz)}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover">{t('dialog.cancel')}</button>
          <button onClick={apply} className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover">{t('move.apply')}</button>
        </div>
      </div>
    </div>
  );
}
