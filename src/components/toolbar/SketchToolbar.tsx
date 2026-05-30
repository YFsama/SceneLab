import { useStore, type SketchTool } from '../../store/app';
import { useT } from '../../lib/i18n';
import { MousePointer2, Minus, Square, Circle, CircleDot, Box, RotateCw, LogOut } from 'lucide-react';

const tools: { tool: SketchTool; icon: typeof MousePointer2; shortcut: string }[] = [
  { tool: 'select', icon: MousePointer2, shortcut: 'V' },
  { tool: 'line', icon: Minus, shortcut: 'L' },
  { tool: 'rect', icon: Square, shortcut: 'R' },
  { tool: 'circle', icon: Circle, shortcut: 'O' },
  { tool: 'arc', icon: CircleDot, shortcut: 'A' },
];

export function SketchToolbar() {
  const { t } = useT();
  const current = useStore((s) => s.sketchTool);
  const setTool = useStore((s) => s.setSketchTool);
  const setSketchActive = useStore((s) => s.setSketchActive);
  const setCurrentSketch = useStore((s) => s.setCurrentSketch);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const setShowExtrudeDialog = useStore((s) => s.setShowExtrudeDialog);
  const setShowRevolveDialog = useStore((s) => s.setShowRevolveDialog);

  const exitSketch = () => {
    setSketchActive(false);
    setCurrentSketch(null);
    setWorkspace('model');
  };

  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1 rounded-md bg-panel/80 backdrop-blur-sm border border-panel-border p-1"
      role="toolbar"
      aria-label={t('sketch.tools')}
    >
      {tools.map(({ tool, icon: Icon, shortcut }) => (
        <button
          key={tool}
          onClick={() => setTool(tool)}
          className={`w-9 h-9 flex items-center justify-center rounded transition-colors relative
            ${current === tool
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          aria-label={t(`sketch.${tool}`)}
          aria-pressed={current === tool}
          title={`${t(`sketch.${tool}`)} (${shortcut})`}
        >
          <Icon size={18} />
          <span className="absolute bottom-0 right-0.5 text-[7px] opacity-40 font-mono">
            {shortcut}
          </span>
        </button>
      ))}

      <div className="w-px h-7 self-center bg-panel-border mx-1" />

      <button
        onClick={() => setShowExtrudeDialog(true)}
        className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('feature.extrude')}
        title={t('feature.extrude')}
      >
        <Box size={18} />
      </button>

      <button
        onClick={() => setShowRevolveDialog(true)}
        className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('feature.revolve')}
        title={t('feature.revolve')}
      >
        <RotateCw size={18} />
      </button>

      <button
        onClick={exitSketch}
        className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('sketch.exit')}
        title={`${t('sketch.exit')} (Esc)`}
      >
        <LogOut size={18} />
      </button>
    </div>
  );
}
