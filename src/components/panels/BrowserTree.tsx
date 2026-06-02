import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Box, Layers, History, Frame, Slash, Dot, Axis3d, X, Eye, EyeOff } from 'lucide-react';
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
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const replaceBody = useStore((s) => s.replaceBody);
  const removeDirectBody = useStore((s) => s.removeDirectBody);
  const addDirectBodies = useStore((s) => s.addDirectBodies);
  const renaming = useStore((s) => s.renaming);
  const beginRename = useStore((s) => s.beginRename);
  const setRenameValue = useStore((s) => s.setRenameValue);
  const commitRename = useStore((s) => s.commitRename);
  const cancelRename = useStore((s) => s.cancelRename);
  const duplicateSelected = useStore((s) => s.duplicateSelected);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const toggleBodyVisibility = useStore((s) => s.toggleBodyVisibility);
  const copySelected = useStore((s) => s.copySelected);
  const directBodies = useStore((s) => s.directBodies);
  const reorderBody = useStore((s) => s.reorderBody);
  const isolateSelected = useStore((s) => s.isolateSelected);
  const showAllBodies = useStore((s) => s.showAllBodies);
  const rotateSelected = useStore((s) => s.rotateSelected);
  const scaleSelected = useStore((s) => s.scaleSelected);
  const setMoveDialogOpen = useStore((s) => s.setMoveDialogOpen);
  const setRotateDialogOpen = useStore((s) => s.setRotateDialogOpen);
  const moveSelectionToOrigin = useStore((s) => s.moveSelectionToOrigin);
  const flipSelected = useStore((s) => s.flipSelected);
  const weldSelected = useStore((s) => s.weldSelected);
  const toggleBodyTransparency = useStore((s) => s.toggleBodyTransparency);
  const setScaleDialogOpen = useStore((s) => s.setScaleDialogOpen);
  const alignSelected = useStore((s) => s.alignSelected);
  const distributeSelected = useStore((s) => s.distributeSelected);
  const combineSelected = useStore((s) => s.combineSelected);
  const joinSelected = useStore((s) => s.joinSelected);
  const setHollowDialogBody = useStore((s) => s.setHollowDialogBody);
  const makeBoundingBoxOfSelection = useStore((s) => s.makeBoundingBoxOfSelection);
  const dropSelectedToFloor = useStore((s) => s.dropSelectedToFloor);
  const setPendingPattern = useStore((s) => s.setPendingPattern);
  const planes = useStore((s) => s.planes);
  const axes = useStore((s) => s.axes);
  const points = useStore((s) => s.points);
  const coordSystems = useStore((s) => s.coordSystems);
  const removePlane = useStore((s) => s.removePlane);
  const removeAxis = useStore((s) => s.removeAxis);
  const removePoint = useStore((s) => s.removePoint);
  const removeCoordinateSystem = useStore((s) => s.removeCoordinateSystem);
  const featureTree = useStore((s) => s.featureTree);
  const [menu, setMenu] = useState<{ x: number; y: number; bodyId: string } | null>(null);
  // Anchor for SolidWorks-style Shift+click range selection in the tree.
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // Click selection: Shift = range from anchor, Ctrl/Cmd = toggle, plain = single.
  const handleRowClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchorId) {
      selectRange(anchorId, id);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(id);
      setAnchorId(id);
    } else {
      selectObject(id);
      setAnchorId(id);
    }
  };

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

  // Grouped right-click menu: common actions at the top level, everything else
  // tucked into flyout submenus so the menu stays short (SolidWorks-style).
  const menuItems = (bodyId: string): ContextMenuItem[] => {
    const pre = (fn: () => void) => () => { if (!selectedIds.includes(bodyId)) selectObject(bodyId); fn(); };
    const axisAlign = (ax: 'x' | 'y' | 'z'): ContextMenuItem[] => [
      { label: t('menu.alignMin'), onClick: () => alignSelected(ax, 'min') },
      { label: t('menu.alignCenter'), onClick: () => alignSelected(ax, 'center') },
      { label: t('menu.alignMax'), onClick: () => alignSelected(ax, 'max') },
    ];
    const align: ContextMenuItem[] =
      selectedIds.length > 1
        ? [
            { label: 'X', submenu: axisAlign('x') },
            { label: 'Y', submenu: axisAlign('y') },
            { label: 'Z', submenu: axisAlign('z') },
            ...(selectedIds.length > 2
              ? [
                  { label: t('menu.distributeX'), onClick: () => distributeSelected('x'), separatorBefore: true },
                  { label: t('menu.distributeY'), onClick: () => distributeSelected('y') },
                  { label: t('menu.distributeZ'), onClick: () => distributeSelected('z') },
                ]
              : []),
          ]
        : [];
    return [
      { label: t('menu.rename'), onClick: () => beginRename(bodyId) },
      { label: t('menu.copy'), onClick: () => { if (!selectedIds.includes(bodyId)) selectObject(bodyId); copySelected(); } },
      { label: t('menu.duplicate'), onClick: () => { selectObject(bodyId); duplicateSelected(); } },
      ...((): ContextMenuItem[] => {
        const di = directBodies.findIndex((b) => b.id === bodyId);
        if (di === -1) return [];
        return [
          { label: t('menu.moveUp'), onClick: () => reorderBody(bodyId, 'up'), separatorBefore: true, disabled: di === 0 },
          { label: t('menu.moveDown'), onClick: () => reorderBody(bodyId, 'down'), disabled: di === directBodies.length - 1 },
        ];
      })(),
      {
        label: t('menu.transform'),
        separatorBefore: true,
        submenu: [
          { label: t('menu.move'), onClick: pre(() => setMoveDialogOpen(true)) },
          { label: t('menu.toOrigin'), onClick: pre(() => moveSelectionToOrigin()) },
          { label: t('menu.rotateDlg'), onClick: pre(() => setRotateDialogOpen(true)) },
          { label: t('menu.rotateX'), onClick: pre(() => rotateSelected('x', 90)), separatorBefore: true },
          { label: t('menu.rotateY'), onClick: pre(() => rotateSelected('y', 90)) },
          { label: t('menu.rotateZ'), onClick: pre(() => rotateSelected('z', 90)) },
          { label: t('menu.scaleDlg'), onClick: pre(() => setScaleDialogOpen(true)), separatorBefore: true },
          { label: t('menu.scaleUp'), onClick: pre(() => scaleSelected(2)) },
          { label: t('menu.scaleDown'), onClick: pre(() => scaleSelected(0.5)) },
          { label: t('menu.mirrorX'), onClick: () => mirror(bodyId, 'x'), separatorBefore: true },
          { label: t('menu.mirrorY'), onClick: () => mirror(bodyId, 'y') },
          { label: t('menu.mirrorZ'), onClick: () => mirror(bodyId, 'z') },
          { label: t('menu.flipX'), onClick: pre(() => flipSelected('x')), separatorBefore: true },
          { label: t('menu.flipY'), onClick: pre(() => flipSelected('y')) },
          { label: t('menu.flipZ'), onClick: pre(() => flipSelected('z')) },
        ],
      },
      {
        label: t('menu.pattern'),
        submenu: [
          { label: t('menu.linearPattern'), onClick: () => setPendingPattern({ bodyId, mode: 'linear' }) },
          { label: t('menu.circularPattern'), onClick: () => setPendingPattern({ bodyId, mode: 'circular' }) },
          { label: t('menu.gridPattern'), onClick: () => setPendingPattern({ bodyId, mode: 'grid' }) },
        ],
      },
      ...(align.length > 0 ? [{ label: t('menu.alignGroup'), submenu: align }] : []),
      ...(selectedIds.length >= 2
        ? [{
            label: t('menu.combine'),
            submenu: [
              { label: t('menu.union'), onClick: () => combineSelected('union') },
              { label: t('menu.subtract'), onClick: () => combineSelected('difference') },
              { label: t('menu.intersect'), onClick: () => combineSelected('intersect') },
              { label: t('menu.join'), onClick: () => joinSelected(), separatorBefore: true },
            ],
          }]
        : []),
      {
        label: t('menu.modify'),
        submenu: [
          { label: t('menu.splitX'), onClick: () => split(bodyId, 'x') },
          { label: t('menu.splitY'), onClick: () => split(bodyId, 'y') },
          { label: t('menu.splitZ'), onClick: () => split(bodyId, 'z') },
          { label: t('menu.hollow'), onClick: () => setHollowDialogBody(bodyId), separatorBefore: true },
          { label: t('menu.center'), onClick: () => apply(bodyId, centerBody), separatorBefore: true },
          { label: t('menu.convexHull'), onClick: () => apply(bodyId, (b) => convexHullBody(b)) },
          { label: t('menu.boundingBox'), onClick: () => { if (!selectedIds.includes(bodyId)) selectObject(bodyId); makeBoundingBoxOfSelection(); } },
          { label: t('menu.cleanup'), onClick: pre(() => weldSelected()) },
          { label: t('menu.transparency'), onClick: () => toggleBodyTransparency(bodyId) },
        ],
      },
      {
        label: t('menu.placement'),
        submenu: [
          { label: t('menu.layFlat'), onClick: () => apply(bodyId, layFlat) },
          { label: t('menu.seatOnBed'), onClick: () => apply(bodyId, (b) => seatOnBed(b)) },
          { label: t('menu.dropFloor'), onClick: pre(() => dropSelectedToFloor()) },
        ],
      },
      {
        label: t('menu.visibility'),
        submenu: [
          { label: t('menu.hide'), onClick: () => toggleBodyVisibility(bodyId) },
          { label: t('menu.isolate'), onClick: () => { selectObject(bodyId); isolateSelected(); } },
          ...(hiddenIds.length > 0 ? [{ label: t('menu.showAll'), onClick: () => showAllBodies() }] : []),
        ],
      },
      { label: t('menu.delete'), onClick: () => removeDirectBody(bodyId), separatorBefore: true, danger: true },
    ];
  };

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
            bodies.map((body) =>
              renaming?.id === body.id ? (
                <div key={body.id} className="w-full flex items-center gap-2 px-2 py-1">
                  <Box size={14} className="text-text-muted" />
                  <input
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') cancelRename();
                    }}
                    onBlur={() => commitRename()}
                    className="flex-1 min-w-0 px-1 py-0.5 bg-surface border border-accent rounded text-xs text-text-primary"
                  />
                </div>
              ) : (
                <div key={body.id} className="group flex items-center">
                  <button
                    onClick={(e) => handleRowClick(e, body.id)}
                    onDoubleClick={() => beginRename(body.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // Keep an existing multi-selection if right-clicking one of its members.
                      if (!selectedIds.includes(body.id)) selectObject(body.id);
                      setMenu({ x: e.clientX, y: e.clientY, bodyId: body.id });
                    }}
                    className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded text-xs text-left transition-colors
                      ${selectedIds.includes(body.id)
                        ? 'bg-accent/20 text-accent'
                        : 'text-text-secondary hover:bg-surface-hover'
                      } ${hiddenIds.includes(body.id) ? 'opacity-40' : ''}`}
                    role="treeitem"
                    aria-selected={selectedIds.includes(body.id)}
                    title={t('menu.rename')}
                  >
                    <Box size={14} style={{ color: `#${(body.color ?? 0x89b4fa).toString(16).padStart(6, '0')}` }} />
                    <span className="truncate">{body.name}</span>
                  </button>
                  <button
                    onClick={() => toggleBodyVisibility(body.id)}
                    className={`px-1 text-text-muted hover:text-text-primary transition-opacity ${hiddenIds.includes(body.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    aria-label={t(hiddenIds.includes(body.id) ? 'menu.show' : 'menu.hide')}
                    title={t(hiddenIds.includes(body.id) ? 'menu.show' : 'menu.hide')}
                  >
                    {hiddenIds.includes(body.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
              ),
            )
          )}
        </div>

        {/* Reference geometry section */}
        {(planes.length > 0 || axes.length > 0 || points.length > 0 || coordSystems.length > 0) && (
          <div className="border-t border-panel-border p-1">
            <p className="px-2 py-1 text-[10px] font-medium text-text-muted uppercase tracking-wider">
              {t('panel.referenceGeometry')}
            </p>
            {planes.map((p) => (
              <RefRow key={p.id} icon={<Frame size={12} />} name={p.name} onDelete={() => removePlane(p.id)} deleteLabel={t('menu.delete')} />
            ))}
            {axes.map((a) => (
              <RefRow key={a.id} icon={<Slash size={12} />} name={a.name} onDelete={() => removeAxis(a.id)} deleteLabel={t('menu.delete')} />
            ))}
            {points.map((p) => (
              <RefRow key={p.id} icon={<Dot size={12} />} name={p.name} onDelete={() => removePoint(p.id)} deleteLabel={t('menu.delete')} />
            ))}
            {coordSystems.map((c) => (
              <RefRow key={c.id} icon={<Axis3d size={12} />} name={c.name} onDelete={() => removeCoordinateSystem(c.id)} deleteLabel={t('menu.delete')} />
            ))}
          </div>
        )}

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

/** A reference-geometry row (datum plane/axis/point) with a hover delete button. */
function RefRow({ icon, name, onDelete, deleteLabel }: { icon: React.ReactNode; name: string; onDelete: () => void; deleteLabel: string }) {
  return (
    <div className="group w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-text-secondary hover:bg-surface-hover">
      <span className="text-text-muted">{icon}</span>
      <span className="truncate flex-1">{name}</span>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-danger transition-opacity"
        aria-label={`${deleteLabel}: ${name}`}
        title={deleteLabel}
      >
        <X size={12} />
      </button>
    </div>
  );
}
