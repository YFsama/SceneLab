import { describe, it, expect } from 'vitest';
import { useEscapeClose } from './useEscapeClose';
import { useFocusRestore } from './useFocusRestore';

describe('hooks module exports', () => {
  it('should export useEscapeClose', () => {
    expect(typeof useEscapeClose).toBe('function');
  });

  it('should export useFocusRestore', () => {
    expect(typeof useFocusRestore).toBe('function');
  });

  it('useEscapeClose should accept 2 parameters', () => {
    expect(useEscapeClose.length).toBe(2);
  });

  it('useFocusRestore should accept 0 parameters', () => {
    expect(useFocusRestore.length).toBe(0);
  });
});
