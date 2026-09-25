import { useEffect } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { History, X } from 'lucide-react';

/**
 * Crash-recovery banner (Fusion/Office data-safety parity): on boot, PROBE the
 * stored autosave and OFFER it — Restore / Discard / dismiss-for-session —
 * instead of silently auto-restoring. The user always decides what happens to
 * their data.
 *
 * Placement: bottom-center, just above the status bar. It floats over the
 * viewport's lower edge; the Fusion timeline is null on a fresh boot (empty
 * feature tree), which is exactly when this banner is up — Restore/Discard
 * close it before any timeline could appear underneath.
 */
export function RestoreBanner() {
  const { t } = useT();
  const probe = useStore((s) => s.autosaveProbe);

  // Probe once on boot: surface the stored autosave (name + age), if any.
  useEffect(() => {
    useStore.getState().probeAutosave();
  }, []);

  if (!probe) return null;

  const dismiss = () => useStore.getState().dismissAutosaveProbe();

  /** Human "N min / N h ago" from the autosave's metadata.modified (computed
   * once at probe time in the store); null when the stored JSON carried no
   * parseable timestamp — the age phrase is then omitted. */
  const age = probe.ageMinutes === null
    ? null
    : probe.ageMinutes < 60
      ? t('restore.ageMinutes', { n: Math.max(1, probe.ageMinutes) })
      : t('restore.ageHours', { n: Math.floor(probe.ageMinutes / 60) });

  const body = probe.name === null
    ? t('restore.bodyUnnamed')
    : age === null
      ? t('restore.body', { name: probe.name })
      : t('restore.bodyAged', { name: probe.name, age });

  const restore = () => {
    // The SAME deserialize path the existing restore uses (command palette's
    // "Restore autosave") — no duplicated format knowledge here.
    const ok = useStore.getState().restoreAutosave();
    // The autosave was never explicitly saved, so the restored project is
    // dirty; the next autosave tick then re-snapshots the restored state.
    if (ok) useStore.getState().setProjectDirty(true);
    useStore.getState().dismissAutosaveProbe();
  };

  const discard = () => useStore.getState().discardAutosave();

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50" aria-live="polite">
      <div
        role="group"
        aria-label={t('restore.title')}
        data-testid="restore-banner"
        className="flex items-center gap-3 px-4 py-2 rounded-lg border border-warning/40 bg-panel/95 backdrop-blur-sm shadow-2xl max-w-[92vw]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') dismiss();
        }}
      >
        <History size={16} className="text-warning shrink-0" aria-hidden="true" />
        <p className="text-sm text-text-primary">{body}</p>
        <span className="flex items-center gap-2 shrink-0">
          <button
            onClick={restore}
            className="px-3 py-1 text-sm rounded-md text-white bg-accent hover:bg-accent/80 transition-colors"
          >
            {t('restore.restore')}
          </button>
          <button
            onClick={discard}
            className="px-3 py-1 text-sm rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            {t('restore.discard')}
          </button>
        </span>
        <button
          onClick={dismiss}
          className="text-text-muted hover:text-text-primary shrink-0"
          aria-label={t('restore.dismiss')}
          title={t('restore.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
