import { describe, it, expect } from 'vitest';
import { pickCycle, distinctInOrder } from './pickCycle';

describe('distinctInOrder', () => {
  it('keeps the first occurrence of each id, dropping undefined', () => {
    expect(distinctInOrder(['a', undefined, 'b', 'a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when nothing is under the cursor', () => {
    expect(distinctInOrder([undefined, undefined])).toEqual([]);
  });
});

describe('pickCycle', () => {
  it('returns nothing when no bodies are under the cursor', () => {
    expect(pickCycle([], [])).toBeUndefined();
  });

  it('selects the front-most body when nothing relevant is selected', () => {
    expect(pickCycle(['a', 'b', 'c'], [])).toBe('a');
    expect(pickCycle(['a', 'b', 'c'], ['z'])).toBe('a');
  });

  it('advances to the body behind the current single selection', () => {
    expect(pickCycle(['a', 'b', 'c'], ['a'])).toBe('b');
    expect(pickCycle(['a', 'b', 'c'], ['b'])).toBe('c');
  });

  it('wraps back to the front after the last body', () => {
    expect(pickCycle(['a', 'b', 'c'], ['c'])).toBe('a');
  });

  it('falls back to the front-most with a multi-selection', () => {
    expect(pickCycle(['a', 'b', 'c'], ['a', 'b'])).toBe('a');
  });

  it('handles a single body under cursor', () => {
    expect(pickCycle(['a'], [])).toBe('a');
    expect(pickCycle(['a'], ['a'])).toBe('a');
  });

  it('handles two bodies under cursor', () => {
    expect(pickCycle(['a', 'b'], ['a'])).toBe('b');
    expect(pickCycle(['a', 'b'], ['b'])).toBe('a');
  });

  it('selected body not in ordered list falls back to front', () => {
    expect(pickCycle(['a', 'b', 'c'], ['z'])).toBe('a');
  });
});
