// One-line parameter summaries for timeline chips (Fusion-style timeline).
// Pure formatting — no store, no React.
import type { Feature } from './types';

function n(v: number): string {
  return Math.abs(v % 1) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
}

export function featureSummary(f: Feature): string {
  switch (f.type) {
    case 'sketch':
      return `${f.sketch.entities.size}e`;
    case 'extrude':
      return `${n(f.params.distance)}mm`;
    case 'revolve':
      return `${n((f.params.angle * 180) / Math.PI)}°`;
    case 'sweep':
      return `${f.params.path.length}pts`;
    case 'loft':
      return `${f.params.sections?.length ?? 2}×`;
    case 'fillet':
      return `r${n(f.params.radius)}`;
    case 'chamfer':
      return `${n(f.params.distance)}mm`;
    case 'shell':
      return `t${n(f.params.thickness)}`;
    case 'hole': {
      // ⌴ is the GD&T counterbore symbol, ⌵ the countersink symbol.
      let s = `⌀${n(f.params.diameter)}×${f.params.depth === null ? '∞' : n(f.params.depth)}`;
      if (f.params.counterbore) s += ` ⌴${n(f.params.counterbore.diameter)}×${n(f.params.counterbore.depth)}`;
      else if (f.params.countersink) s += ` ⌵${n(f.params.countersink.diameter)}°${n(f.params.countersink.angleDeg)}`;
      return s;
    }
    case 'scale':
      return `${f.params.axis}→${n(f.params.target)}`;
    case 'linearArray':
      return `${f.params.count}×${n(f.params.spacing)}`;
    case 'circularArray':
      return `${f.params.count}×`;
    case 'mirror':
      return '⇄';
  }
}
