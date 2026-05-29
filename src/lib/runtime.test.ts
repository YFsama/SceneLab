import { describe, it, expect } from 'vitest';
import { isTauri } from './runtime';

describe('runtime', () => {
  it('should return false when __TAURI__ is not defined', () => {
    // In test environment, __TAURI__ is not defined
    expect(isTauri()).toBe(false);
  });

  it('should return true when __TAURI__ is defined', () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {};
    expect(isTauri()).toBe(true);
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });
});
