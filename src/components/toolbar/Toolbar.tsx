import { useStore, type WorkspaceMode } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Box, Pen, Cog, Ruler, Settings } from 'lucide-react';

const workspaces: { mode: WorkspaceMode; icon: typeof Box; shortcut: string }[] = [
  { mode: 'sketch', icon: Pen, shortcut: 'S' },
  { mode: 'model', icon: Box, shortcut: 'M' },
  { mode: 'assembly', icon: Cog, shortcut: '' },
  { mode: 'drawing', icon: Ruler, shortcut: 'D' },
  { mode: 'cam', icon: Settings, shortcut: 'C' },
];

export function Toolbar() {
  const { t } = useT();
  const current = useStore((s) => s.workspace);
  const setWorkspace = useStore((s) => s.setWorkspace);

  return (
    <aside
      className="w-12 bg-panel border-r border-panel-border flex flex-col items-center py-2 gap-1"
      role="toolbar"
      aria-label={t('toolbar.workspaceSelector')}
    >
      {workspaces.map(({ mode, icon: Icon, shortcut }) => (
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
    </aside>
  );
}
