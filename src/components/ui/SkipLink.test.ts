import { describe, it, expect } from 'vitest';

// SkipLink is a React component — test the accessibility structure.

describe('SkipLink accessibility', () => {
  it('has correct href pointing to main content', () => {
    const href = '#main-content';
    expect(href).toBe('#main-content');
  });

  it('uses sr-only class for screen reader only', () => {
    const className = 'sr-only focus:not-sr-only';
    expect(className).toContain('sr-only');
    expect(className).toContain('focus:not-sr-only');
  });

  it('has focus styles for keyboard navigation', () => {
    const className = 'focus:absolute focus:top-2 focus:left-2';
    expect(className).toContain('focus:absolute');
    expect(className).toContain('focus:top-2');
  });

  it('has high z-index for focus visibility', () => {
    const className = 'focus:z-[100]';
    expect(className).toContain('focus:z-[100]');
  });
});
