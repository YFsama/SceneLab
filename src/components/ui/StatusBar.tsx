import { useStore, type ThemeMode } from '../../store/app';
import { useT } from '../../lib/i18n';
import { ProjectMenu } from './ProjectMenu';
import { Sun, Moon, Globe, Eye, Grid3X3 } from 'lucide-react';

const themes: ThemeMode[] = ['dark', 'light', 'high-contrast'];

export function StatusBar() {
  const { t, locale } = useT();
  const workspace = useStore((s) => s.workspace);
  const objectCount = useStore((s) => s.objectIds.length);
  const selectedCount = useStore((s) => s.selectedIds.length);
  const sketchActive = useStore((s) => s.sketchActive);
  const currentSketch = useStore((s) => s.currentSketch);
  const viewDirection = useStore((s) => s.viewDirection);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setLocale = useStore((s) => s.setLocale);

  const cycleTheme = () => {
    const idx = themes.indexOf(theme);
    const next = themes[(idx + 1) % themes.length]!;
    setTheme(next);
  };

  const toggleLocale = () => {
    setLocale(locale === 'en' ? 'zh' : 'en');
  };

  return (
    <footer
      className="h-6 bg-panel border-t border-panel-border flex items-center justify-between px-3 text-xs text-text-muted"
      role="status"
    >
      <div className="flex items-center gap-4">
        <span>{t(`toolbar.${workspace}`)}</span>
        <span className="flex items-center gap-1">
          <Eye size={10} />
          {t(`viewport.${viewDirection}`)}
        </span>
        {sketchActive && (
          <span className="flex items-center gap-1">
            <Grid3X3 size={10} />
            {t('status.gridSnap')}: 0.5mm
          </span>
        )}
        {sketchActive && currentSketch && (
          <span>
            {t('status.entities')}: {currentSketch.entities.size} | {t('status.constraints')}: {currentSketch.constraints.size}
          </span>
        )}
        <span>{t('status.objects')}: {objectCount}</span>
        <span>{t('status.selected')}: {selectedCount}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={toggleLocale}
          className="flex items-center gap-0.5 px-1.5 py-0.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          aria-label={`Switch to ${locale === 'en' ? '中文' : 'English'}`}
          title={`Switch to ${locale === 'en' ? '中文' : 'English'}`}
        >
          <Globe size={12} />
          <span className="uppercase">{locale}</span>
        </button>
        <button
          onClick={cycleTheme}
          className="p-0.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          aria-label={`${t('status.theme')}: ${theme}`}
          title={`${t('status.theme')}: ${theme}`}
        >
          {theme === 'dark' ? <Moon size={12} /> : <Sun size={12} />}
        </button>
        <ProjectMenu />
      </div>
    </footer>
  );
}
