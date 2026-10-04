// One-line parameter summaries for timeline chips (Fusion-style timeline).
// Pure formatting — no store, no React.
import type { Feature, HoleParams } from './types';

function n(v: number): string {
  return Math.abs(v % 1) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
}

/**
 * GD&T hole callout text: `⌀D×DEPTH` plus the counterbore (⌴) or countersink
 * (⌵) annotation. `thruWord` localizes a through-all depth (null): the
 * timeline chip passes the locale-neutral '∞', the drawing sheet passes
 * t('drawing.thru') ("THRU" / "通孔") — the module itself stays pure.
 */
export function holeCalloutText(params: HoleParams, thruWord: string): string {
  let s = `⌀${n(params.diameter)}×${params.depth === null ? thruWord : n(params.depth)}`;
  if (params.counterbore) s += ` ⌴${n(params.counterbore.diameter)}×${n(params.counterbore.depth)}`;
  else if (params.countersink) s += ` ⌵${n(params.countersink.diameter)}°${n(params.countersink.angleDeg)}`;
  return s;
}

export function featureSummary(f: Feature): string {
  switch (f.type) {
    case 'sketch':
      return `${f.sketch.entities.size}e`;
    case 'extrude':
      // A cut extrude reads differently from a join on the timeline. The
      // scissors glyph is locale-neutral — an English word like 'cut' would
      // leak into the zh chips (and the AI's summary field).
      return `${f.params.op === 'cut' ? '✂ ' : ''}${n(f.params.distance)}mm`;
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
    case 'hole':
      // ⌴ is the GD&T counterbore symbol, ⌵ the countersink symbol.
      return holeCalloutText(f.params, '∞');
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
