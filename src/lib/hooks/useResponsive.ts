import { useEffect, useState } from 'react';

/**
 * Responsive layout classification (window-resize workflow, I3).
 *
 * The Tauri window can be shrunk to 800×600 CSS px. Below 960 px the
 * left/right dock panels (browser tree, parts library, properties) together
 * squeeze the viewport to an unusable sliver, so the App layout layer renders
 * them only on `normal`/`wide`; the store switches stay untouched (they are
 * persisted user preferences — compact is a purely derived render decision
 * that un-applies the moment the window grows back).
 */
export type ViewportBreakpoint = 'compact' | 'normal' | 'wide';

/** compact kicks in below 960 CSS px. */
const COMPACT_BELOW = 960;
/** wide kicks in at 1440 CSS px and above. */
const WIDE_FROM = 1440;

/**
 * Pure breakpoint classifier (CSS pixels) — exported for tests and any
 * non-hook call site that already knows a width.
 *   compact: width < 960 · normal: 960 ≤ width < 1440 · wide: width ≥ 1440
 */
export function classifyViewport(width: number): ViewportBreakpoint {
  if (width < COMPACT_BELOW) return 'compact';
  if (width >= WIDE_FROM) return 'wide';
  return 'normal';
}

/**
 * Initial/classified breakpoint for environments without matchMedia (SSR,
 * jsdom): 'normal' keeps the classic desktop layout — the hook's contract is
 * "never throw, degrade to the pre-responsive behaviour".
 */
function readBreakpoint(): ViewportBreakpoint {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'normal';
  return classifyViewport(window.innerWidth);
}

/**
 * Live viewport breakpoint. Uses two `matchMedia('(min-width: Npx)')`
 * subscriptions rather than a `resize` listener: MQL change events fire once
 * per threshold crossing (not per resize tick), respect CSS-pixel zoom, and
 * come with a native cleanup path. Falls back to the constant 'normal' when
 * matchMedia is unavailable (jsdom/SSR) — App tests keep rendering the
 * default layout.
 */
export function useResponsive(): ViewportBreakpoint {
  const [breakpoint, setBreakpoint] = useState<ViewportBreakpoint>(readBreakpoint);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mqlCompact = window.matchMedia(`(min-width: ${COMPACT_BELOW}px)`);
    const mqlWide = window.matchMedia(`(min-width: ${WIDE_FROM}px)`);
    const update = () => setBreakpoint(mqlWide.matches ? 'wide' : mqlCompact.matches ? 'normal' : 'compact');
    // Sync in case the media environment changed between render and effect
    // (and to re-assert the initial value on hot reload).
    update();
    // Safari < 14 only exposes the legacy addListener API.
    if (typeof mqlCompact.addEventListener === 'function' && typeof mqlWide.addEventListener === 'function') {
      mqlCompact.addEventListener('change', update);
      mqlWide.addEventListener('change', update);
      return () => {
        mqlCompact.removeEventListener('change', update);
        mqlWide.removeEventListener('change', update);
      };
    }
    mqlCompact.addListener(update);
    mqlWide.addListener(update);
    return () => {
      mqlCompact.removeListener(update);
      mqlWide.removeListener(update);
    };
  }, []);

  return breakpoint;
}
