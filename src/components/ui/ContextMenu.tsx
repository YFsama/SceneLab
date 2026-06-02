import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick?: () => void;
  /** Nested items shown in a flyout; when present, the item is a submenu. */
  submenu?: ContextMenuItem[];
  /** Render a divider above this item. */
  separatorBefore?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A submenu flyout that opens to the right by default but flips to the left if
 * it would overflow the viewport's right edge — so deeply-nested menus near the
 * screen edge stay on-screen (SolidWorks-style).
 */
function Flyout({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.getBoundingClientRect().right > window.innerWidth) setSide('left');
  }, []);
  return (
    <div ref={ref} className={`absolute top-0 z-10 ${side === 'right' ? 'left-full -ml-1' : 'right-full -mr-1'}`}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}

/** Recursively rendered list of menu items, with hover flyouts for submenus. */
function MenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <div className="min-w-44 py-1 rounded-md bg-panel border border-panel-border shadow-xl text-xs" role="menu">
      {items.map((item, i) => (
        <div key={i} className="relative" onMouseEnter={() => setOpenIdx(item.submenu ? i : null)}>
          {item.separatorBefore && <div className="my-1 h-px bg-panel-border" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => { if (item.submenu) { setOpenIdx(i); return; } item.onClick?.(); onClose(); }}
            className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed
              ${item.danger ? 'text-error hover:bg-error/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
          >
            <span>{item.label}</span>
            {item.submenu && <span className="text-text-muted">▸</span>}
          </button>
          {item.submenu && openIdx === i && (
            <Flyout items={item.submenu} onClose={onClose} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A floating right-click context menu anchored at viewport coordinates (x, y).
 * Items may carry a `submenu` for grouped flyouts. Closes on outside click,
 * Escape, scroll, or after a leaf item is chosen.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen near the edges.
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : x) - 220);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : y) - items.length * 30 - 8);

  return (
    <div ref={ref} className="fixed z-[100]" style={{ left, top }}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
