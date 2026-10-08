import { describe, it, expect, afterEach } from 'vitest';
import {
  isTauri,
  getOS,
  getPlatform,
  sniffOSForTest,
  MOD_KEY_LABEL,
  ALT_KEY_LABEL,
  platformizeShortcut,
} from './runtime';

// Windows/macOS/Linux UA samples (post-UA-freeze Chromium keeps the frozen
// "platform + browser" tail; Safari/Firefox carry the classic full tokens).
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';

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

describe('sniffOSForTest matrix', () => {
  it('classifies userAgentData.platform first, even when the UA string disagrees', () => {
    // Chromium freezes the UA itself, so userAgentData.platform is the truth.
    expect(sniffOSForTest({ userAgent: WIN_UA, userAgentData: { platform: 'macOS' } })).toBe('macos');
    expect(sniffOSForTest({ userAgent: MAC_UA, userAgentData: { platform: 'Windows' } })).toBe('windows');
  });

  it('falls back to navigator.platform', () => {
    expect(sniffOSForTest({ userAgent: 'opaque', platform: 'MacIntel' })).toBe('macos');
    expect(sniffOSForTest({ userAgent: 'opaque', platform: 'Win32' })).toBe('windows');
    expect(sniffOSForTest({ userAgent: 'opaque', platform: 'Linux x86_64' })).toBe('linux');
    // ChromeOS surfaces as 'Linux armv8l' / 'Linux x86_64' via userAgentData.
    expect(sniffOSForTest({ userAgent: 'opaque', platform: 'Linux armv8l' })).toBe('linux');
  });

  it('falls back to the userAgent string when platform is absent', () => {
    expect(sniffOSForTest({ userAgent: WIN_UA })).toBe('windows');
    expect(sniffOSForTest({ userAgent: MAC_UA })).toBe('macos');
    expect(sniffOSForTest({ userAgent: LINUX_UA })).toBe('linux');
    // "Mac OS X" without the Macintosh token still matches.
    expect(sniffOSForTest({ userAgent: 'Mozilla/5.0 (Mac OS X 14) AppleWebKit/605.1.15' })).toBe('macos');
  });

  it('returns unknown when nothing identifies the OS', () => {
    expect(sniffOSForTest({ userAgent: 'curl/8.4.0' })).toBe('unknown');
    expect(sniffOSForTest({ userAgent: '' })).toBe('unknown');
  });
});

describe('getPlatform (web vs Tauri)', () => {
  const w = window as unknown as Record<string, unknown>;

  afterEach(() => {
    delete w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
  });

  it('is web outside Tauri regardless of the OS', () => {
    expect(getPlatform()).toBe('web');
  });

  it('mirrors the sniffed OS inside Tauri (v2 internals and v1 global)', () => {
    w.__TAURI_INTERNALS__ = {};
    expect(getPlatform()).toBe(getOS() === 'unknown' ? 'web' : getOS());
    delete w.__TAURI_INTERNALS__;
    w.__TAURI__ = {};
    expect(getPlatform()).toBe(getOS() === 'unknown' ? 'web' : getOS());
  });
});

describe('platform shortcut labels', () => {
  it('expose the host-appropriate symbols (⌘/⌥ on mac, Ctrl/Alt elsewhere)', () => {
    expect(MOD_KEY_LABEL).toBe(getOS() === 'macos' ? '⌘' : 'Ctrl');
    expect(ALT_KEY_LABEL).toBe(getOS() === 'macos' ? '⌥' : 'Alt');
  });

  it('platformizeShortcut swaps whole-word modifiers on macOS', () => {
    expect(platformizeShortcut('Ctrl+Shift+Z', 'macos')).toBe('⌘+Shift+Z');
    expect(platformizeShortcut('Ctrl+X / C / V', 'macos')).toBe('⌘+X / C / V');
    expect(platformizeShortcut('Alt+LMB drag', 'macos')).toBe('⌥+LMB drag');
    expect(platformizeShortcut('Alt / Shift + arrows', 'macos')).toBe('⌥ / Shift + arrows');
  });

  it('keeps Ctrl/Alt on non-mac platforms and leaves modifier-free combos alone', () => {
    expect(platformizeShortcut('Ctrl+Shift+Z', 'windows')).toBe('Ctrl+Shift+Z');
    expect(platformizeShortcut('Ctrl+Shift+Z', 'linux')).toBe('Ctrl+Shift+Z');
    expect(platformizeShortcut('Alt+LMB drag', 'linux')).toBe('Alt+LMB drag');
    expect(platformizeShortcut('Shift+F', 'macos')).toBe('Shift+F');
    expect(platformizeShortcut('← ↑ → ↓ / PgUp / PgDn', 'macos')).toBe('← ↑ → ↓ / PgUp / PgDn');
  });

  it('matches only whole words — no case folding, no substring hits', () => {
    // Lowercase prose and embedded occurrences stay untouched.
    expect(platformizeShortcut('press ctrl now', 'macos')).toBe('press ctrl now');
    expect(platformizeShortcut('CtrlX', 'macos')).toBe('CtrlX');
    expect(platformizeShortcut('Altery', 'macos')).toBe('Altery');
    // Both modifiers in one combo, order preserved.
    expect(platformizeShortcut('Ctrl+Alt+P', 'macos')).toBe('⌘+⌥+P');
    expect(platformizeShortcut('Ctrl+Alt+P', 'windows')).toBe('Ctrl+Alt+P');
  });

  it('defaults the os to the host (agrees with the exported labels)', () => {
    expect(platformizeShortcut('Ctrl+K')).toBe(
      getOS() === 'macos' ? '⌘+K' : 'Ctrl+K',
    );
  });
});
