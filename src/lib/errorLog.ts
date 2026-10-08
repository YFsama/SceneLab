// Persistent, privacy-safe error log + diagnostics report builder.
// Zero React: consumed by the ErrorBoundary, the DiagnosticsDialog, ToastHost
// and the global capture installed in main.tsx. Nothing here ever SENDS data
// anywhere — reports leave the app only through explicit user action
// (copy / save / open the pre-filled feedback page). See docs/error-reporting.md.

// Injected from package.json by vite/vitest (see src/vite-env.d.ts).
declare const __APP_VERSION__: string;

import { getPlatform, getOS } from './runtime';
import { recentCommands, commandLabel } from './commands/registry';
import { useStore } from '../store/app';

export type ErrorKind = 'error' | 'rejection' | 'react';

export interface ErrorEntry {
  id: number;
  /** Epoch ms. */
  ts: number;
  kind: ErrorKind;
  message: string;
  stack?: string;
  /** Where it came from (e.g. "app.tsx:12" for window errors, the first
   *  component-stack line for React boundary catches). */
  source?: string;
}

const STORAGE_KEY = 'scenelab.errorlog';
/** In-memory ring buffer size. */
const MEMORY_CAP = 100;
/** How many of the newest entries survive a reload in localStorage. */
const PERSIST_CAP = 30;
/** Keep a single pathological message/stack from blowing the 5 KB budget of
 *  a GitHub issue body or the localStorage row. */
const MESSAGE_CAP = 2000;
const STACK_CAP = 4000;

// Oldest first; newest is entries[entries.length - 1].
let entries: ErrorEntry[] = [];
let nextId = 1;

// --- storage helpers (sandboxed iframes / disabled storage can throw) ------

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or unavailable — silently degrade to memory-only logging.
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function isEntry(v: unknown): v is ErrorEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<ErrorEntry>;
  return typeof e.id === 'number' && typeof e.ts === 'number' &&
    (e.kind === 'error' || e.kind === 'rejection' || e.kind === 'react') &&
    typeof e.message === 'string';
}

/** Restore persisted entries at module load so the diagnostics dialog sees
 *  errors from before a reload (a crash-reload loop is exactly when that
 *  matters). Corrupt data degrades to an empty log. */
function restore(): void {
  const raw = safeGet(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const valid = parsed.filter(isEntry).slice(-MEMORY_CAP);
    entries = valid;
    nextId = valid.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  } catch {
    entries = [];
  }
}
restore();

function persist(): void {
  safeSet(STORAGE_KEY, JSON.stringify(entries.slice(-PERSIST_CAP)));
}

// --- core API ----------------------------------------------------------------

/** Record an error. Returns the stored entry (id/ts assigned). */
export function recordError(
  kind: ErrorKind,
  message: string,
  stack?: string,
  source?: string,
): ErrorEntry {
  const entry: ErrorEntry = {
    id: nextId++,
    ts: Date.now(),
    kind,
    message: String(message).slice(0, MESSAGE_CAP),
  };
  const trimmedStack = stack?.trim();
  if (trimmedStack) entry.stack = trimmedStack.slice(0, STACK_CAP);
  if (source) entry.source = String(source).slice(0, 200);

  entries.push(entry);
  if (entries.length > MEMORY_CAP) entries.splice(0, entries.length - MEMORY_CAP);
  persist();
  return entry;
}

/** The most recent errors, NEWEST first. */
export function getRecentErrors(limit = 20): ErrorEntry[] {
  return entries.slice(-limit).reverse();
}

/** Clear the in-memory log AND the persisted copy. */
export function clearErrors(): void {
  entries = [];
  safeRemove(STORAGE_KEY);
}

/** Tests: wipe memory + storage so suites are isolated. Does NOT touch the
 *  global capture listeners (tests uninstall those themselves). */
export function resetErrorLogForTest(): void {
  entries = [];
  nextId = 1;
  safeRemove(STORAGE_KEY);
}

/** Normalize a rejection reason (Error / string / anything) to message+stack. */
function normalizeReason(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message || String(reason), stack: reason.stack };
  }
  if (typeof reason === 'string') return { message: reason };
  if (reason === null || reason === undefined) return { message: String(reason) };
  try {
    return { message: JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

// --- global capture ----------------------------------------------------------

let uninstallCapture: (() => void) | null = null;

/**
 * Capture uncaught window errors and unhandled promise rejections into the
 * error log. Idempotent: a second call returns the first install's uninstall
 * function (no duplicate listeners). Returns a no-op outside a window (SSR /
 * node).
 */
export function installGlobalErrorCapture(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (uninstallCapture) return uninstallCapture;

  const onError = (ev: Event): void => {
    const e = ev as ErrorEvent;
    const src = e.filename ? `${e.filename}${e.lineno ? `:${e.lineno}` : ''}` : undefined;
    // Real ErrorEvents carry the Error object (with its stack); some synthetic
    // dispatches only give the plain message string.
    if (e.error && typeof e.error === 'object') {
      const err = e.error as { message?: string; stack?: string };
      recordError('error', err.message || String(e.error), err.stack, src);
    } else if (typeof e.message === 'string' && e.message.length > 0) {
      recordError('error', e.message, undefined, src);
    } else {
      recordError('error', 'Unknown window error', undefined, src);
    }
  };

  const onRejection = (ev: Event): void => {
    const { message, stack } = normalizeReason((ev as PromiseRejectionEvent).reason);
    recordError('rejection', message, stack);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  uninstallCapture = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    uninstallCapture = null;
  };
  return uninstallCapture;
}

// --- formatting --------------------------------------------------------------

/** One entry as plain text: `[ISO] kind: message` plus stack/source lines. */
export function formatErrorEntry(e: ErrorEntry): string {
  const head = `[${new Date(e.ts).toISOString()}] ${e.kind}: ${e.message}`;
  const parts = [head];
  if (e.stack) parts.push(e.stack);
  if (e.source) parts.push(`(source: ${e.source})`);
  return parts.join('\n');
}

/**
 * The full plain-text diagnostics report (version, platform, settings,
 * viewport, recent commands, recent errors). Contains NO model/project data.
 * The store is read lazily at call time — never during module evaluation —
 * because this module loads before the store graph is guaranteed complete.
 */
export function buildDiagnosticsReport(): string {
  let locale = 'unknown';
  let theme = 'unknown';
  try {
    const st = useStore.getState();
    locale = st.locale;
    theme = st.theme;
  } catch {
    // Store not initialized yet — report without settings.
  }

  const viewport = typeof window !== 'undefined'
    ? `${window.innerWidth}x${window.innerHeight}@${Math.round(window.devicePixelRatio * 100) / 100}`
    : 'unknown';
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  const commands = recentCommands(8).map((c) => `- ${commandLabel(c)}`);
  const errors = getRecentErrors(20);

  const lines: string[] = [
    'SceneLab diagnostics',
    '=====================',
    `Version: ${__APP_VERSION__}`,
    `Generated: ${new Date().toISOString()}`,
    `Platform: ${getPlatform()} (${getOS()})`,
    `User agent: ${userAgent}`,
    `Locale: ${locale}`,
    `Theme: ${theme}`,
    `Viewport: ${viewport}`,
    '',
    'Recent commands:',
    ...(commands.length > 0 ? commands : ['- (none)']),
    '',
    `Recent errors (${errors.length}):`,
    ...(errors.length > 0 ? errors.map(formatErrorEntry) : ['- (none)']),
  ];
  return lines.join('\n');
}

/**
 * Clamp a report for the GitHub issue-URL query param. 3000 raw chars ≈ up
 * to ~6 KB once URL-encoded (newlines → %0A etc.), staying inside GitHub's
 * cap; the full report is on the clipboard regardless.
 */
export function truncateForIssue(text: string, max = 3000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(truncated ${text.length - max} chars)`;
}

// --- clipboard ----------------------------------------------------------------

// Window event the palette command dispatches to open the diagnostics dialog
// (same decoupling as 'scenelab:open-parameters' / 'scenelab:open-ai'). Lives
// here — not in the component file — so the dispatcher (registry, status bar)
// can import it without pulling component modules and without breaking the
// react-refresh "component files only export components" rule.
export const OPEN_DIAGNOSTICS_EVENT = 'scenelab:open-diagnostics';

/** Open the diagnostics dialog from anywhere (palette command, status bar…). */
export function openDiagnostics(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_DIAGNOSTICS_EVENT));
}

/**
 * Copy text to the clipboard. Prefers the async Clipboard API, falling back
 * to a hidden textarea + execCommand for webviews that don't expose
 * navigator.clipboard (or deny it). Resolves false when both paths fail —
 * callers surface that as a toast, never as a throw.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen + transparent: never visible, never scrolled to.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
