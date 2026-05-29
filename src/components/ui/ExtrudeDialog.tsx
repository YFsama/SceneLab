import { useState, useRef } from 'react';
import { useStore } from '../../store/app';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { useT } from '../../lib/i18n';

export function ExtrudeDialog() {
  const show = useStore((s) => s.showExtrudeDialog);
  const setShow = useStore((s) => s.setShowExtrudeDialog);
  const performExtrude = useStore((s) => s.performExtrude);
  const { t } = useT();

  const [distance, setDistance] = useState(10);
  const [symmetric, setSymmetric] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(() => setShow(false), show);
  useFocusRestore();

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extrude-title"
    >
      <div
        ref={dialogRef}
        className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4"
      >
        <h2 id="extrude-title" className="text-lg font-semibold text-text-primary mb-4">
          {t('feature.extrude')}
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1" htmlFor="extrude-distance">
              {t('feature.distance')}
            </label>
            <input
              id="extrude-distance"
              type="number"
              value={distance}
              onChange={(e) => setDistance(Math.max(0.1, Number(e.target.value)))}
              min={0.1}
              step={0.5}
              className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="extrude-symmetric"
              type="checkbox"
              checked={symmetric}
              onChange={(e) => setSymmetric(e.target.checked)}
              className="rounded border-panel-border"
            />
            <label htmlFor="extrude-symmetric" className="text-sm text-text-secondary">
              {t('feature.symmetric')}
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={() => setShow(false)}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={() => performExtrude(distance, symmetric)}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            autoFocus
          >
            {t('feature.extrude')}
          </button>
        </div>
      </div>
    </div>
  );
}
