import { useEffect, useState } from 'react';
import { Boxes, Keyboard, Stethoscope, Github } from 'lucide-react';
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
            <Github size={14} className="text-text-muted" />
            {t('report.github')}
          </button>
        </div>
      </div>
    </div>
  );
}
