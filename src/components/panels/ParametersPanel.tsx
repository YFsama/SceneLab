import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { getCommand } from '../../lib/commands/registry';
import type { Feature } from '../../lib/features/types';

/** Window event the 'params.open' palette command dispatches to open the dialog
 *  (same decoupling as the 'scenelab:fit-view' commands). */
export const OPEN_PARAMETERS_EVENT = 'scenelab:open-parameters';

type ParamUnit = 'mm' | 'deg' | 'count';

/** One editable driving value — a feature parameter or a sketch dimension. */
interface ParamRow {
  key: string;
  /** Localized feature / constraint type for the first column. */
  typeLabel: string;
  /** Feature name (or "Current sketch") for the second column. */
  ownerName: string;
  /** Localized parameter label (units live in the translation). */
  paramLabel: string;
  value: number;
  unit: ParamUnit;
  /** Suppressed features render dimmed. */
  suppressed: boolean;
  /** Commit an edited value; invalid magnitudes are ignored per kind. */
  commit: (v: number) => void;
}

/** Format a displayed value without float noise. */
function formatValue(v: number, unit: ParamUnit): string {
  if (unit === 'count') return String(Math.round(v));
  return String(Number(v.toFixed(2)));
}

/** Every numeric parameter a feature type exposes in the table. Counts are
 *  integers (min 1), angles degrees (the tree stores radians), lengths mm. */
function featureParamRows(
  f: Feature,
  t: (key: string, vars?: Record<string, string | number>) => string,
  updateFeature: (id: string, mutator: (fe: Feature) => Feature) => void,
): ParamRow[] {
  // Same mutator style the FeatureEditor dialogs use: replace the feature
  // object with an updated copy, guarded by the type discriminant.
  const row = (
    suffix: string,
    paramLabel: string,
    value: number,
    unit: ParamUnit,
    commit: (v: number) => void,
  ): ParamRow => ({
    key: `${f.id}:${suffix}`,
    typeLabel: t(`feature.${f.type}`),
    ownerName: f.name,
    paramLabel,
    value,
    unit,
    suppressed: f.suppressed,
    commit,
  });

  switch (f.type) {
    case 'extrude':
      return [row('distance', t('params.extrudeDistance'), f.params.distance, 'mm',
        (v) => {
          if (!(v > 0.01)) return; // invalid keeps the old value
          updateFeature(f.id, (fe) =>
            fe.type === 'extrude' ? { ...fe, params: { ...fe.params, distance: v } } : fe);
        })];
    case 'revolve':
      return [row('angle', t('params.revolveAngle'), (f.params.angle * 180) / Math.PI, 'deg',
        (v) => {
          const deg = Math.min(360, Math.max(1, v)); // usable (0°, 360°] sweep
          updateFeature(f.id, (fe) =>
            fe.type === 'revolve' ? { ...fe, params: { ...fe.params, angle: (deg * Math.PI) / 180 } } : fe);
        })];
    case 'fillet':
      return [row('radius', t('params.filletRadius'), f.params.radius, 'mm',
        (v) => {
          if (!(v > 0.01)) return;
          updateFeature(f.id, (fe) =>
            fe.type === 'fillet' ? { ...fe, params: { ...fe.params, radius: v } } : fe);
        })];
    case 'chamfer':
      return [row('distance', t('params.chamferDistance'), f.params.distance, 'mm',
        (v) => {
          if (!(v > 0.01)) return;
          updateFeature(f.id, (fe) =>
            fe.type === 'chamfer' ? { ...fe, params: { ...fe.params, distance: v } } : fe);
        })];
    case 'shell':
      return [row('thickness', t('params.shellThickness'), f.params.thickness, 'mm',
        (v) => {
          if (!(v > 0.01)) return;
          updateFeature(f.id, (fe) =>
            fe.type === 'shell' ? { ...fe, params: { ...fe.params, thickness: v } } : fe);
        })];
    case 'scale':
      return [row('target', t('params.scaleTarget'), f.params.target, 'mm',
        (v) => {
          if (!(v > 0.01)) return;
          updateFeature(f.id, (fe) =>
            fe.type === 'scale' ? { ...fe, params: { ...fe.params, target: v } } : fe);
        })];
    case 'hole': {
      const rows = [row('diameter', t('params.holeDiameter'), f.params.diameter, 'mm',
        (v) => {
          if (!(v > 0.01)) return;
          updateFeature(f.id, (fe) =>
            fe.type === 'hole' ? { ...fe, params: { ...fe.params, diameter: v } } : fe);
        })];
      if (f.params.depth !== null) {
        rows.push(row('depth', t('params.holeDepth'), f.params.depth, 'mm',
          (v) => {
            if (!(v > 0.01)) return;
            updateFeature(f.id, (fe) =>
              fe.type === 'hole' ? { ...fe, params: { ...fe.params, depth: v } } : fe);
          }));
      }
      return rows;
    }
    case 'linearArray':
      return [
        row('count', t('params.arrayCount'), f.params.count, 'count',
          (v) => {
            const count = Math.max(1, Math.round(v));
            updateFeature(f.id, (fe) =>
              fe.type === 'linearArray' ? { ...fe, params: { ...fe.params, count } } : fe);
          }),
        row('spacing', t('params.arraySpacing'), f.params.spacing, 'mm',
          (v) => {
            if (!(v > 0.01)) return;
            updateFeature(f.id, (fe) =>
              fe.type === 'linearArray' ? { ...fe, params: { ...fe.params, spacing: v } } : fe);
          }),
      ];
    case 'circularArray':
      return [row('count', t('params.arrayCount'), f.params.count, 'count',
        (v) => {
          const count = Math.max(1, Math.round(v));
          updateFeature(f.id, (fe) =>
            fe.type === 'circularArray' ? { ...fe, params: { ...fe.params, count } } : fe);
        })];
    case 'sweep':
      return [row('twist', t('params.sweepTwist'), (f.params.twist * 180) / Math.PI, 'deg',
        (v) => {
          const deg = Math.min(3600, Math.max(-3600, v));
          updateFeature(f.id, (fe) =>
            fe.type === 'sweep' ? { ...fe, params: { ...fe.params, twist: (deg * Math.PI) / 180 } } : fe);
        })];
    default:
      // sketch / loft / mirror carry no single numeric driving value.
      return [];
  }
}

/** Collect every driving value in the document: one row per numeric feature
 *  parameter, plus the current sketch's distance/radius dimensions. */
function useParamRows(): ParamRow[] {
  const { t } = useT();
  // The feature tree mutates in place, so featureVersion is what re-renders the
  // table on edits made elsewhere while the panel is open.
  const featureVersion = useStore((s) => s.featureVersion);
  const treeFeatures = useStore((s) => s.featureTree.features);
  const currentSketch = useStore((s) => s.currentSketch);
  const updateFeature = useStore((s) => s.updateFeature);
  const updateSketchConstraintValue = useStore((s) => s.updateSketchConstraintValue);
  const locale = useStore((s) => s.locale);

  return useMemo(() => {
    const rows: ParamRow[] = [];
    for (const f of treeFeatures) {
      rows.push(...featureParamRows(f, t, updateFeature));
    }
    if (currentSketch) {
      for (const c of currentSketch.constraints.values()) {
        if ((c.type === 'distance' || c.type === 'radius') && typeof c.value === 'number') {
          rows.push({
            key: `sketch:${c.id}`,
            typeLabel: t('feature.sketch'),
            ownerName: t('params.currentSketch'),
            paramLabel: c.type === 'distance' ? t('params.distanceConstraint') : t('params.radiusConstraint'),
            value: c.value,
            unit: 'mm',
            suppressed: false,
            commit: (v) => { updateSketchConstraintValue(c.id, v); },
          });
        }
      }
    }
    return rows;
    // featureVersion + locale are intentional deps: they're the change signals
    // for the in-place-mutated tree and the localized labels respectively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureVersion, treeFeatures, currentSketch, updateFeature, updateSketchConstraintValue, t, locale]);
}

/** Inline value editor: click to edit, Enter/blur commits, Escape cancels,
 *  empty or non-numeric input keeps the old value. */
function ValueCell({ row }: { row: ParamRow }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const display = formatValue(row.value, row.unit);
  const unitLabel = row.unit === 'count' ? '' : t(row.unit === 'deg' ? 'params.unit.deg' : 'params.unit.mm');

  const commit = () => {
    setEditing(false);
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v)) return; // keep the old value
    row.commit(v);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-xs text-text-primary hover:bg-surface-hover"
        onClick={() => {
          setDraft(display);
          setEditing(true);
        }}
        aria-label={`${t('params.editValue')}: ${row.paramLabel}`}
        title={row.suppressed ? t('params.suppressed') : t('params.editValue')}
      >
        <span className="text-right">{display}</span>
        {unitLabel && <span className="text-text-muted">{unitLabel}</span>}
      </button>
    );
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      className="w-16 px-1.5 py-0.5 rounded bg-surface border border-accent/60 font-mono text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
      value={draft}
      autoFocus
      aria-label={row.paramLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          // Cancel the edit only — don't bubble up to close the dialog.
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * Fusion-style Parameters dialog: every driving value in the document in one
 * editable table. Feature rows edit through the existing `updateFeature`
 * (mutator style, featureVersion bumps and the tree recomputes); sketch rows
 * edit the current sketch's distance/radius constraints through
 * `updateSketchConstraintValue` (which re-solves the sketch). Opened from the
 * command palette ('params.open') via the open-parameters window event.
 */
export function ParametersPanel() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const rows = useParamRows();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PARAMETERS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PARAMETERS_EVENT, onOpen);
  }, []);

  // Keep the palette entry's label bilingual as the locale changes (the
  // registry registers it once at boot with the then-current locale).
  useEffect(() => {
    const cmd = getCommand('params.open');
    if (cmd) cmd.label = t('params.command');
  }, [t]);

  // Escape closes the dialog; an inline edit's Escape is stopped at its input.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const grid = 'grid grid-cols-[5rem_minmax(0,1fr)_8rem_7rem] gap-2 items-center';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t('params.title')}
    >
      <div
        className="w-[38rem] max-w-[90vw] max-h-[75vh] flex flex-col bg-panel border border-panel-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">
            {t('params.title')}
            <span className="ml-2 text-xs font-normal text-text-muted">
              {t('params.count', { n: rows.length })}
            </span>
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {rows.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-text-muted">{t('params.empty')}</p>
          ) : (
            <div role="table" aria-label={t('params.title')}>
              <div role="rowgroup">
                <div className={`${grid} px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted`} role="row">
                  <span role="columnheader">{t('params.col.type')}</span>
                  <span role="columnheader">{t('params.col.name')}</span>
                  <span role="columnheader">{t('params.col.parameter')}</span>
                  <span role="columnheader" className="text-right">{t('params.col.value')}</span>
                </div>
              </div>
              <div role="rowgroup">
                {rows.map((row) => (
                  <div
                    key={row.key}
                    role="row"
                    className={`${grid} px-2 py-1 border-t border-panel-border/50 text-xs ${row.suppressed ? 'opacity-50' : ''}`}
                    aria-disabled={row.suppressed || undefined}
                  >
                    <span role="cell" className="truncate text-text-muted">{row.typeLabel}</span>
                    <span role="cell" className="truncate text-text-secondary">{row.ownerName}</span>
                    <span role="cell" className="truncate text-text-secondary">{row.paramLabel}</span>
                    <span role="cell" className="flex justify-end">
                      <ValueCell row={row} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
