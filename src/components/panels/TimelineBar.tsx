import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { featureSummary } from '../../lib/features/summary';
import { canReorderFeatures } from '../../lib/features/tree';
import { showToast } from '../../lib/toast';
import { FeatureEditDialog } from './FeatureEditor';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import type { Feature, FeatureType } from '../../lib/features/types';
import {
  History, PenTool, Box, RotateCw, Spline, Layers, Circle, Triangle, Square,
  Scaling, Copy, RefreshCw, FlipHorizontal, RefreshCcwDot, CircleDot,
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
  hole: CircleDot,
};

/**
 * Fusion-style bottom timeline: every feature-tree entry as a chip in build
 * order. Click selects the body the feature produced, double-click edits the
 * feature, right-click for suppress/delete — the parametric history made
 * visible instead of being buried in the browser tree. Chips drag-reorder the
 * timeline (dependency-safe: a feature can't move before its parents or after
 * its dependents); Alt+←/→ moves the focused chip one step.
 */
export function TimelineBar() {
  const { t } = useT();
  const featureTree = useStore((s) => s.featureTree);
  // The tree object mutates in place, so the version counter is the change
  // signal (e.g. keyboard reorders re-render through it).
  const featureVersion = useStore((s) => s.featureVersion);
  const selectObject = useStore((s) => s.selectObject);
  const updateFeature = useStore((s) => s.updateFeature);
  const removeFeature = useStore((s) => s.removeFeature);
  const moveFeature = useStore((s) => s.moveFeature);
  const recomputeTree = useStore((s) => s.recomputeTree);
  const [editing, setEditing] = useState<Feature | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; feature: Feature } | null>(null);
  // Drag-reorder state: the chip being dragged and the insertion index the
  // pointer currently hovers (0..features.length — gaps included).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const features = featureTree.features;
  if (features.length === 0) return null;

  const bodyOf = (f: Feature): string | null => featureTree.getResult(f.id)?.bodies[0]?.id ?? null;

  /** Apply a reorder; toast only for a genuine dependency violation (a
   * same-place drop or a boundary move stays silent). */
  const applyMove = (id: string, toIndex: number) => {
    if (moveFeature(id, toIndex)) return;
    const from = features.findIndex((f) => f.id === id);
    const target = Math.max(0, Math.min(features.length - 1, toIndex));
    // Only target === from is a visual no-op (from+1 swaps with the right neighbour).
    const samePlace = from === -1 || target === from;
    if (!samePlace && !canReorderFeatures(features, id, target)) {
      showToast(t('timeline.reorderDenied'), 'warning');
    }
  };

  const menuItems = (f: Feature): ContextMenuItem[] => [
    ...(bodyOf(f) ? [{ label: t('timeline.selectBody'), onClick: () => { const id = bodyOf(f); if (id) selectObject(id); } }] : []),
    { label: t('feature.editFeature'), onClick: () => setEditing(f) },
    { label: f.suppressed ? t('feature.showFeature') : t('feature.hideFeature'), onClick: () => updateFeature(f.id, (x) => ({ ...x, suppressed: !x.suppressed })) },
    { label: t('feature.deleteFeature'), danger: true, separatorBefore: true, onClick: () => removeFeature(f.id) },
  ];

  /** dragover on a chip: insertion before/after it by pointer half; allow the
   * drop only where the dependency rules say the move is legal (an un-prevented
   * dragover makes the browser show the "not allowed" cursor and never fires drop). */
  const chipDragOver = (e: React.DragEvent, index: number) => {
    if (!dragId || dragId === features[index]!.id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const insert = e.clientX <= rect.left + rect.width / 2 ? index : index + 1;
    if (!canReorderFeatures(features, dragId, insert)) {
      setDropIndex(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(insert);
  };

  /** dragover on the strip after the last chip: insertion at the very end. */
  const tailDragOver = (e: React.DragEvent) => {
    if (!dragId) return;
    if (!canReorderFeatures(features, dragId, features.length)) {
      setDropIndex(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(features.length);
  };

  const endDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const indicator = (key: string) => (
    <span key={key} data-testid="timeline-drop-indicator" className="w-0.5 h-5 bg-accent rounded shrink-0" />
  );

  return (
    <div
      className="h-9 bg-panel border-t border-panel-border flex items-center gap-1 px-2 overflow-x-auto shrink-0"
      role="toolbar"
      aria-label={t('timeline.title')}
      data-feature-version={featureVersion}
    >
      <span className="flex items-center gap-1 text-text-muted shrink-0 pr-1" title={t('timeline.title')}>
        <History size={12} />
        <span className="text-[10px] uppercase tracking-wider font-medium">{t('timeline.title')}</span>
      </span>
      <div className="flex items-center gap-1">
        {features.flatMap((f, i) => {
          const Icon = FEATURE_ICONS[f.type];
          const label = t(`feature.${f.type}`);
          const chip = (
            <button
              key={f.id}
              draggable
              onDragStart={(e) => {
                setDragId(f.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', f.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => chipDragOver(e, i)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) applyMove(dragId, dropIndex ?? i);
                endDrag();
              }}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
                e.preventDefault();
                applyMove(f.id, i + (e.key === 'ArrowRight' ? 1 : -1));
              }}
              onClick={() => { const id = bodyOf(f); if (id) selectObject(id); }}
              onDoubleClick={() => setEditing(f)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, feature: f }); }}
              className={`flex items-center gap-1 px-1.5 py-1 rounded shrink-0 max-w-36 transition-colors ${
                dragId === f.id ? 'opacity-40' : ''
              } ${
                f.suppressed
                  ? 'text-text-muted opacity-60 border border-dashed border-panel-border'
                  : 'text-text-secondary border border-transparent hover:border-panel-border hover:bg-surface-hover hover:text-text-primary'
              }`}
              title={`${i + 1}. ${f.name} — ${t('feature.editFeature')}\n${t('timeline.dragHint')}`}
              aria-label={`${i + 1}. ${f.name}`}
            >
              <Icon size={12} className={f.suppressed ? '' : 'text-accent'} />
              <span className="text-[11px] truncate">{label}</span>
              <span className="text-[10px] font-mono text-text-muted">{featureSummary(f)}</span>
            </button>
          );
          return dropIndex === i ? [indicator(`ind-${f.id}`), chip] : [chip];
        })}
        {dropIndex === features.length && indicator('ind-tail')}
        {/* Drop target covering the strip after the last chip */}
        <span
          className="flex-1 min-w-4 h-6"
          onDragOver={tailDragOver}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId) applyMove(dragId, features.length);
            endDrag();
          }}
        />
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
