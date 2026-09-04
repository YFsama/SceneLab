import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { featureSummary } from '../../lib/features/summary';
import { FeatureEditDialog } from './FeatureEditor';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import type { Feature, FeatureType } from '../../lib/features/types';
import {
  History, PenTool, Box, RotateCw, Spline, Layers, Circle, Triangle, Square,
  Scaling, Copy, RefreshCw, FlipHorizontal, RefreshCcwDot,
  type LucideIcon,
} from 'lucide-react';

const FEATURE_ICONS: Record<FeatureType, LucideIcon> = {
  sketch: PenTool,
  extrude: Box,
  revolve: RotateCw,
  sweep: Spline,
  loft: Layers,
  fillet: Circle,
  chamfer: Triangle,
  shell: Square,
  scale: Scaling,
  linearArray: Copy,
  circularArray: RefreshCw,
  mirror: FlipHorizontal,
};

/**
 * Fusion-style bottom timeline: every feature-tree entry as a chip in build
 * order. Click selects the body the feature produced, double-click edits the
 * feature, right-click for suppress/delete — the parametric history made
 * visible instead of being buried in the browser tree.
 */
export function TimelineBar() {
  const { t } = useT();
  const featureTree = useStore((s) => s.featureTree);
  const selectObject = useStore((s) => s.selectObject);
  const updateFeature = useStore((s) => s.updateFeature);
  const removeFeature = useStore((s) => s.removeFeature);
  const recomputeTree = useStore((s) => s.recomputeTree);
  const [editing, setEditing] = useState<Feature | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; feature: Feature } | null>(null);

  const features = featureTree.features;
  if (features.length === 0) return null;

  const bodyOf = (f: Feature): string | null => featureTree.getResult(f.id)?.bodies[0]?.id ?? null;

  const menuItems = (f: Feature): ContextMenuItem[] => [
    ...(bodyOf(f) ? [{ label: t('timeline.selectBody'), onClick: () => { const id = bodyOf(f); if (id) selectObject(id); } }] : []),
    { label: t('feature.editFeature'), onClick: () => setEditing(f) },
    { label: f.suppressed ? t('feature.showFeature') : t('feature.hideFeature'), onClick: () => updateFeature(f.id, (x) => ({ ...x, suppressed: !x.suppressed })) },
    { label: t('feature.deleteFeature'), danger: true, separatorBefore: true, onClick: () => removeFeature(f.id) },
  ];

  return (
    <div
      className="h-9 bg-panel border-t border-panel-border flex items-center gap-1 px-2 overflow-x-auto shrink-0"
      role="toolbar"
      aria-label={t('timeline.title')}
    >
      <span className="flex items-center gap-1 text-text-muted shrink-0 pr-1" title={t('timeline.title')}>
        <History size={12} />
        <span className="text-[10px] uppercase tracking-wider font-medium">{t('timeline.title')}</span>
      </span>
      <div className="flex items-center gap-1">
        {features.map((f, i) => {
          const Icon = FEATURE_ICONS[f.type];
          const label = t(`feature.${f.type}`);
          return (
            <button
              key={f.id}
              onClick={() => { const id = bodyOf(f); if (id) selectObject(id); }}
              onDoubleClick={() => setEditing(f)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, feature: f }); }}
              className={`flex items-center gap-1 px-1.5 py-1 rounded shrink-0 max-w-36 transition-colors ${
                f.suppressed
                  ? 'text-text-muted opacity-60 border border-dashed border-panel-border'
                  : 'text-text-secondary border border-transparent hover:border-panel-border hover:bg-surface-hover hover:text-text-primary'
              }`}
              title={`${i + 1}. ${f.name} — ${t('feature.editFeature')}`}
              aria-label={`${i + 1}. ${f.name}`}
            >
              <Icon size={12} className={f.suppressed ? '' : 'text-accent'} />
              <span className="text-[11px] truncate">{label}</span>
              <span className="text-[10px] font-mono text-text-muted">{featureSummary(f)}</span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => recomputeTree()}
        className="ml-auto shrink-0 px-1.5 py-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('timeline.recompute')}
        title={t('timeline.recompute')}
      >
        <RefreshCcwDot size={12} />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.feature)} onClose={() => setMenu(null)} />
      )}
      {editing && <FeatureEditDialog feature={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
