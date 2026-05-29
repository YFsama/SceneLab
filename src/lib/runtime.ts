// Tauri detection + native command bridge
// Detects if running inside Tauri shell vs browser

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>;
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI__ !== undefined;
}

export async function callNative(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!isTauri()) {
    throw new Error(`Cannot call native command "${cmd}" outside Tauri`);
  }
  // Dynamic import only available inside Tauri
  const mod = await import(/* @vite-ignore */ '@tauri-apps/api/core' as string);
  return mod.invoke(cmd, args);
}
