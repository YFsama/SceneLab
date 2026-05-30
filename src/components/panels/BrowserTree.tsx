import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Box, Layers, History } from 'lucide-react';
import { FeatureEditor } from './FeatureEditor';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { layFlat, seatOnBed } from '../../lib/print';
import { centerBody, convexHullBody, mirrorAcrossAxis, splitAcrossAxis, type Axis } from '../../lib/geometry';
import type { SolidBody } from '../../lib/geometry/types';

export function BrowserTree() {
  const { t } = useT();
  const bodies = useStore((s) => s.bodies);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectObject = useStore((s) => s.selectObject);
  const replaceBody = useStore((s) => s.replaceBody);
  const removeDirectBody = useStore((s) => s.removeDirectBody);
  const addDirectBodies = useStore((s) => s.addDirectBodies);
  const featureTree = useStore((s) => s.featureTree);
  const [menu, setMenu] = useState<{ x: number; y: number; bodyId: string } | null>(null);

  const apply = (bodyId: string, op: (b: SolidBody) => SolidBody) => {
    const body = bodies.find((b) => b.id === bodyId);
    if (body) replaceBody(bodyId, op(body));
  };

  // Mirror-merge a body about its min face along an axis, replacing it in place.
  const mirror = (bodyId: string, axis: Axis) => {
    const body = bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const r = mirrorAcrossAxis(body, axis);
    if (r) replaceBody(bodyId, r);
  };

  // Split a body in half through its centre along an axis, replacing it with the halves.
  const split = (bodyId: string, axis: Axis) => {
    const body = bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const halves = splitAcrossAxis(body, axis);
    if (halves.length === 0) return;
    removeDirectBody(bodyId);
    addDirectBodies(halves);
  };

  const menuItems = (bodyId: string): ContextMenuItem[] => [
    { label: t('menu.layFlat'), onClick: () => apply(bodyId, layFlat) },
    { label: t('menu.seatOnBed'), onClick: () => apply(bodyId, (b) => seatOnBed(b)) },
    { label: t('menu.center'), onClick: () => apply(bodyId, centerBody) },
    { label: t('menu.convexHull'), onClick: () => apply(bodyId, (b) => convexHullBody(b)) },
    { label: t('menu.mirrorX'), onClick: () => mirror(bodyId, 'x'), separatorBefore: true },
    { label: t('menu.mirrorY'), onClick: () => mirror(bodyId, 'y') },
    { label: t('menu.mirrorZ'), onClick: () => mirror(bodyId, 'z') },
    { label: t('menu.splitX'), onClick: () => split(bodyId, 'x'), separatorBefore: true },
    { label: t('menu.splitY'), onClick: () => split(bodyId, 'y') },
    { label: t('menu.splitZ'), onClick: () => split(bodyId, 'z') },
    { label: t('menu.delete'), onClick: () => removeDirectBody(bodyId), separatorBefore: true, danger: true },
  ];

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
                onContextMenu={(e) => {
                  e.preventDefault();
                  selectObject(body.id);
                  setMenu({ x: e.clientX, y: e.clientY, bodyId: body.id });
                }}
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.bodyId)} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}
