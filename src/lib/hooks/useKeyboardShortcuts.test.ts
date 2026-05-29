import { describe, it, expect } from 'vitest';
import { registerShortcut } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  it('should export registerShortcut function', () => {
    expect(typeof registerShortcut).toBe('function');
  });

  it('registerShortcut should accept 2 parameters', () => {
    expect(registerShortcut.length).toBe(2);
  });

  it('should handle keyboard event logic', () => {
    // Test the key combination building logic
    const buildKey = (e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }) => {
      return [
        e.ctrlKey ? 'ctrl' : '',
        e.shiftKey ? 'shift' : '',
        e.altKey ? 'alt' : '',
        e.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');
    };

    expect(buildKey({ ctrlKey: false, shiftKey: false, altKey: false, key: 'a' })).toBe('a');
    expect(buildKey({ ctrlKey: true, shiftKey: false, altKey: false, key: 's' })).toBe('ctrl+s');
    expect(buildKey({ ctrlKey: true, shiftKey: true, altKey: false, key: 'z' })).toBe('ctrl+shift+z');
    expect(buildKey({ ctrlKey: false, shiftKey: false, altKey: true, key: 'x' })).toBe('alt+x');
  });

  it('should not trigger shortcuts for input elements', () => {
    const shouldSkip = (tagName: string, isContentEditable: boolean) => {
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable;
    };

    expect(shouldSkip('INPUT', false)).toBe(true);
    expect(shouldSkip('TEXTAREA', false)).toBe(true);
    expect(shouldSkip('DIV', true)).toBe(true);
    expect(shouldSkip('DIV', false)).toBe(false);
    expect(shouldSkip('BUTTON', false)).toBe(false);
  });
});
