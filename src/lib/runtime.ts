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
