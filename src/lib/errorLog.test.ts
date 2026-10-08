import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordError, getRecentErrors, clearErrors, installGlobalErrorCapture,
  formatErrorEntry, buildDiagnosticsReport, truncateForIssue, copyText,
  resetErrorLogForTest, type ErrorEntry,
} from './errorLog';
import { registerCommand, runCommand, clearCommands } from './commands/registry';
import { useStore } from '../store/app';

const KEY = 'scenelab.errorlog';

beforeEach(() => {
  resetErrorLogForTest();
  clearCommands();
  useStore.setState({ locale: 'en' });
});

// --- recording ----------------------------------------------------------------

describe('errorLog recording', () => {
  it('records entries with monotonic ids and timestamps', () => {
    const a = recordError('error', 'first');
    const b = recordError('rejection', 'second', 'stack line', 'src.ts:1');
    expect(a.id).toBeLessThan(b.id);
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
    expect(b.stack).toBe('stack line');
    expect(b.source).toBe('src.ts:1');
  });

  it('returns newest-first from getRecentErrors', () => {
    recordError('error', 'old');
    recordError('error', 'new');
    const recent = getRecentErrors(10);
    expect(recent[0]!.message).toBe('new');
    expect(recent[1]!.message).toBe('old');
  });

  it('caps the in-memory ring buffer at 100 entries', () => {
    for (let i = 1; i <= 105; i++) recordError('error', `e${i}`);
    const all = getRecentErrors(500);
    expect(all).toHaveLength(100);
    // Oldest surviving is #6, newest is #105.
    expect(all[all.length - 1]!.message).toBe('e6');
    expect(all[0]!.message).toBe('e105');
  });
});

// --- persistence ----------------------------------------------------------------

describe('errorLog persistence', () => {
  it('persists the newest 30 entries to localStorage', () => {
    for (let i = 1; i <= 35; i++) recordError('error', `e${i}`);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as ErrorEntry[];
    expect(stored).toHaveLength(30);
    expect(stored[0]!.message).toBe('e6');
    expect(stored[stored.length - 1]!.message).toBe('e35');
  });

  it('restores persisted entries when the module is re-evaluated', async () => {
    recordError('error', 'crash-before-reload');
    recordError('react', 'boundary catch');
    // Re-import the module (fresh evaluation) — this is the reload path.
    vi.resetModules();
    const fresh = await import('./errorLog');
    const restored = fresh.getRecentErrors(10);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.message).toBe('boundary catch');
    expect(restored[1]!.message).toBe('crash-before-reload');
  });

  it('degrades to an empty log when storage holds corrupt JSON', async () => {
    localStorage.setItem(KEY, '{not json');
    vi.resetModules();
    const fresh = await import('./errorLog');
    expect(fresh.getRecentErrors()).toHaveLength(0);
  });

  it('clearErrors empties memory and storage', () => {
    recordError('error', 'gone');
    clearErrors();
    expect(getRecentErrors()).toHaveLength(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('survives localStorage writes throwing (sandbox denial)', () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    const setter = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    Object.defineProperty(window.localStorage, 'setItem', { value: setter, configurable: true });
    try {
      expect(() => recordError('error', 'sandboxed')).not.toThrow();
      expect(getRecentErrors()).toHaveLength(1);
    } finally {
      Object.defineProperty(window.localStorage, 'setItem', { value: original, configurable: true });
    }
  });
});

// --- global capture ---------------------------------------------------------------

/** Dispatch a window 'error' event the way the browser (or a test) does. */
function dispatchError(init: { message?: string; error?: unknown; filename?: string; lineno?: number }): void {
  const ev = typeof ErrorEvent === 'function'
    ? new ErrorEvent('error', {
      message: init.message ?? '',
      error: init.error,
      filename: init.filename,
      lineno: init.lineno ?? 1,
    })
    : Object.assign(new Event('error'), init);
  window.dispatchEvent(ev);
}

/** Dispatch 'unhandledrejection' (jsdom has no PromiseRejectionEvent ctor). */
function dispatchRejection(reason: unknown): void {
  const ev = new Event('unhandledrejection') as Event & { reason: unknown };
  ev.reason = reason;
  window.dispatchEvent(ev);
}

describe('installGlobalErrorCapture', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => { uninstall?.(); uninstall = undefined; });

  it('captures ErrorEvent errors with their stack', () => {
    uninstall = installGlobalErrorCapture();
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at x (app.ts:12:3)';
    dispatchError({ error: err, message: 'boom', filename: 'app.ts', lineno: 12 });
    const [e] = getRecentErrors();
    expect(e?.kind).toBe('error');
    expect(e?.message).toBe('boom');
    expect(e?.stack).toContain('at x (app.ts:12:3)');
    expect(e?.source).toBe('app.ts:12');
  });

  it('captures plain string-message error events without a stack', () => {
    uninstall = installGlobalErrorCapture();
    dispatchError({ message: 'script went wrong' });
    const [e] = getRecentErrors();
    expect(e?.kind).toBe('error');
    expect(e?.message).toBe('script went wrong');
    expect(e?.stack).toBeUndefined();
  });

  it('normalizes rejection reasons: Error / string / arbitrary object', () => {
    uninstall = installGlobalErrorCapture();
    const err = new Error('async kaboom');
    dispatchRejection(err);
    dispatchRejection('plain string reason');
    dispatchRejection({ code: 42 });
    const recent = getRecentErrors(10);
    expect(recent[2]!.kind).toBe('rejection');
    expect(recent[2]!.message).toBe('async kaboom');
    expect(recent[2]!.stack).toBe(err.stack);
    expect(recent[1]!.message).toBe('plain string reason');
    expect(recent[0]!.message).toBe('{"code":42}');
  });

  it('stops recording after uninstall', () => {
    uninstall = installGlobalErrorCapture();
    uninstall();
    uninstall = undefined;
    dispatchError({ message: 'after detach' });
    dispatchRejection('after detach');
    expect(getRecentErrors()).toHaveLength(0);
  });

  it('is idempotent: double install records one entry per event', () => {
    uninstall = installGlobalErrorCapture();
    const second = installGlobalErrorCapture();
    dispatchError({ message: 'once only' });
    expect(getRecentErrors()).toHaveLength(1);
    second();
    uninstall = undefined;
  });
});

// --- report formatting ------------------------------------------------------------

describe('formatErrorEntry', () => {
  it('formats head line, stack and source', () => {
    const e = recordError('react', 'render failed', '  at C (x.tsx:1)', 'in C');
    const text = formatErrorEntry(e);
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+Z\] react: render failed$/m);
    expect(text).toContain('at C (x.tsx:1)');
    expect(text).toContain('(source: in C)');
  });

  it('omits absent stack/source', () => {
    const e = recordError('error', 'bare');
    expect(formatErrorEntry(e)).not.toContain('source:');
    expect(formatErrorEntry(e).split('\n')).toHaveLength(1);
  });
});

describe('buildDiagnosticsReport', () => {
  it('includes version, platform, locale and recent command labels', () => {
    registerCommand({ id: 'test.diag', label: 'Diagnostics Probe', run: () => undefined });
    runCommand('test.diag');
    recordError('error', 'report me');
    const report = buildDiagnosticsReport();
    expect(report).toContain('SceneLab diagnostics');
    expect(report).toMatch(/Version: \d+\.\d+/);
    expect(report).toContain('Platform: web (');
    expect(report).toContain('Locale: en');
    expect(report).toContain('- Diagnostics Probe');
    expect(report).toContain('report me');
    expect(report).toContain('Viewport:');
  });
});

// --- issue truncation ----------------------------------------------------------

describe('truncateForIssue', () => {
  it('passes short text through unchanged', () => {
    expect(truncateForIssue('short', 5000)).toBe('short');
  });

  it('truncates long text with an explicit marker', () => {
    const text = 'x'.repeat(5100);
    const out = truncateForIssue(text, 5000);
    expect(out.startsWith('x'.repeat(5000))).toBe(true);
    expect(out.endsWith('…(truncated 100 chars)')).toBe(true);
  });
});

// --- clipboard --------------------------------------------------------------------

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined): ReturnType<typeof vi.fn> | undefined {
  // A plain object with writeText: undefined models "no Clipboard API" —
  // vi.fn(undefined) would be a callable mock and take the primary path.
  const fn = writeText === undefined ? undefined : vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: fn },
    configurable: true,
    writable: true,
  });
  return fn;
}

describe('copyText', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    document.execCommand = () => true;
  });

  it('uses navigator.clipboard when available', async () => {
    const writeText = stubClipboard(async () => undefined);
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the clipboard API is missing', async () => {
    stubClipboard(undefined);
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await expect(copyText('fallback')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await expect(copyText('denied then ok')).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it('resolves false when both paths fail', async () => {
    stubClipboard(undefined);
    document.execCommand = () => false;
    await expect(copyText('nope')).resolves.toBe(false);
  });
});
