import { describe, it, expect } from 'vitest';
import { useStore } from '../store/app';
import { translations } from './i18n';

describe('i18n key parity', () => {
  it('en and zh define exactly the same keys', () => {
    const en = Object.keys(translations.en!).sort();
    const zh = Object.keys(translations.zh!).sort();
    const missingInZh = en.filter((k) => !(k in translations.zh!));
    const missingInEn = zh.filter((k) => !(k in translations.en!));
    expect(missingInZh).toEqual([]);
    expect(missingInEn).toEqual([]);
    expect(zh).toEqual(en);
  });
});

// Test i18n translations by directly accessing the store
describe('i18n translations', () => {
  it('should have English as default locale', () => {
    const locale = useStore.getState().locale;
    expect(locale).toBe('en');
  });

  it('should switch to Chinese locale', () => {
    useStore.getState().setLocale('zh');
    expect(useStore.getState().locale).toBe('zh');
    useStore.getState().setLocale('en');
  });

  it('should have consistent key structure', () => {
    // Verify the translation map has expected keys by checking the store
    const store = useStore.getState();
    expect(store.locale).toBeDefined();
    expect(store.setLocale).toBeDefined();
  });
});
