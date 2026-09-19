/**
 * Viewport capture service. Reading pixels from a WebGL canvas is only
 * guaranteed to work in the same task as a render — unless the renderer was
 * created with `preserveDrawingBuffer: true`, which costs GPU bandwidth on
 * every frame of the app's life. Instead, ViewportCanvas registers a capture
 * function here that first forces a fresh render and then hands back the
 * canvas; screenshot / AI-vision / PNG-export paths call `captureFreshCanvas`
 * so the app keeps `preserveDrawingBuffer` off.
 */

type CaptureFn = () => HTMLCanvasElement | null;

let captureFn: CaptureFn | null = null;

/** Registered by ViewportCanvas on mount; pass null on unmount. */
export function setViewportCapture(fn: CaptureFn | null): void {
  captureFn = fn;
}

/**
 * Force a fresh viewport render and return its canvas. Falls back to querying
 * `#viewport-canvas` directly when no renderer is mounted (tests, SSR) — the
 * same behaviour captures had before the service existed.
 */
export function captureFreshCanvas(): HTMLCanvasElement | null {
  if (captureFn) return captureFn();
  return document.querySelector('#viewport-canvas');
}
