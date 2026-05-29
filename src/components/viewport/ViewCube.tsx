import { useStore, type ViewDirection } from '../../store/app';
import { useT } from '../../lib/i18n';

const views: { dir: ViewDirection; shortcut: string }[] = [
  { dir: 'top', shortcut: '1' },
  { dir: 'front', shortcut: '2' },
  { dir: 'right', shortcut: '3' },
  { dir: 'iso', shortcut: '0' },
];

export function ViewCube() {
  const { t } = useT();
  const current = useStore((s) => s.viewDirection);
  const setView = useStore((s) => s.setViewDirection);

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
          title={`${t('viewport.switchTo', { view: t(`viewport.${dir}`) })} (${shortcut})`}
        >
          {t(`viewport.${dir}`)}
          <span className="absolute -top-1 -right-1 text-[7px] opacity-40 font-mono">
            {shortcut}
          </span>
        </button>
      ))}
    </div>
  );
}
