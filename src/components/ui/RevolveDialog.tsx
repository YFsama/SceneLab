import { useState, useRef } from 'react';
import { useStore } from '../../store/app';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { useT } from '../../lib/i18n';

export function RevolveDialog() {
  const show = useStore((s) => s.showRevolveDialog);
  const setShow = useStore((s) => s.setShowRevolveDialog);
  const performRevolve = useStore((s) => s.performRevolve);
  const { t } = useT();

  const [angleDeg, setAngleDeg] = useState(360);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(() => setShow(false), show);
  useFocusRestore();

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revolve-title"
    >
      <div ref={dialogRef} className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4">
        <h2 id="revolve-title" className="text-lg font-semibold text-text-primary mb-4">
          {t('feature.revolve')}
        </h2>

        <div>
          <label className="block text-sm text-text-secondary mb-1" htmlFor="revolve-angle">
            {t('feature.angle')}
          </label>
          <input
            id="revolve-angle"
            type="number"
            value={angleDeg}
            onChange={(e) => setAngleDeg(Math.min(360, Math.max(1, Number(e.target.value))))}
            min={1}
            max={360}
            step={5}
            className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={() => setShow(false)}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={() => performRevolve((angleDeg * Math.PI) / 180)}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            autoFocus
          >
            {t('feature.revolve')}
          </button>
        </div>
      </div>
    </div>
  );
}
