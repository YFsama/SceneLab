import { useStore, type PrimitiveKind } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Box, Cylinder, Circle, Cone, Donut, Triangle, Hexagon, CircleDot, Spline, Frame, Ruler } from 'lucide-react';

const primitives: { kind: PrimitiveKind; icon: typeof Box }[] = [
  { kind: 'box', icon: Box },
  { kind: 'cylinder', icon: Cylinder },
  { kind: 'sphere', icon: Circle },
  { kind: 'cone', icon: Cone },
  { kind: 'torus', icon: Donut },
  { kind: 'wedge', icon: Triangle },
  { kind: 'prism', icon: Hexagon },
  { kind: 'tube', icon: CircleDot },
  { kind: 'coil', icon: Spline },
];

/** Floating bar in the model workspace for inserting default-sized primitives. */
export function PrimitiveBar() {
  const { t } = useT();
  const setPendingPrimitive = useStore((s) => s.setPendingPrimitive);
  const ensureStandardPlanes = useStore((s) => s.ensureStandardPlanes);
  const measureActive = useStore((s) => s.measureActive);
  const setMeasureActive = useStore((s) => s.setMeasureActive);

  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1 rounded-md bg-panel/80 backdrop-blur-sm border border-panel-border p-1"
      role="toolbar"
      aria-label={t('primitive.add')}
    >
      {primitives.map(({ kind, icon: Icon }) => (
        <button
          key={kind}
          onClick={() => setPendingPrimitive(kind)}
          className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          aria-label={t(`primitive.${kind}`)}
          title={t(`primitive.${kind}`)}
        >
          <Icon size={18} />
        </button>
      ))}
      <div className="w-px self-stretch my-1 bg-panel-border" aria-hidden="true" />
      <button
        onClick={() => ensureStandardPlanes()}
        className="w-9 h-9 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('reference.standardPlanes')}
        title={t('reference.standardPlanes')}
      >
        <Frame size={18} />
      </button>
      <button
        onClick={() => setMeasureActive(!measureActive)}
        className={`w-9 h-9 flex items-center justify-center rounded transition-colors ${
          measureActive ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
        }`}
        aria-label={t('measure.tool')}
        aria-pressed={measureActive}
        title={t('measure.tool')}
      >
        <Ruler size={18} />
      </button>
    </div>
  );
}
