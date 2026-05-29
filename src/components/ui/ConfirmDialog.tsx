import { useState, useEffect, useRef } from 'react';
import { subscribeConfirm, resolveConfirm } from '../../lib/confirm';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { useT } from '../../lib/i18n';

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function ConfirmDialog() {
  const { t } = useT();
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeConfirm(setOpts), []);
  useEscapeClose(() => resolveConfirm(false), !!opts);
  useFocusRestore();

  if (!opts) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
    >
      <div
        ref={dialogRef}
        className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 max-w-sm w-full mx-4"
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-text-primary mb-2">
          {opts.title}
        </h2>
        <p id="confirm-message" className="text-sm text-text-secondary mb-6">{opts.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => resolveConfirm(false)}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {opts.cancelLabel ?? t('dialog.cancel')}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            className={`px-4 py-2 text-sm rounded-md text-white transition-colors
              ${opts.destructive ? 'bg-error hover:bg-error/80' : 'bg-accent hover:bg-accent/80'}`}
            autoFocus
          >
            {opts.confirmLabel ?? t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
