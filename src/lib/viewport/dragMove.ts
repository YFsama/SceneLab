// Pure formatting helper for the viewport's drag-move readout (kept out of
// the component so the rounding rules are unit-testable).

/** Format an applied drag offset for the viewport overlay, e.g. "Δ 20, -10 mm". */
export function formatDragDelta(d: { x: number; z: number }): string {
  const n = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(1).replace(/\.0$/, ''));
  return `Δ ${n(d.x)}, ${n(d.z)} mm`;
}
