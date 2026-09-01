import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { WORKSPACES } from './workspaces';
import { Undo2, Redo2 } from 'lucide-react';

export function Toolbar() {
  const { t } = useT();
  const current = useStore((s) => s.workspace);
  const setWorkspace = useStore((s) => s.setWorkspace);
  // While sketching, the undo/redo buttons act on the sketch's own history.
  const canUndo = useStore((s) => (s.sketchActive ? s.sketchUndoStack.length : s.undoStack.length) > 0);
  const canRedo = useStore((s) => (s.sketchActive ? s.sketchRedoStack.length : s.redoStack.length) > 0);
  const undo = () => { const s = useStore.getState(); if (s.sketchActive) s.sketchUndo(); else s.undo(); };
  const redo = () => { const s = useStore.getState(); if (s.sketchActive) s.sketchRedo(); else s.redo(); };

  return (
    <aside
      className="w-12 bg-panel border-r border-panel-border flex flex-col items-center py-2 gap-1"
      role="toolbar"
      aria-label={t('toolbar.workspaceSelector')}
    >
      {WORKSPACES.map(({ mode, icon: Icon, shortcut }) => (
        <button
          key={mode}
          onClick={() => setWorkspace(mode)}
          className={`w-10 h-10 flex items-center justify-center rounded-md transition-colors relative group
            ${current === mode
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          aria-label={t(`toolbar.${mode}`)}
          aria-pressed={current === mode}
          title={`${t(`toolbar.${mode}`)}${shortcut ? ` (${shortcut})` : ''}`}
        >
          <Icon size={20} />
          {shortcut && (
            <span className="absolute bottom-0.5 right-0.5 text-[8px] opacity-50 font-mono">
              {shortcut}
            </span>
          )}
        </button>
      ))}

      <div className="mt-auto flex flex-col gap-1">
        <div className="w-6 h-px self-center bg-panel-border" aria-hidden="true" />
        <button
          onClick={() => undo()}
          disabled={!canUndo}
          className="w-10 h-10 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          aria-label={t('toolbar.undo')}
          title={`${t('toolbar.undo')} (Ctrl+Z)`}
        >
          <Undo2 size={18} />
        </button>
        <button
          onClick={() => redo()}
          disabled={!canRedo}
          className="w-10 h-10 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          aria-label={t('toolbar.redo')}
          title={`${t('toolbar.redo')} (Ctrl+Y)`}
        >
          <Redo2 size={18} />
        </button>
      </div>
    </aside>
  );
}
