import { describe, it, expect } from 'vitest';
import { keyToView } from './viewKeys';

describe('keyToView', () => {
  it('maps 1-4 to the standard views', () => {
    expect(keyToView('1')).toBe('front');
    expect(keyToView('2')).toBe('top');
    expect(keyToView('3')).toBe('right');
    expect(keyToView('4')).toBe('iso');
  });

  it('returns null for other keys', () => {
    expect(keyToView('5')).toBeNull();
    expect(keyToView('a')).toBeNull();
    expect(keyToView('')).toBeNull();
  });
});
