import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { buildDiagnosticsReport, copyText, recordError } from '../../lib/errorLog';
import { useT } from '../../lib/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort React error boundary: a render/lifecycle throw anywhere below
 * replaces the tree with the crash card instead of a blank window, and is
 * recorded into the persistent error log (kind 'react') so the diagnostics
 * report can include it. Must be a class component — React has no hook API
 * for boundaries. The fallback is a separate function component so it can use
 * the useT() hook (the same split store/app.ts uses for non-React lookups).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The first component-stack line names the subtree that failed — enough
    // context for a bug report without dumping the whole tree.
    const frame = info.componentStack
      ?.split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    recordError('react', error.message || String(error), error.stack, frame);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <CrashFallback
          error={this.state.error}
          onContinue={() => {
            // Reset — if the culprit throws again it is caught here once more.
            this.setState({ error: null });
          }}
        />
      );
    }
    return this.props.children;
  }
}

/** Message preview length before the expand toggle kicks in. */
const MESSAGE_PREVIEW = 600;

function CrashFallback({ error, onContinue }: { error: Error; onContinue: () => void }): ReactNode {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(id);
  }, [copied]);

  const onCopy = (): void => {
    void copyText(buildDiagnosticsReport()).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  const message = error.message || String(error);
  const shown = expanded || message.length <= MESSAGE_PREVIEW
    ? message
    : `${message.slice(0, MESSAGE_PREVIEW)}…`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={t('crash.title')}
    >
      <div className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 max-w-lg w-full flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-error">{t('crash.title')}</h2>
        <p className="text-sm text-text-secondary">{t('crash.body')}</p>
        <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-all text-text-primary bg-surface border border-panel-border rounded-md p-3 max-h-48 overflow-y-auto">
          {shown}
        </pre>
        {message.length > MESSAGE_PREVIEW && (
          <button
            type="button"
            className="self-start font-mono text-xs text-accent hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '[−]' : `[+${message.length - MESSAGE_PREVIEW}]`}
          </button>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
            onClick={onContinue}
            aria-label={t('crash.continue')}
          >
            {t('crash.continue')}
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-md text-white bg-accent hover:bg-accent/80 transition-colors"
            onClick={onCopy}
            aria-label={t('crash.copy')}
          >
            {copied ? t('crash.copied') : t('crash.copy')}
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-md text-white bg-error hover:bg-error/80 transition-colors"
            onClick={() => window.location.reload()}
            aria-label={t('crash.reload')}
          >
            {t('crash.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}
