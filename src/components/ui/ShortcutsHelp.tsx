import { useEffect } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';

interface Row { keys: string; labelKey: string }
interface Group { titleKey: string; rows: Row[] }

// Grouped reference of the app's keyboard shortcuts (see initShortcuts + the
// viewport handlers). Labels are i18n keys reused from the rest of the UI.
const GROUPS: Group[] = [
  {
    titleKey: 'shortcuts.views',
    rows: [
      { keys: '1', labelKey: 'viewport.front' },
      { keys: '2', labelKey: 'viewport.top' },
      { keys: '3', labelKey: 'viewport.right' },
      { keys: '4', labelKey: 'viewport.iso' },
      { keys: '5', labelKey: 'viewport.back' },
      { keys: '6', labelKey: 'viewport.bottom' },
      { keys: '7', labelKey: 'viewport.left' },
      { keys: 'F', labelKey: 'viewport.fit' },
      { keys: 'Shift+F', labelKey: 'viewport.fitSelection' },
      { keys: '+ / −', labelKey: 'shortcuts.zoom' },
      { keys: 'Home', labelKey: 'viewport.home' },
      { keys: 'G', labelKey: 'status.grid' },
      { keys: 'X', labelKey: 'section.title' },
      { keys: 'Tab', labelKey: 'shortcuts.hideSelected' },
      { keys: 'Shift+Tab', labelKey: 'shortcuts.showAll' },
    ],
  },
  {
    titleKey: 'shortcuts.workspaces',
    rows: [
      { keys: 'S', labelKey: 'toolbar.sketch' },
      { keys: 'M', labelKey: 'toolbar.model' },
      { keys: 'D', labelKey: 'toolbar.drawing' },
      { keys: 'C', labelKey: 'toolbar.cam' },
    ],
  },
  {
    titleKey: 'shortcuts.sketch',
    rows: [
      { keys: 'V', labelKey: 'sketch.select' },
      { keys: 'L', labelKey: 'sketch.line' },
      { keys: 'R', labelKey: 'sketch.rect' },
      { keys: 'O', labelKey: 'sketch.circle' },
      { keys: 'A', labelKey: 'sketch.arc' },
      { keys: 'P', labelKey: 'sketch.polygon' },
      { keys: 'Esc', labelKey: 'sketch.exit' },
    ],
  },
  {
    titleKey: 'shortcuts.edit',
    rows: [
      { keys: 'Ctrl+N', labelKey: 'project.new' },
      { keys: 'Ctrl+O', labelKey: 'project.open' },
      { keys: 'Ctrl+S', labelKey: 'project.save' },
      { keys: 'Ctrl+Z', labelKey: 'toolbar.undo' },
      { keys: 'Ctrl+Y', labelKey: 'toolbar.redo' },
      { keys: 'Ctrl+X / C / V', labelKey: 'shortcuts.copyPaste' },
      { keys: 'Ctrl+Shift+V', labelKey: 'shortcuts.pasteInPlace' },
      { keys: 'Ctrl+D', labelKey: 'menu.duplicate' },
      { keys: 'Ctrl+A', labelKey: 'shortcuts.selectAll' },
      { keys: 'Ctrl+Shift+I', labelKey: 'shortcuts.invertSelection' },
      { keys: 'F2', labelKey: 'menu.rename' },
      { keys: '← ↑ → ↓ / PgUp / PgDn', labelKey: 'shortcuts.nudge' },
      { keys: 'LMB drag', labelKey: 'shortcuts.dragBody' },
      { keys: 'E', labelKey: 'feature.extrude' },
      { keys: 'Ctrl+I', labelKey: 'menu.isolate' },
      { keys: 'Del', labelKey: 'menu.delete' },
      { keys: 'Ctrl+K', labelKey: 'shortcuts.palette' },
      { keys: 'B', labelKey: 'library.title' },
      { keys: 'Ctrl+B / Ctrl+P', labelKey: 'shortcuts.panels' },
    ],
  },
];

/** Modal listing the keyboard shortcuts; opened by the ? key or the help button. */
export function ShortcutsHelp() {
  const { t } = useT();
  const open = useStore((s) => s.showShortcuts);
  const close = () => useStore.getState().setShowShortcuts(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label={t('shortcuts.title')}
    >
      <div
        className="w-[28rem] max-h-[80vh] overflow-y-auto bg-panel border border-panel-border rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-text-primary mb-3">{t('shortcuts.title')}</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {GROUPS.map((g) => (
            <div key={g.titleKey}>
              <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{t(g.titleKey)}</p>
              <div className="space-y-0.5">
                {g.rows.map((r) => (
                  <div key={r.keys} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-text-secondary">{t(r.labelKey)}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-surface border border-panel-border font-mono text-[10px] text-text-primary">{r.keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
