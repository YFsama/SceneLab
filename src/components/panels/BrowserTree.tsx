import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Box, Layers, History } from 'lucide-react';
import { FeatureEditor } from './FeatureEditor';

export function BrowserTree() {
  const { t } = useT();
  const bodies = useStore((s) => s.bodies);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectObject = useStore((s) => s.selectObject);
  const featureTree = useStore((s) => s.featureTree);

  return (
    <aside
      className="w-56 bg-panel border-r border-panel-border flex flex-col"
      role="tree"
      aria-label={t('panel.browser')}
    >
      <div className="px-3 py-2 border-b border-panel-border flex items-center gap-2">
        <Layers size={16} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">{t('panel.browser')}</h2>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* Bodies section */}
        <div className="p-1">
          <p className="px-2 py-1 text-[10px] font-medium text-text-muted uppercase tracking-wider">
            {t('panel.features')}
          </p>
          {bodies.length === 0 ? (
            <p className="text-xs text-text-muted p-2">{t('panel.noObjects')}</p>
          ) : (
            bodies.map((body) => (
              <button
                key={body.id}
                onClick={() => selectObject(body.id)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left transition-colors
                  ${selectedIds.includes(body.id)
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-secondary hover:bg-surface-hover'
                  }`}
                role="treeitem"
                aria-selected={selectedIds.includes(body.id)}
              >
                <Box size={14} />
                <span className="truncate">{body.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Feature history section */}
        <div className="border-t border-panel-border p-1">
          <p className="px-2 py-1 text-[10px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-1">
            <History size={10} />
            {t('panel.history')}
          </p>
          {featureTree.features.length > 0 && (
            <div className="px-2 py-0.5 text-[10px] text-text-muted">
              {featureTree.features.length} {featureTree.features.length === 1 ? 'feature' : 'features'}
            </div>
          )}
          <FeatureEditor />
        </div>
      </div>
    </aside>
  );
}
