// Tauri detection + native command bridge
// Detects if running inside the Tauri shell vs a plain browser.

declare global {
  interface Window {
    /** Tauri v1 global (only set with withGlobalTauri). */
    __TAURI__?: Record<string, unknown>;
    /** Tauri v2 always injects this, regardless of withGlobalTauri. */
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined)
  );
}

/** Host operating system as best the user agent can tell ('unknown' when it can't). */
export type OS = 'windows' | 'macos' | 'linux' | 'unknown';

interface NavigatorLike {
  userAgent: string;
  platform?: string;
  userAgentData?: { platform?: string };
}

function sniffOS(nav: NavigatorLike): OS {
  // Chromium exposes the OS via userAgentData.platform (userAgent itself is
  // frozen there); Safari/Firefox still carry it in platform + userAgent.
  const platform = `${nav.userAgentData?.platform ?? nav.platform ?? ''}`;
  if (/mac/i.test(platform)) return 'macos';
  if (/win/i.test(platform)) return 'windows';
  if (/linux|cros/i.test(platform)) return 'linux';
  if (/Macintosh|Mac OS X/i.test(nav.userAgent)) return 'macos';
  if (/Windows/i.test(nav.userAgent)) return 'windows';
  if (/Linux|X11/i.test(nav.userAgent)) return 'linux';
  return 'unknown';
}

/**
 * The host OS, sniffed from the navigator — works in the browser AND inside
 * Tauri (the webview UA mirrors the OS). Use for platform-flavoured UI
 * (⌘ vs Ctrl shortcut labels, copy like "right-click").
 */
export function getOS(): OS {
  if (typeof navigator === 'undefined') return 'unknown';
  return sniffOS(navigator as NavigatorLike);
}

/** Exposed for tests: the sniffing matrix against synthetic navigators. */
export function sniffOSForTest(nav: NavigatorLike): OS {
  return sniffOS(nav);
}

/** The OS's primary command-modifier label for shortcut display (⌘ vs Ctrl). */
export const MOD_KEY_LABEL: string = getOS() === 'macos' ? '⌘' : 'Ctrl';
/** The OS's Alt-modifier label for shortcut display (⌥ vs Alt). */
export const ALT_KEY_LABEL: string = getOS() === 'macos' ? '⌥' : 'Alt';

/**
 * Localise a shortcut combo string for display: whole-word `Ctrl`/`Alt` tokens
 * become the platform's labels (macOS: 'Ctrl+Shift+Z' → '⌘+Shift+Z'). Other
 * text passes through untouched — 'Alt+LMB drag' only swaps the modifier, and
 * lowercase/substring occurrences ('ctrl' in prose) never match. `os` defaults
 * to the host so callers pass just the combo.
 */
export function platformizeShortcut(combo: string, os: OS = getOS()): string {
  const mod = os === 'macos' ? '⌘' : 'Ctrl';
  const alt = os === 'macos' ? '⌥' : 'Alt';
  return combo.replace(/\bCtrl\b/g, mod).replace(/\bAlt\b/g, alt);
}

/** Where the app is running: a Tauri desktop shell or a plain web page. */
export type Platform = 'windows' | 'macos' | 'linux' | 'web';

/** The runtime platform for diagnostics display ('web' outside Tauri). */
export function getPlatform(): Platform {
  if (!isTauri()) return 'web';
  const os = getOS();
  return os === 'unknown' ? 'web' : os;
}

export async function callNative(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!isTauri()) {
    throw new Error(`Cannot call native command "${cmd}" outside Tauri`);
  }
  // Imported lazily so browser-only builds never pull in the Tauri runtime.
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}
