import { useStore, type ViewDirection } from '../../store/app';
import { useT } from '../../lib/i18n';

// The six standard orthographic views plus isometric. Shortcut badges match the
// central hotkeys (initShortcuts): 1 front, 2 top, 3 right, 4 iso; the remaining
// views are reachable here, via the right-click View Orientation menu, or the
// command palette.
const views: { dir: ViewDirection; shortcut?: string }[] = [
  { dir: 'front', shortcut: '1' },
  { dir: 'back', shortcut: '5' },
  { dir: 'left', shortcut: '7' },
  { dir: 'right', shortcut: '3' },
  { dir: 'top', shortcut: '2' },
  { dir: 'bottom', shortcut: '6' },
  { dir: 'iso', shortcut: '4' },
];

export function ViewCube() {
  const { t } = useT();
  const current = useStore((s) => s.viewDirection);
  const projection = useStore((s) => s.projection);
  const setView = useStore((s) => s.setViewDirection);
  const toggleProjection = useStore((s) => s.toggleProjection);

  return (
    <div
      className="absolute top-3 right-3 flex gap-1 rounded-md bg-panel/80 backdrop-blur-sm border border-panel-border p-1"
      role="group"
      aria-label={t('viewport.controls')}
    >
      {views.map(({ dir, shortcut }) => (
        <button
          key={dir}
          onClick={() => setView(dir)}
          className={`px-2 py-1 text-xs font-medium rounded transition-colors relative
            ${current === dir
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          aria-label={t('viewport.switchTo', { view: t(`viewport.${dir}`) })}
          aria-pressed={current === dir}
          title={`${t('viewport.switchTo', { view: t(`viewport.${dir}`) })}${shortcut ? ` (${shortcut})` : ''}`}
        >
          {t(`viewport.${dir}`)}
          {shortcut && (
            <span className="absolute -top-1 -right-1 text-[7px] opacity-40 font-mono">
              {shortcut}
            </span>
          )}
        </button>
      ))}
      <button
        onClick={toggleProjection}
        className={`px-2 py-1 text-xs font-medium rounded transition-colors
          ${projection === 'orthographic'
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
          }`}
        aria-label={t('viewport.projection')}
        aria-pressed={projection === 'orthographic'}
        title={`${t('viewport.projection')} (Shift+P)`}
      >
        {projection === 'orthographic' ? t('viewport.orthographic') : t('viewport.perspective')}
      </button>
    </div>
  );
}
