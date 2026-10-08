import { useEffect, useState, type ReactNode } from 'react';
import { X, Copy, Check, Save, ExternalLink, Trash2 } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useStore } from '../../store/app';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { getPlatform, getOS, isTauri, callNative } from '../../lib/runtime';
import { recentCommands, commandLabel } from '../../lib/commands/registry';
import { showToast } from '../../lib/toast';
import { buildIssueUrl, openExternalUrl } from '../../lib/feedback';
import { downloadFile } from '../../lib/io';
import {
  getRecentErrors, clearErrors, buildDiagnosticsReport, copyText,
  truncateForIssue, formatErrorEntry,
  OPEN_DIAGNOSTICS_EVENT, type ErrorEntry,
} from '../../lib/errorLog';

// Injected from package.json by vite/vitest (see src/vite-env.d.ts).
declare const __APP_VERSION__: string;

/** yyyyMMdd-HHmm local-time stamp for the save-file default name. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
      {children}
    </div>
  );
}

function EnvRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex gap-2 px-2 py-0.5 text-xs">
      <span className="w-20 shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-text-primary break-all">{value}</span>
    </div>
  );
}

/**
 * Diagnostics dialog: environment info, the recent error log and recent
 * commands, plus explicit copy / save / open-feedback actions. Everything is
 * user-initiated — no report ever leaves the app on its own. Mirrors the
 * ConfirmDialog/ParametersPanel overlay style and opens via the same
 * window-event pattern as the other global dialogs.
 */
export function DiagnosticsDialog() {
  const { t } = useT();
  const locale = useStore((s) => s.locale);
  const [open, setOpen] = useState(false);
  // Snapshot taken on open / clear so the list doesn't reshuffle mid-read.
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    const onOpen = () => {
      setErrors(getRecentErrors(20));
      setOpen(true);
    };
    window.addEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
  }, []);

  useEscapeClose(() => setOpen(false), open);
  useFocusRestore();

  if (!open) return null;

  const copyReport = (): void => {
    void copyText(buildDiagnosticsReport()).then((ok) => {
      showToast(ok ? t('errlog.copied') : t('errlog.copyFailed'), ok ? 'success' : 'error');
    });
  };

  const copyOne = (entry: ErrorEntry): void => {
    void copyText(formatErrorEntry(entry)).then((ok) => {
      if (!ok) {
        showToast(t('errlog.copyFailed'), 'error');
        return;
      }
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1500);
    });
  };

  const saveReport = (): void => {
    const name = `scenelab-diagnostics-${stamp()}.txt`;
    const contents = buildDiagnosticsReport();
    void (async () => {
      try {
        if (isTauri()) {
          // Native save dialog. Ok(None) → the user cancelled: nothing was
          // written, so no toast (mirrors projectActions' save contract).
          const r = await callNative('save_text_file', { defaultName: name, contents });
          if (r === null || r === undefined) return;
          const path = typeof r === 'string' ? r : String((r as { path?: string }).path ?? name);
          showToast(t('errlog.saved', { path }), 'success');
        } else {
          downloadFile(contents, name);
          showToast(t('errlog.saved', { path: name }), 'success');
        }
      } catch {
        showToast(t('errlog.saveFailed'), 'error');
      }
    })();
  };

  const openFeedback = (): void => {
    const report = buildDiagnosticsReport();
    void copyText(report).then((ok) => {
      // shell.open first inside Tauri (WKWebView/webkit2gtk may block
      // window.open); window.open fallback lives in openExternalUrl.
      void openExternalUrl(
        buildIssueUrl(`SceneLab diagnostics ${__APP_VERSION__} ${getPlatform()}`, truncateForIssue(report)),
      );
      showToast(ok ? t('report.copied') : t('errlog.copyFailed'), ok ? 'success' : 'error');
    });
  };

  const clearLog = (): void => {
    clearErrors();
    setErrors(getRecentErrors(20));
  };

  const commands = recentCommands(8);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t('errlog.title')}
    >
      <div
        className="w-[38rem] max-w-[90vw] max-h-[75vh] flex flex-col bg-panel border border-panel-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">
            {t('errlog.title')}
            <span className="ml-2 text-xs font-normal text-text-muted">
              {t('errlog.recentErrors', { n: errors.length })}
            </span>
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-3">
          <section>
            <SectionLabel>{t('errlog.env')}</SectionLabel>
            <EnvRow label="Version" value={__APP_VERSION__} />
            <EnvRow label="Platform" value={`${getPlatform()} / ${getOS()}`} />
            <EnvRow label="Language" value={locale} />
            <EnvRow
              label="Viewport"
              value={`${window.innerWidth}×${window.innerHeight} @${Math.round(window.devicePixelRatio * 100) / 100}x`}
            />
          </section>

          <section>
            <SectionLabel>{t('errlog.recentErrors', { n: errors.length })}</SectionLabel>
            {errors.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-text-muted">{t('errlog.noErrors')}</p>
            ) : (
              <ul className="flex flex-col gap-1 px-2">
                {errors.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-1 bg-surface border border-panel-border rounded px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1 font-mono text-[11px] text-text-primary whitespace-pre-wrap break-all">
                      {formatErrorEntry(e)}
                    </div>
                    <button
                      type="button"
                      aria-label={t('errlog.copyOne')}
                      title={t('errlog.copyOne')}
                      className="shrink-0 p-0.5 text-text-muted hover:text-text-primary transition-colors"
                      onClick={() => copyOne(e)}
                    >
                      {copiedId === e.id ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionLabel>{t('errlog.recentCommands')}</SectionLabel>
            <div className="flex flex-wrap gap-1 px-2">
              {commands.length === 0 ? (
                <span className="text-xs text-text-muted">—</span>
              ) : commands.map((c) => (
                <span
                  key={c.id}
                  className="px-2 py-0.5 rounded bg-surface border border-panel-border text-xs text-text-secondary"
                >
                  {commandLabel(c)}
                </span>
              ))}
            </div>
          </section>

          <p className="px-2 pb-1 text-xs text-text-muted">{t('errlog.reportHint')}</p>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-panel-border p-3">
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
            onClick={clearLog}
            aria-label={t('errlog.clear')}
          >
            <Trash2 size={12} />
            {t('errlog.clear')}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
            onClick={openFeedback}
            aria-label={t('report.github')}
          >
            <ExternalLink size={12} />
            {t('report.github')}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
            onClick={saveReport}
            aria-label={t('errlog.saveReport')}
          >
            <Save size={12} />
            {t('errlog.saveReport')}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-white bg-accent hover:bg-accent/80 transition-colors"
            onClick={copyReport}
            aria-label={t('errlog.copyReport')}
          >
            <Copy size={12} />
            {t('errlog.copyReport')}
          </button>
        </div>
      </div>
    </div>
  );
}
