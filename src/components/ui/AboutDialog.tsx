import { useEffect, useState } from 'react';
import { Boxes, Keyboard, Stethoscope } from 'lucide-react';

// lucide-react v1 dropped brand icons; inline the GitHub mark (simple-icons path, CC0).
function GithubIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
import { useT } from '../../lib/i18n';
import { useStore } from '../../store/app';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import { getOS, getPlatform } from '../../lib/runtime';
import { FEEDBACK_PAGE_URL, openExternalUrl } from '../../lib/feedback';

/** Injected from Vite (vite.config.ts) / Vitest (vitest.config.ts) from package.json. */
declare const __APP_VERSION__: string;

interface InfoRow {
  label: string;
  value: string;
}

/** The about box: version / platform / language plus help & feedback entries. */
export function AboutDialog() {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  useFocusRestore();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('scenelab:open-about', onOpen);
    return () => window.removeEventListener('scenelab:open-about', onOpen);
  }, []);

  useEscapeClose(() => setOpen(false), open);

  if (!open) return null;

  // Computed here (not in render of rows array above) so tests can assert the
  // same runtime values the dialog shows.
  const rows: InfoRow[] = [
    { label: t('about.version'), value: __APP_VERSION__ },
    // getPlatform() is 'web' outside Tauri; getOS() adds the host OS either way.
    { label: t('about.platform'), value: `${getPlatform()} · ${getOS()}` },
    { label: t('about.locale'), value: locale },
  ];

  const openShortcuts = () => {
    setOpen(false);
    useStore.getState().setShowShortcuts(true);
  };
  const openDiagnostics = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('scenelab:open-diagnostics'));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t('about.title')}
    >
      <div
        className="w-[24rem] max-w-[90%] bg-panel border border-panel-border rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface border border-panel-border">
            <Boxes size={20} className="text-accent" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">SceneLab</h2>
            <p className="text-xs text-text-secondary">{t('about.title')}</p>
          </div>
        </div>

        <dl className="space-y-1 mb-4">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-2 text-xs">
              <dt className="text-text-secondary">{row.label}</dt>
              <dd className="font-mono text-text-primary">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-1 border-t border-panel-border pt-3">
          <button
            onClick={openShortcuts}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors text-left"
          >
            <Keyboard size={14} className="text-text-muted" />
            {t('about.shortcuts')}
          </button>
          <button
            onClick={openDiagnostics}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors text-left"
          >
            <Stethoscope size={14} className="text-text-muted" />
            {t('about.diagnostics')}
          </button>
          <button
            onClick={() => { void openExternalUrl(FEEDBACK_PAGE_URL); }}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors text-left"
          >
            <GithubIcon size={14} className="text-text-muted" />
            {t('report.github')}
          </button>
        </div>
      </div>
    </div>
  );
}
