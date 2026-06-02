import { useStore, type ThemeMode } from '../../store/app';
import { useT } from '../../lib/i18n';
import { ProjectMenu } from './ProjectMenu';
import { Sun, Moon, Globe, Eye, Grid3X3, Keyboard, Box } from 'lucide-react';

const themes: ThemeMode[] = ['dark', 'light', 'high-contrast'];

export function StatusBar() {
  const { t, locale } = useT();
  const workspace = useStore((s) => s.workspace);
  const objectCount = useStore((s) => s.objectIds.length);
  const selectedCount = useStore((s) => s.selectedIds.length);
  const sketchActive = useStore((s) => s.sketchActive);
  const currentSketch = useStore((s) => s.currentSketch);
  const gridSize = useStore((s) => s.gridSize);
  const setGridSize = useStore((s) => s.setGridSize);
  const sketchTool = useStore((s) => s.sketchTool);
  const projectName = useStore((s) => s.projectName);
  const projectDirty = useStore((s) => s.projectDirty);
  const polygonSides = useStore((s) => s.polygonSides);
  const setPolygonSides = useStore((s) => s.setPolygonSides);
  const wireframe = useStore((s) => s.wireframe);
  const setWireframe = useStore((s) => s.setWireframe);
  const showGrid = useStore((s) => s.showGrid);
  const setShowGrid = useStore((s) => s.setShowGrid);
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
        <span className="text-text-secondary font-medium" title={projectDirty ? t('status.unsaved') : undefined}>
          {projectName}{projectDirty && <span className="text-warning"> •</span>}
        </span>
        <span>{t(`toolbar.${workspace}`)}</span>
        <span className="flex items-center gap-1">
          <Eye size={10} />
          {t(`viewport.${viewDirection}`)}
        </span>
        {sketchActive && (
          <span className="flex items-center gap-1">
            <Grid3X3 size={10} />
            {t('status.gridSnap')}:
            <select
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              className="bg-surface border border-panel-border rounded px-1 py-0 text-[10px] text-text-primary"
              aria-label={t('status.gridSnap')}
            >
              {[0.1, 0.5, 1, 5, 10].map((s) => (
                <option key={s} value={s}>{s}mm</option>
              ))}
            </select>
          </span>
        )}
        {sketchActive && sketchTool === 'polygon' && (
          <span className="flex items-center gap-1">
            {t('sketch.polygon')}:
            <input
              type="number"
              min={3}
              max={64}
              step={1}
              value={polygonSides}
              onChange={(e) => setPolygonSides(Number(e.target.value))}
              className="w-12 bg-surface border border-panel-border rounded px-1 py-0 text-[10px] text-text-primary"
              aria-label={t('sketch.polygon')}
            />
            {t('status.sides')}
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
          onClick={() => setShowGrid(!showGrid)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${showGrid ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'}`}
          aria-label={t('status.grid')}
          aria-pressed={showGrid}
          title={`${t('status.grid')} (G)`}
        >
          <Grid3X3 size={12} />
        </button>
        <button
          onClick={() => setWireframe(!wireframe)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${wireframe ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'}`}
          aria-label={t('status.wireframe')}
          aria-pressed={wireframe}
          title={t('status.wireframe')}
        >
          <Box size={12} />
        </button>
        <button
          onClick={() => useStore.getState().setShowShortcuts(true)}
          className="flex items-center gap-1 px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          aria-label={t('shortcuts.help')}
          title={t('shortcuts.help')}
        >
          <Keyboard size={12} />
        </button>
        <button
          onClick={toggleLocale}
          className="flex items-center gap-1 px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          aria-label={`Switch to ${locale === 'en' ? '中文' : 'English'}`}
          title={`Switch to ${locale === 'en' ? '中文' : 'English'}`}
        >
          <Globe size={12} />
          <span>{locale === 'en' ? '中文' : 'English'}</span>
        </button>
        <button
          onClick={cycleTheme}
          className="flex items-center gap-1 px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          aria-label={`${t('status.theme')}: ${theme}`}
          title={`${t('status.theme')}: ${theme}`}
        >
          {theme === 'dark' ? <Moon size={12} /> : <Sun size={12} />}
          <span>{t(`theme.${theme}`)}</span>
        </button>
        <ProjectMenu />
      </div>
    </footer>
  );
}
