import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/app';
import { searchCommands, runCommand } from '../../lib/commands/registry';

/**
 * SolidWorks-style command search: open with Ctrl/Cmd+K, type to filter every
 * registered command, ↑/↓ to move, Enter to run, Esc to close. The inner panel
 * mounts fresh each time it opens, so its query/selection reset naturally.
 */
export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const setOpen = useStore((s) => s.setCommandPaletteOpen);
  if (!open) return null;
  return <Palette onClose={() => setOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchCommands(query).slice(0, 50), [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const choose = (idx: number) => {
    const cmd = results[idx];
    if (cmd) {
      onClose();
      runCommand(cmd.id);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] bg-black/40" onMouseDown={onClose}>
      <div
        className="w-[32rem] max-w-[90vw] rounded-lg bg-panel border border-panel-border shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
          }}
          placeholder="Type a command…"
          className="w-full px-4 py-3 bg-surface text-text-primary text-sm outline-none border-b border-panel-border"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-xs text-text-muted">No matching commands</li>
          ) : (
            results.map((cmd, i) => (
              <li key={cmd.id}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left text-sm
                    ${i === active ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:bg-surface-hover'}`}
                >
                  <span className="truncate">
                    {cmd.category && <span className="text-text-muted">{cmd.category} · </span>}
                    {cmd.label}
                  </span>
                  {cmd.shortcut && <span className="text-[10px] font-mono text-text-muted shrink-0">{cmd.shortcut}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
