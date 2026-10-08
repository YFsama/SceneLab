// Feedback / issue-reporting target. Reports are always user-initiated
// (copy / save / open the feedback page) — nothing is ever auto-sent.

import { isTauri } from './runtime';

/** The single feedback channel: the project's GitHub issue tracker. */
export const FEEDBACK_PAGE_URL = 'https://github.com/YFsama/SceneLab/issues/new';

/**
 * Prefill an issue title + body onto the GitHub "new issue" page.
 * GitHub caps issue-template query params (~6 KB body) — callers should
 * truncate long diagnostics before passing them here.
 */
export function buildIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `${FEEDBACK_PAGE_URL}?${params.toString()}`;
}

/**
 * Open an external URL in the system browser. Inside Tauri the shell
 * plugin's `open` is preferred (WKWebView/webkit2gtk may silently block
 * window.open); in a plain browser — or if the shell call is denied —
 * fall back to window.open.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const shell = await import('@tauri-apps/plugin-shell');
      await shell.open(url);
      return;
    } catch {
      // Shell open denied (capability/config) — fall through to window.open.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
