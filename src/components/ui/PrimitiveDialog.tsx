import { useState } from 'react';
import { useStore, type PrimitiveKind } from '../../store/app';
import { useT } from '../../lib/i18n';
import type { SolidBody } from '../../lib/geometry/types';
import {
  createBox, createCylinder, createSphere, createCone, createTorus,
  createWedge, createPrism, createTube, createCoil,
} from '../../lib/geometry/brep';

interface Field { key: string; labelKey: string; def: number; min?: number; step?: number }

interface Spec { fields: Field[]; build: (v: Record<string, number>) => SolidBody }

// Per-primitive size fields (mm) and how to build the body from them.
const SPECS: Record<PrimitiveKind, Spec> = {
  box: {
    fields: [
      { key: 'w', labelKey: 'dim.width', def: 20 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
      { key: 'd', labelKey: 'dim.depth', def: 20 },
    ],
    build: (v) => createBox(v.w!, v.h!, v.d!),
  },
  cylinder: {
    fields: [
      { key: 'r', labelKey: 'dim.radius', def: 10 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
    ],
    build: (v) => createCylinder(v.r!, v.h!),
  },
  sphere: {
    fields: [{ key: 'r', labelKey: 'dim.radius', def: 10 }],
    build: (v) => createSphere(v.r!),
  },
  cone: {
    fields: [
      { key: 'rb', labelKey: 'dim.radiusBottom', def: 10 },
      { key: 'rt', labelKey: 'dim.radiusTop', def: 0, min: 0 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
    ],
    build: (v) => createCone(v.rb!, v.rt!, v.h!),
  },
  torus: {
    fields: [
      { key: 'R', labelKey: 'dim.ringRadius', def: 10 },
      { key: 'r', labelKey: 'dim.tubeRadius', def: 3 },
    ],
    build: (v) => createTorus(v.R!, v.r!),
  },
  wedge: {
    fields: [
      { key: 'w', labelKey: 'dim.width', def: 20 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
      { key: 'd', labelKey: 'dim.depth', def: 20 },
    ],
    build: (v) => createWedge(v.w!, v.h!, v.d!),
  },
  prism: {
    fields: [
      { key: 'sides', labelKey: 'dim.sides', def: 6, min: 3, step: 1 },
      { key: 'r', labelKey: 'dim.radius', def: 10 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
    ],
    build: (v) => createPrism(Math.round(v.sides!), v.r!, v.h!),
  },
  tube: {
    fields: [
      { key: 'or', labelKey: 'dim.outerRadius', def: 10 },
      { key: 'ir', labelKey: 'dim.innerRadius', def: 6 },
      { key: 'h', labelKey: 'dim.height', def: 20 },
    ],
    build: (v) => createTube(v.or!, v.ir!, v.h!),
  },
  coil: {
    fields: [
      { key: 'cr', labelKey: 'dim.coilRadius', def: 10 },
      { key: 'wr', labelKey: 'dim.wireRadius', def: 2 },
      { key: 'pitch', labelKey: 'dim.pitch', def: 6 },
      { key: 'turns', labelKey: 'dim.turns', def: 3, min: 1, step: 0.5 },
    ],
    build: (v) => createCoil(v.cr!, v.wr!, v.pitch!, v.turns!),
  },
};

/** Modal that asks for a primitive's dimensions (mm) before inserting it. */
export function PrimitiveDialog() {
  const { t } = useT();
  const kind = useStore((s) => s.pendingPrimitive);
  const close = () => useStore.getState().setPendingPrimitive(null);

  if (!kind) return null;
  const spec = SPECS[kind];
  return <Form key={kind} kind={kind} spec={spec} t={t} onClose={close} />;
}

function Form({ kind, spec, t, onClose }: { kind: PrimitiveKind; spec: Spec; t: (k: string) => string; onClose: () => void }) {
  // Seed from the last values used for this kind, falling back to the defaults.
  const remembered = useStore.getState().lastPrimitiveParams[kind];
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(spec.fields.map((f) => [f.key, String(remembered?.[f.key] ?? f.def)])),
  );

  const create = () => {
    const nums: Record<string, number> = {};
    for (const f of spec.fields) {
      const n = parseFloat(vals[f.key] ?? '');
      const min = f.min ?? (f.labelKey === 'dim.radiusTop' ? 0 : 0.01);
      if (!Number.isFinite(n) || n < min) return; // invalid → keep dialog open
      nums[f.key] = n;
    }
    const body = spec.build(nums);
    useStore.getState().rememberPrimitiveParams(kind, nums);
    useStore.getState().addDirectBody(body);
    useStore.getState().selectObject(body.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(`primitive.${kind}`)}
    >
      <div
        className="w-64 bg-panel border border-panel-border rounded-lg shadow-xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-text-primary">
          {t('dialog.insert')}: {t(`primitive.${kind}`)}
        </h2>
        <div className="space-y-2">
          {spec.fields.map((f) => (
            <label key={f.key} className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span>{t(f.labelKey)}</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={f.min ?? 0}
                  step={f.step ?? 0.5}
                  value={vals[f.key]}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
                  autoFocus={f === spec.fields[0]}
                  className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs"
                />
                <span className="text-text-muted w-4">{f.step === 1 || f.labelKey === 'dim.turns' ? '' : 'mm'}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover"
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={create}
            className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover"
          >
            {t('dialog.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
