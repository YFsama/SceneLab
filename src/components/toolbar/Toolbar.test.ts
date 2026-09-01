import { describe, it, expect } from 'vitest';
import { WORKSPACES } from './workspaces';
import { translations } from '../../lib/i18n';

// The workspace switcher is data-driven — test the real exported table so the
// component cannot drift from it (previously this test re-declared the array).

describe('Toolbar workspace table', () => {
  it('has exactly sketch, model, drawing, cam', () => {
    expect(WORKSPACES.map((w) => w.mode)).toEqual(['sketch', 'model', 'drawing', 'cam']);
  });

  it('does not offer the removed assembly workspace', () => {
    expect(WORKSPACES.map((w) => w.mode)).not.toContain('assembly');
  });

  it('keeps the S/M/D/C shortcuts', () => {
    expect(WORKSPACES.map((w) => w.shortcut)).toEqual(['S', 'M', 'D', 'C']);
  });

  it('every workspace has a label in both locales', () => {
    for (const { mode } of WORKSPACES) {
      const key = `toolbar.${mode}`;
      expect(translations.en?.[key as never]).toBeTruthy();
      expect(translations.zh?.[key as never]).toBeTruthy();
    }
  });
});
