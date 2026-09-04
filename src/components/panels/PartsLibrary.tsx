import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { LIBRARY_PARTS, LIBRARY_CATEGORIES, filterLibraryParts, type PartCategoryId, type LibraryPart } from '../../lib/library/parts';
import { PART_ICONS } from './partsIconMap';
import { Shapes, Search, X, Square } from 'lucide-react';

function PartCard({ part, onInsert }: { part: LibraryPart; onInsert: (id: string) => void }) {
  const { t } = useT();
  const Icon = PART_ICONS[part.id] ?? Square;
  return (
    <button
      onClick={() => onInsert(part.id)}
      className="flex flex-col items-center gap-1 px-1 py-2 rounded-md border border-transparent hover:border-panel-border hover:bg-surface-hover transition-colors group"
      aria-label={`${t(`part.${part.id}`)} (${part.spec})`}
      title={`${t(`part.${part.id}`)} · ${part.spec}`}
    >
      <Icon size={22} className="text-text-secondary group-hover:text-accent transition-colors" />
      <span className="text-[11px] text-text-primary leading-tight text-center truncate w-full">
        {t(`part.${part.id}`)}
      </span>
      <span className="text-[10px] text-text-muted font-mono">{part.spec}</span>
    </button>
  );
}

/** Beginner quick-insert gallery (TinkerCAD-style shape panel): search,
 *  category filter, recently used, one click to drop a part on the plate. */
export function PartsLibrary() {
  const { t } = useT();
  const show = useStore((s) => s.showPartsLibrary);
  const toggle = useStore((s) => s.togglePartsLibrary);
  const insert = useStore((s) => s.insertLibraryPart);
  const recentPartIds = useStore((s) => s.recentPartIds);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<PartCategoryId | 'all'>('all');

  if (!show) return null;

  const filtered = filterLibraryParts(query, category);
  const recent = query === '' && category === 'all'
    ? recentPartIds
        .map((id) => LIBRARY_PARTS.find((p) => p.id === id))
        .filter((p): p is LibraryPart => !!p)
        .slice(0, 4)
    : [];

  return (
    <aside
      className="w-60 bg-panel border-r border-panel-border flex flex-col"
      aria-label={t('library.title')}
    >
      <div className="px-3 py-2 border-b border-panel-border flex items-center gap-2">
        <Shapes size={16} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary flex-1">{t('library.title')}</h2>
        <button
          onClick={toggle}
          className="text-text-muted hover:text-text-primary"
          aria-label={t('library.close')}
          title={t('library.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-2 space-y-2 border-b border-panel-border">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            aria-label={t('library.search')}
            className="w-full pl-6 pr-2 py-1 bg-surface border border-panel-border rounded text-xs text-text-primary placeholder:text-text-muted"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('library.title')}>
          {LIBRARY_CATEGORIES.map(({ id, labelKey }) => (
            <button
              key={id}
              role="tab"
              aria-selected={category === id}
              onClick={() => setCategory(id)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                category === id
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {recent.length > 0 && (
          <section className="mb-2">
            <h3 className="px-1 pb-1 text-[10px] font-medium text-text-muted uppercase tracking-wider">
              {t('library.recent')}
            </h3>
            <div className="grid grid-cols-2 gap-1">
              {recent.map((p) => <PartCard key={p.id} part={p} onInsert={insert} />)}
            </div>
          </section>
        )}
        {filtered.length === 0 ? (
          <p className="text-xs text-text-muted p-2">{t('library.empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {filtered.map((p) => <PartCard key={p.id} part={p} onInsert={insert} />)}
          </div>
        )}
      </div>

      <p className="px-3 py-1.5 border-t border-panel-border text-[10px] text-text-muted">
        {t('library.hint')}
      </p>
    </aside>
  );
}
