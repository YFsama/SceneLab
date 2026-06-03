import { useState } from 'react';
import { useStore, type ThemeMode } from '../../store/app';
import { computeBoundingBox } from '../../lib/geometry';
import { selectionSummary } from '../../lib/selectionSummary';
import { MATERIALS } from '../../lib/materials';
import { useT } from '../../lib/i18n';
import { ProjectMenu } from './ProjectMenu';
import { Sun, Moon, Globe, Eye, Grid3X3, Keyboard, Box, Target } from 'lucide-react';

const themes: ThemeMode[] = ['dark', 'light', 'high-contrast'];

export function StatusBar() {
  const { t, locale } = useT();
  const workspace = useStore((s) => s.workspace);
  const objectCount = useStore((s) => s.objectIds.length);
  const selectedCount = useStore((s) => s.selectedIds.length);
  const selectedIds = useStore((s) => s.selectedIds);
  const bodies = useStore((s) => s.bodies);
  // X×Y×Z of the single selected body (shown for quick reference).
  const oneBodyDims = (() => {
    if (selectedIds.length !== 1) return null;
    const b = bodies.find((x) => x.id === selectedIds[0]);
    if (!b || b.vertices.length === 0) return null;
    const bb = computeBoundingBox(b);
    return `${(bb.max.x - bb.min.x).toFixed(1)} × ${(bb.max.y - bb.min.y).toFixed(1)} × ${(bb.max.z - bb.min.z).toFixed(1)} mm`;
  })();
  // Material of the single selected body (per-body; defaults to steel).
  const oneBodyMaterial = (() => {
    if (selectedIds.length !== 1) return null;
    const b = bodies.find((x) => x.id === selectedIds[0]);
    if (!b) return null;
    return MATERIALS[b.material ?? 'steel']?.name ?? null;
  })();
  // Combined bounding-box size of a multi-selection (SolidWorks shows the
  // selection's overall extents in the status bar).
  const multiDims = (() => {
    if (selectedIds.length < 2) return null;
    const summary = selectionSummary(bodies.filter((b) => selectedIds.includes(b.id)));
    if (!summary) return null;
    return `${summary.size.x.toFixed(1)} × ${summary.size.y.toFixed(1)} × ${summary.size.z.toFixed(1)} mm`;
  })();
  const sketchActive = useStore((s) => s.sketchActive);
  const currentSketch = useStore((s) => s.currentSketch);
  const gridSize = useStore((s) => s.gridSize);
  const setGridSize = useStore((s) => s.setGridSize);
  const sketchTool = useStore((s) => s.sketchTool);
  const projectName = useStore((s) => s.projectName);
  const projectDirty = useStore((s) => s.projectDirty);
  const setProjectName = useStore((s) => s.setProjectName);
  const [editingName, setEditingName] = useState<string | null>(null);

  const commitName = () => {
    if (editingName !== null) {
      const trimmed = editingName.trim();
      if (trimmed) setProjectName(trimmed);
      setEditingName(null);
    }
  };
  const polygonSides = useStore((s) => s.polygonSides);
  const setPolygonSides = useStore((s) => s.setPolygonSides);
  const wireframe = useStore((s) => s.wireframe);
  const setWireframe = useStore((s) => s.setWireframe);
  const showGrid = useStore((s) => s.showGrid);
  const setShowGrid = useStore((s) => s.setShowGrid);
  const showCenterOfMass = useStore((s) => s.showCenterOfMass);
  const setShowCenterOfMass = useStore((s) => s.setShowCenterOfMass);
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
        {editingName !== null ? (
          <input
            autoFocus
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') setEditingName(null); }}
            onBlur={commitName}
            onFocus={(e) => e.currentTarget.select()}
            className="w-32 px-1 py-0 bg-surface border border-accent rounded text-xs text-text-primary"
            aria-label={t('project.rename')}
          />
        ) : (
          <button
            onDoubleClick={() => setEditingName(projectName)}
            className="text-text-secondary font-medium hover:text-text-primary"
            title={projectDirty ? t('status.unsaved') : t('project.rename')}
          >
            {projectName}{projectDirty && <span className="text-warning"> •</span>}
          </button>
        )}
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
        {oneBodyDims && <span className="font-mono text-text-secondary">{oneBodyDims}</span>}
        {oneBodyMaterial && <span className="text-text-muted">{oneBodyMaterial}</span>}
        {multiDims && <span className="font-mono text-text-secondary">{multiDims}</span>}
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
          onClick={() => setShowCenterOfMass(!showCenterOfMass)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${showCenterOfMass ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'}`}
          aria-label={t('status.com')}
          aria-pressed={showCenterOfMass}
          title={t('status.com')}
        >
          <Target size={12} />
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
