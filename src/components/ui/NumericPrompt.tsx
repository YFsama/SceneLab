import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { evalDimension, formatDimensionValue, isPlainNumber } from '../../lib/dimension';

/**
 * Store-driven numeric input dialog — the in-app replacement for window.prompt
 * in context menus (fillet radius, chamfer distance, constraint values, …).
 * Opens via `useStore.getState().openNumericPrompt({ … })` from any event
 * handler; Esc cancels, Enter applies, invalid input is refused inline.
 *
 * CAD-style input: the field accepts arithmetic expressions (`20/2`,
 * `(30-6)/3`, `2*pi`) and commits the evaluated value. A subtle "= result"
 * preview appears while typing an expression; text that is neither a number
 * nor a valid expression gets an error border and disables Apply.
 */
export function NumericPromptDialog() {
  const { t } = useT();
  const promptState = useStore((s) => s.numericPrompt);
  const closeNumericPrompt = useStore((s) => s.closeNumericPrompt);
  // Keyed remount on each open: the input starts from the prompt's initial
  // value and self-selects, without effects setting state.
  const [value, setValue] = useState(() => String(promptState?.initial ?? ''));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (promptState) inputRef.current?.select();
  }, [promptState]);

  useEscapeClose(() => closeNumericPrompt(), !!promptState);
  useFocusRestore();

  if (!promptState) return null;

  const evaluated = evalDimension(value);
  const syntaxInvalid = value.trim() !== '' && evaluated === null;
  // Same min semantics as before (strictly greater than min, epsilon
  // tolerance), now applied to the evaluated value.
  const valid = evaluated !== null && evaluated > (promptState.min ?? 0) - 1e-9;
  const tooSmall = evaluated !== null && !valid;
  // Preview only while the text is an actual expression, not a plain number.
  const preview = evaluated !== null && !isPlainNumber(value)
    ? formatDimensionValue(evaluated)
    : null;

  const apply = () => {
    if (evaluated === null || !valid) return;
    const v = evaluated;
    closeNumericPrompt();
    promptState.onApply(v);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="numeric-prompt-title"
      onClick={(e) => { if (e.target === e.currentTarget) closeNumericPrompt(); }}
    >
      <div className="bg-panel border border-panel-border rounded-lg shadow-xl p-5 w-72 mx-4" key={promptState.titleKey + String(promptState.initial)}>
        <h2 id="numeric-prompt-title" className="text-sm font-semibold text-text-primary mb-3">
          {t(promptState.titleKey)}
        </h2>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="numeric-prompt-input">
          {t(promptState.labelKey)}
        </label>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            id="numeric-prompt-input"
            type="text"
            inputMode="decimal"
            value={value}
            autoFocus
            aria-invalid={syntaxInvalid || undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); apply(); }
            }}
            className={`w-full px-3 py-2 bg-surface border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent ${
              syntaxInvalid ? 'border-error' : 'border-panel-border'
            }`}
          />
          {preview !== null && (
            <span className="text-xs text-text-muted whitespace-nowrap">= {preview}</span>
          )}
        </div>
        {syntaxInvalid && (
          <p className="text-xs text-error mt-1.5">
            Enter a number or an expression, e.g. 20/2
          </p>
        )}
        {tooSmall && (
          <p className="text-xs text-error mt-1.5">
            {t('prompt.tooSmall')}: &gt; {(promptState.min ?? 0)}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={() => closeNumericPrompt()}
            className="px-3 py-1.5 text-sm rounded-md text-text-secondary hover:bg-surface-hover"
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={apply}
            disabled={!valid}
            className="px-4 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
