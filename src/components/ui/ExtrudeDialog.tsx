import { useState, useRef } from 'react';
import { useStore } from '../../store/app';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { useT } from '../../lib/i18n';
import { evalDimension, formatDimensionValue, isPlainNumber } from '../../lib/dimension';

/**
 * Extrude distance dialog with CAD-style expression input: the field keeps the
 * raw text while typing (so intermediate states like `20/` survive) and the
 * value is evaluated and clamped to the 0.1 mm floor only when extruding.
 *
 * The Operation selector (F5) makes a POCKET one dialog trip instead of
 * extrude-cutter → Combine ▸ Subtract: 'join' creates a new body (the
 * default, and what every earlier extrude did); 'cut' subtracts the extruded
 * profile from the body that is SELECTED when the dialog opens — the cut
 * target must be picked BEFORE opening the dialog (the inline hint says so
 * and the Extrude button stays disabled until a target exists).
 */
export function ExtrudeDialog() {
  const show = useStore((s) => s.showExtrudeDialog);
  const setShow = useStore((s) => s.setShowExtrudeDialog);
  const performExtrude = useStore((s) => s.performExtrude);
  // Cut resolves its target through the SELECTED BODY — a stale id (the body
  // was replaced by a previous cut/fillet) must disable the button, not
  // enable a silent no-op.
  const hasTarget = useStore((s) => {
    const id = s.selectedIds[0];
    return id !== undefined && s.bodies.some((b) => b.id === id);
  });
  const { t } = useT();

  const [distanceText, setDistanceText] = useState('10');
  const [symmetric, setSymmetric] = useState(false);
  const [operation, setOperation] = useState<'join' | 'cut'>('join');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(() => setShow(false), show);
  useFocusRestore();

  if (!show) return null;

  const evaluated = evalDimension(distanceText);
  // Cut without a selected target body is refused — the store guard and this
  // disabled state agree (the hint below explains how to provide one).
  const cutWithoutTarget = operation === 'cut' && !hasTarget;
  const canExtrude = evaluated !== null && !cutWithoutTarget;
  const syntaxInvalid = distanceText.trim() !== '' && evaluated === null;
  // Preview only while the text is an actual expression, not a plain number.
  const preview = evaluated !== null && !isPlainNumber(distanceText)
    ? formatDimensionValue(evaluated)
    : null;

  const handleExtrude = () => {
    if (evaluated === null) return;
    performExtrude(Math.max(0.1, evaluated), symmetric, operation);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extrude-title"
      onKeyDown={(e) => {
        // Enter commits from anywhere in the dialog (the input included) —
        // autofocus on the button is not reliable across mounts. Enter on a
        // focused button already clicks it; don't double-fire.
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          handleExtrude();
        }
      }}
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
            <div className="flex items-center gap-2">
              <input
                id="extrude-distance"
                type="text"
                inputMode="decimal"
                value={distanceText}
                onChange={(e) => setDistanceText(e.target.value)}
                aria-invalid={syntaxInvalid || undefined}
                className={`w-full px-3 py-2 bg-surface border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent ${
                  syntaxInvalid ? 'border-error' : 'border-panel-border'
                }`}
              />
              {preview !== null && (
                <span className="text-xs text-text-muted whitespace-nowrap">= {preview}</span>
              )}
            </div>
          </div>

          <div>
            <span id="extrude-operation-label" className="block text-sm text-text-secondary mb-1">
              {t('feature.operation')}
            </span>
            <div className="flex items-center gap-4" role="radiogroup" aria-labelledby="extrude-operation-label">
              <label className="flex items-center gap-1.5 text-sm text-text-secondary">
                <input
                  type="radio"
                  name="extrude-operation"
                  value="join"
                  checked={operation === 'join'}
                  onChange={() => setOperation('join')}
                  className="border-panel-border"
                />
                {t('feature.join')}
              </label>
              <label className="flex items-center gap-1.5 text-sm text-text-secondary">
                <input
                  type="radio"
                  name="extrude-operation"
                  value="cut"
                  checked={operation === 'cut'}
                  onChange={() => setOperation('cut')}
                  className="border-panel-border"
                />
                {t('feature.cut')}
              </label>
            </div>
          </div>

          {cutWithoutTarget && (
            <p className="text-xs text-text-muted" role="note">
              {t('feature.cutTargetHint')}
            </p>
          )}

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
            onClick={handleExtrude}
            disabled={!canExtrude}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
            autoFocus
          >
            {t('feature.extrude')}
          </button>
        </div>
      </div>
    </div>
  );
}
