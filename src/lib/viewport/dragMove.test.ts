import { describe, it, expect } from 'vitest';
import { formatDragDelta } from './dragMove';

describe('formatDragDelta', () => {
  it('formats whole millimetres without decimals', () => {
    expect(formatDragDelta({ x: 20, z: -10 })).toBe('Δ 20, -10 mm');
  });
  it('shows one decimal for fractional grid steps', () => {
    expect(formatDragDelta({ x: 2.5, z: 0 })).toBe('Δ 2.5, 0 mm');
  });
  it('renders negative zero as plain zero', () => {
    expect(formatDragDelta({ x: -0, z: 1e-12 })).toBe('Δ 0, 0 mm');
  });
});
