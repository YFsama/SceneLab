/** Backing-store sizing rules shared by the canvas components (pure, DOM-free). */

/**
 * Cap the device pixel ratio at 2 — above that the extra fragments cost a lot
 * of GPU/raster time for no visible gain in a CAD viewport (the same clamp the
 * WebGL viewport has always applied). Non-finite or non-positive inputs fall
 * back to 1 rather than poisoning Math downstream.
 */
export function clampedDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, 2);
}

/**
 * Physical-pixel backing size for a CSS-sized canvas at a DPR: the client size
 * times the clamped DPR, floored, with a 1px floor so a 0-sized (hidden)
 * container never produces a degenerate 0×0 drawing surface. Non-finite client
 * dimensions are treated as 0.
 */
export function canvasBackingSize(
  clientW: number,
  clientH: number,
  dpr: number,
): { width: number; height: number } {
  const c = clampedDpr(dpr);
  const w = Number.isFinite(clientW) ? clientW : 0;
  const h = Number.isFinite(clientH) ? clientH : 0;
  return {
    width: Math.max(1, Math.floor(w * c)),
    height: Math.max(1, Math.floor(h * c)),
  };
}

/** A width/height/dpr triple as tracked by the resize-apply paths. */
export interface ResizeTriple {
  w: number;
  h: number;
  dpr: number;
}

/**
 * True when the apply path should run: any of the three inputs moved. This is
 * the last-applied dedup (a ResizeObserver can fire per frame during panel
 * drags; re-applying an identical size would reallocate the drawing buffer for
 * nothing). NaN fields never compare equal, so corrupt reads apply rather
 * than being silently swallowed.
 */
export function shouldApplyResize(prev: ResizeTriple, next: ResizeTriple): boolean {
  return prev.w !== next.w || prev.h !== next.h || prev.dpr !== next.dpr;
}
