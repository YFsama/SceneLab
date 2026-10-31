import { useEffect, useRef, useState } from 'react';
import { useStore, type PrimitiveKind } from '../../store/app';
import { useT } from '../../lib/i18n';
import type { SolidBody } from '../../lib/geometry/types';
import {
  createBox, createCylinder, createSphere, createCone, createTorus,
  createWedge, createPrism, createTube, createCoil,
} from '../../lib/geometry/brep';
import {
  createAnalyticPrimitive, isSmAnalyticKind, isSmAvailable, smStatus,
} from '../../lib/geometry/smClient';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';

interface Field { key: string; labelKey: string; def: number; min?: number; step?: number }

export interface Spec { fields: Field[]; build: (v: Record<string, number>) => SolidBody }

// Per-primitive size fields (mm) and how to build the body from them.
/* eslint-disable react-refresh/only-export-components -- pure data + async glue exported for PrimitiveDialog.test.ts direct testing; no React involved (same pattern as ViewportCanvas) */
export const SPECS: Record<PrimitiveKind, Spec> = {
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

/**
 * Confirm path for the 5 analytic kinds (box/cylinder/sphere/cone/torus):
 * prefer the SMLib kernel (exact geometry + analytic face provenance); when it
 * is unavailable or declines, fall back to the SAME synchronous brep
 * constructor the dialog has always used — the fallback result is
 * byte-identical to the pre-SMLib behaviour. Never rejects.
 */
export async function buildAnalyticBody(
  kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus',
  spec: Spec,
  nums: Record<string, number>,
): Promise<SolidBody> {
  const sm = await createAnalyticPrimitive(kind, nums).catch(() => null);
  return sm ?? spec.build(nums);
}

export type ParsedDialogValues =
  | { ok: true; nums: Record<string, number> }
  | { ok: false; errorKey?: 'sm.torusRangeError' };

/**
 * Field validation for the confirm path: per-field minimums (the dialog's
 * historical rule) plus the torus cross-field constraint r ≤ R that brep's
 * createTorus enforces by THROWING — blocking it here keeps the failure a
 * retryable form error instead of an exception mid-promise-chain. Plain
 * per-field failures stay silent (dialog just stays open, as before); the
 * cross-field one reports an i18n message.
 */
export function parseDialogValues(
  kind: PrimitiveKind,
  spec: Spec,
  vals: Record<string, string>,
): ParsedDialogValues {
  const nums: Record<string, number> = {};
  for (const f of spec.fields) {
    const n = parseFloat(vals[f.key] ?? '');
    const min = f.min ?? (f.labelKey === 'dim.radiusTop' ? 0 : 0.01);
    if (!Number.isFinite(n) || n < min) return { ok: false };
    nums[f.key] = n;
  }
  if (kind === 'torus' && nums.r! > nums.R!) return { ok: false, errorKey: 'sm.torusRangeError' };
  return { ok: true, nums };
}
/* eslint-enable react-refresh/only-export-components */

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
  // Confirm is async for the analytic kinds (one IPC round trip while the
  // kernel is up); the button locks for that window.
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Cancel semantics: once this Form unmounts (Escape, overlay click, Cancel,
  // or pendingPrimitive switching kind via the key remount), a late IPC answer
  // must be DISCARDED, not committed to the store.
  const aliveRef = useRef(true);
  useEffect(() => {
    // StrictMode's dev double-mount runs the cleanup once right after mount;
    // re-arm here or every async commit gets discarded and the dialog
    // busy-locks forever (the aliveRef.current=false trap).
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  // Kernel availability is a cached async snapshot; warm it on mount so the
  // "SMLib exact" badge appears on the first open of the session too.
  const [smExact, setSmExact] = useState(isSmAvailable());
  useEffect(() => {
    let alive = true;
    void smStatus().then(() => { if (alive) setSmExact(isSmAvailable()); });
    return () => { alive = false; };
  }, []);
  useEscapeClose(onClose);

  const create = () => {
    if (busy) return;
    const parsed = parseDialogValues(kind, spec, vals);
    if (!parsed.ok) {
      // Historical per-field failures stay silent (dialog open, retryable);
      // only the cross-field rule gets a visible message.
      setErr(parsed.errorKey ? t(parsed.errorKey) : null);
      return;
    }
    setErr(null);
    const nums = parsed.nums;
    const commit = (body: SolidBody) => {
      if (!aliveRef.current) return; // cancelled mid-flight — discard
      useStore.getState().rememberPrimitiveParams(kind, nums);
      useStore.getState().addDirectBody(body);
      useStore.getState().selectObject(body.id);
      onClose();
    };
    if (!isSmAnalyticKind(kind)) {
      // wedge/prism/tube/coil: unchanged synchronous brep construction.
      commit(spec.build(nums));
      return;
    }
    setBusy(true);
    void buildAnalyticBody(kind, spec, nums)
      .then(commit)
      // The facade never rejects, but the brep FALLBACK constructor throws on
      // inputs it deems illegal; that must leave the dialog retryable (same
      // semantics as the old sync path's exception), not busy-locked.
      .catch(() => {
        if (aliveRef.current) setBusy(false);
      });
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
          {smExact && isSmAnalyticKind(kind) && (
            <span
              className="ml-1.5 px-1 py-px rounded bg-accent/15 text-accent text-[10px] font-medium align-middle"
              title={t('sm.exactBadge')}
            >
              {t('sm.exactBadge')}
            </span>
          )}
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
                  onFocus={(e) => e.currentTarget.select()}
                  autoFocus={f === spec.fields[0]}
                  disabled={busy}
                  className="w-20 px-1.5 py-0.5 bg-surface border border-panel-border rounded text-text-primary text-xs disabled:opacity-60"
                />
                <span className="text-text-muted w-4">{f.step === 1 || f.labelKey === 'dim.turns' ? '' : 'mm'}</span>
              </span>
            </label>
          ))}
        </div>
        {err && <p className="text-xs text-error">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 text-xs rounded text-text-secondary hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={create}
            disabled={busy}
            className="px-3 py-1 text-xs rounded bg-accent text-surface font-medium hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('dialog.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
