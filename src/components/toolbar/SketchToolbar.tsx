import { useStore, type SketchTool } from '../../store/app';
import { useT } from '../../lib/i18n';
import { MousePointer2, Minus, Square, Circle, CircleDot, Hexagon, Box, RotateCw, LogOut, MoveDiagonal, Scissors, ArrowRightToLine } from 'lucide-react';

const tools: { tool: SketchTool; icon: typeof MousePointer2; shortcut: string }[] = [
  { tool: 'select', icon: MousePointer2, shortcut: 'V' },
  { tool: 'line', icon: Minus, shortcut: 'L' },
  { tool: 'rect', icon: Square, shortcut: 'R' },
  { tool: 'circle', icon: Circle, shortcut: 'O' },
  { tool: 'arc', icon: CircleDot, shortcut: 'A' },
  { tool: 'polygon', icon: Hexagon, shortcut: 'P' },
];

/** Opens the offset-distance prompt for the selected entity (Fusion's Offset:
 * line loops offset mitered, circles/arcs/rectangles grow or shrink). */
function promptOffset() {
  const st = useStore.getState();
  const id = st.selectedSketchIds[0] ?? st.selectedSketchId;
  if (!id || !st.currentSketch?.entities.has(id)) return;
  st.openNumericPrompt({
    titleKey: 'sketch.offset',
    labelKey: 'sketch.offsetPrompt',
    initial: 2,
    min: -1e6,
    onApply: (val) => { useStore.getState().offsetSelectedSketch(val); },
  });
}

export function SketchToolbar() {
  const { t } = useT();
  const current = useStore((s) => s.sketchTool);
  const setTool = useStore((s) => s.setSketchTool);
  const setSketchActive = useStore((s) => s.setSketchActive);
  const setCurrentSketch = useStore((s) => s.setCurrentSketch);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const setShowExtrudeDialog = useStore((s) => s.setShowExtrudeDialog);
  const setShowRevolveDialog = useStore((s) => s.setShowRevolveDialog);
  const selectedSketchId = useStore((s) => s.selectedSketchId);
  const selectedSketchIds = useStore((s) => s.selectedSketchIds);
  const currentSketch = useStore((s) => s.currentSketch);
  const offsettableSelected = (() => {
    const id = selectedSketchIds[0] ?? selectedSketchId;
    const e = id ? currentSketch?.entities.get(id) : undefined;
    // A line only offsets as part of a closed loop — the store action validates
    // that; here we just need an entity of an offsetable kind selected.
    return !!e && (e.type === 'line' || e.type === 'circle' || e.type === 'arc' || e.type === 'rectangle');
  })();

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

      {/* Offset (equidistant copy) of the selected entity — Fusion's sketch
          Offset. Disabled without an offsetable selection (hint in the title). */}
      <button
        onClick={promptOffset}
        disabled={!offsettableSelected}
        className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={t('sketch.offset')}
        aria-disabled={!offsettableSelected}
        title={!offsettableSelected ? `${t('sketch.offset')} — ${t('sketch.offsetHint')}` : t('sketch.offset')}
      >
        <MoveDiagonal size={18} />
      </button>

      {/* Trim / Extend — click-then-act tools (Fusion's TRIM/EXTEND): picking
          the tool arms it; the viewport's next click performs the operation on
          the entity under the cursor via trimSketchAt / extendSketchTo. */}
      <button
        onClick={() => setTool('trim')}
        className={`w-9 h-9 flex items-center justify-center rounded transition-colors
          ${current === 'trim'
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
          }`}
        aria-label={t('sketch.trim')}
        aria-pressed={current === 'trim'}
        title={`${t('sketch.trim')} — ${t('sketch.trimHint')}`}
      >
        <Scissors size={18} />
      </button>

      <button
        onClick={() => setTool('extend')}
        className={`w-9 h-9 flex items-center justify-center rounded transition-colors
          ${current === 'extend'
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
          }`}
        aria-label={t('sketch.extend')}
        aria-pressed={current === 'extend'}
        title={`${t('sketch.extend')} — ${t('sketch.extendHint')}`}
      >
        <ArrowRightToLine size={18} />
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
