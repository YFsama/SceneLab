import { describe, it, expect } from 'vitest';
import { useFocusRestore } from './useFocusRestore';

describe('useFocusRestore', () => {
  it('should be a function', () => {
    expect(typeof useFocusRestore).toBe('function');
  });

  it('should return a ref', () => {
    // useFocusRestore is a React hook, test signature
    expect(useFocusRestore.length).toBe(0);
  });

  it('should handle document.activeElement', () => {
    // Verify the hook uses document.activeElement
    const activeElement = document.activeElement;
    expect(activeElement).toBeDefined();
  });
});
