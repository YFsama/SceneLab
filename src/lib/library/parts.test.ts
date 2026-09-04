import { describe, it, expect } from 'vitest';
import { LIBRARY_PARTS, LIBRARY_CATEGORIES, findLibraryPart, searchLibraryParts } from './parts';
import { computeVolume, computeBoundingBox } from '../geometry';
import { translations } from '../i18n';

describe('parts library catalog', () => {
  it('has a name in both locales for every part', () => {
    for (const p of LIBRARY_PARTS) {
      expect(translations.en![`part.${p.id}`], `en missing part.${p.id}`).toBeTruthy();
      expect(translations.zh![`part.${p.id}`], `zh missing part.${p.id}`).toBeTruthy();
    }
  });

  it('every part id is unique', () => {
    const ids = LIBRARY_PARTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every category id is known', () => {
    const known = new Set(LIBRARY_CATEGORIES.map((c) => c.id));
    for (const p of LIBRARY_PARTS) expect(known.has(p.category)).toBe(true);
  });

  it('builds every part into a positive-volume body with a finite bbox', () => {
    for (const p of LIBRARY_PARTS) {
      const body = p.build();
      const bb = computeBoundingBox(body);
      const size = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
      expect(Number.isFinite(size.x) && Number.isFinite(size.y) && Number.isFinite(size.z), p.id).toBe(true);
      expect(size.x, `${p.id} width`).toBeGreaterThan(0);
      expect(size.y, `${p.id} height`).toBeGreaterThan(0);
      expect(size.z, `${p.id} depth`).toBeGreaterThan(0);
      expect(computeVolume(body), `${p.id} volume`).toBeGreaterThan(0);
    }
  });

  it('sits every part on the build plate (min Y ≈ 0)', () => {
    for (const p of LIBRARY_PARTS) {
      const bb = computeBoundingBox(p.build());
      expect(bb.min.y, `${p.id} should rest on the bed`).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});

describe('findLibraryPart', () => {
  it('finds by exact id', () => {
    expect(findLibraryPart('gear')?.category).toBe('mechanical');
  });
  it('returns undefined for unknown ids', () => {
    expect(findLibraryPart('warp-drive')).toBeUndefined();
  });
});

describe('searchLibraryParts', () => {
  it('empty query returns everything', () => {
    expect(searchLibraryParts('')).toHaveLength(LIBRARY_PARTS.length);
  });
  it('matches English keywords', () => {
    const ids = searchLibraryParts('nut').map((p) => p.id);
    expect(ids).toContain('hexNut');
  });
  it('matches Chinese keywords', () => {
    const ids = searchLibraryParts('齿轮').map((p) => p.id);
    expect(ids).toContain('gear');
    expect(ids).not.toContain('plate');
  });
  it('matches the spec string', () => {
    const ids = searchLibraryParts('m8').map((p) => p.id);
    expect(ids).toContain('hexNut');
    expect(ids).toContain('holeM8');
  });
  it('is case-insensitive', () => {
    expect(searchLibraryParts('GEAR').map((p) => p.id)).toContain('gear');
  });
  it('returns an empty array for gibberish', () => {
    expect(searchLibraryParts('qqqq')).toEqual([]);
  });
});
