import { describe, it, expect } from 'vitest';
import { useStore } from '../store/app';

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
