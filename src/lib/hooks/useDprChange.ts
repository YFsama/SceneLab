import { useEffect, useRef } from 'react';

/**
 * Fire `cb` with the new devicePixelRatio whenever it changes — the window
 * dragged across monitors with different DPI, or the browser zoom adjusted.
 * ResizeObserver cannot see these: the CSS size of a full-bleed canvas stays
 * put while its backing store should sharpen.
 *
 * Classic re-arming matchMedia pattern: a `(resolution: <current>dppx)` query
 * flips exactly when the DPR leaves its current value; on each change we drop
 * the old listener, read window.devicePixelRatio, and re-arm at the new value
 * (a single static query would only ever catch one transition).
 *
 * No-ops where matchMedia is missing (jsdom, ancient embedded views) so
 * consumers can mount unconditionally.
 */
export function useDprChange(cb: (newDpr: number) => void): void {
  // Latest-callback ref: the hook wires once, `cb` may close over fresh
  // render state every render (kept current in a passive effect — refs are
  // not writable during render).
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      mql?.removeEventListener('change', onChange);
      arm();
      cbRef.current(window.devicePixelRatio);
    };
    const arm = () => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onChange);
    };
    arm();
    return () => {
      mql?.removeEventListener('change', onChange);
    };
  }, []);
}
