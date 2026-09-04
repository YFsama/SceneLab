import { describe, it, expect } from 'vitest';
import { LIBRARY_PARTS, filterLibraryParts } from '../../lib/library/parts';
import { PART_ICONS } from './partsIconMap';

// PartsLibrary is a thin gallery over the pure catalog + the store's
// insertLibraryPart (covered in store/library.test.ts). Here: the filter the
// panel renders with, and the icon map staying in sync with the catalog.

describe('PartsLibrary panel', () => {
  it('category filter narrows the pool, search narrows within it', () => {
    const mechanical = filterLibraryParts('', 'mechanical');
    expect(mechanical.length).toBeGreaterThan(0);
    for (const p of mechanical) expect(p.category).toBe('mechanical');
    const gears = filterLibraryParts('gear', 'mechanical');
    expect(gears.map((p) => p.id)).toEqual(['gear']);
  });

  it('all + empty query yields the full catalog', () => {
    expect(filterLibraryParts('', 'all')).toHaveLength(LIBRARY_PARTS.length);
  });

  it('every catalog part has an icon mapping', () => {
    for (const p of LIBRARY_PARTS) {
      expect(PART_ICONS[p.id], `missing icon for ${p.id}`).toBeDefined();
    }
  });
});
