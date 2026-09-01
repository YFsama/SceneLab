import { describe, it, expect } from 'vitest';
import { translations } from '../i18n';

// Real coverage: the i18n catalog the panels render through must keep both
// locales in lockstep, and no key may be left untranslated. Previously this
// file asserted hook .length values, which proved nothing.

describe('i18n parity for UI strings', () => {
  it('en and zh expose identical key sets', () => {
    expect(Object.keys(translations.en!).sort()).toEqual(Object.keys(translations.zh!).sort());
  });

  it('no placeholder translations left in either locale', () => {
    for (const [locale, map] of Object.entries(translations)) {
      for (const [key, value] of Object.entries(map!)) {
        expect(value, `${locale}:${key}`).not.toMatch(/^TODO/i);
        expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('both locales resolve the same key to a concrete string', () => {
    expect(translations.en!['toolbar.model']).toBe('Model');
    expect(translations.zh!['toolbar.model']).toBe('建模');
  });
});
