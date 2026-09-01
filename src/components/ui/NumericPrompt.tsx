import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';

/**
 * Store-driven numeric input dialog — the in-app replacement for window.prompt
 * in context menus (fillet radius, chamfer distance, constraint values, …).
 * Opens via `useStore.getState().openNumericPrompt({ … })` from any event
 * handler; Esc cancels, Enter applies, invalid input is refused inline.
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

  const parsed = parseFloat(value);
  const valid = Number.isFinite(parsed) && parsed > (promptState.min ?? 0) - 1e-9;
  const tooSmall = Number.isFinite(parsed) && !valid;

  const apply = () => {
    if (!valid) return;
    const v = parsed;
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
        <input
          ref={inputRef}
          id="numeric-prompt-input"
          type="number"
          inputMode="decimal"
          value={value}
          min={promptState.min}
          step={promptState.step ?? 0.5}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); apply(); }
          }}
          className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
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
