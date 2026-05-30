import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Render a divider above this item. */
  separatorBefore?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A floating right-click context menu anchored at viewport coordinates (x, y).
 * Closes on outside click, Escape, scroll, or after an item is chosen.
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
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : x) - 200);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : y) - items.length * 30 - 8);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-44 py-1 rounded-md bg-panel border border-panel-border shadow-xl text-xs"
      style={{ left, top }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="my-1 h-px bg-panel-border" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full text-left px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed
              ${item.danger ? 'text-error hover:bg-error/10' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
