import { useState, useRef } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import type {
  Feature, ExtrudeFeature, RevolveFeature,
  FilletFeature, ChamferFeature, ShellFeature, ScaleFeature,
  LinearArrayFeature, CircularArrayFeature, MirrorFeature,
} from '../../lib/features/types';
import { Pencil, Trash2, Eye, EyeOff } from 'lucide-react';

/** Feature types whose editable parameters are plain numbers. */
export type NumericFeature =
  | FilletFeature | ChamferFeature | ShellFeature | ScaleFeature
  | LinearArrayFeature | CircularArrayFeature | MirrorFeature;
const isNumericFeature = (f: Feature): f is NumericFeature =>
  f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell' || f.type === 'scale' ||
  f.type === 'linearArray' || f.type === 'circularArray' || f.type === 'mirror';

export function FeatureEditor() {
  const { t } = useT();
  const featureTree = useStore((s) => s.featureTree);
  const removeFeature = useStore((s) => s.removeFeature);
  const updateFeature = useStore((s) => s.updateFeature);

  const [editingFeature, setEditingFeature] = useState<Feature | null>(null);
  // Ctrl/⌘+click multi-selects sketch features; two or more enable Loft.
  const [selectedSketchIds, setSelectedSketchIds] = useState<string[]>([]);
  const performLoftFromSketches = useStore((s) => s.performLoftFromSketches);

  useEscapeClose(() => setEditingFeature(null), !!editingFeature);
  useFocusRestore();

  const handleToggleSuppress = (feature: Feature) => {
    updateFeature(feature.id, (f) => ({ ...f, suppressed: !f.suppressed }));
  };

  const toggleSketchPick = (feature: Feature, additive: boolean) => {
    if (!additive) {
      setSelectedSketchIds([feature.id]);
      return;
    }
    setSelectedSketchIds((prev) =>
      prev.includes(feature.id) ? prev.filter((id) => id !== feature.id) : [...prev, feature.id],
    );
  };

  const handleCreateLoft = () => {
    if (performLoftFromSketches(selectedSketchIds)) {
      setSelectedSketchIds([]);
    }
  };

  return (
    <>
      <div className="space-y-0.5">
        {featureTree.features.length === 0 ? (
          <p className="text-xs text-text-muted p-2">{t('panel.noFeatures')}</p>
        ) : (
          featureTree.features.map((feature) => (
            <div
              key={feature.id}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-surface-hover group"
            >
              <button
                onClick={() => handleToggleSuppress(feature)}
                className="text-text-muted hover:text-text-primary"
                aria-label={feature.suppressed ? t('feature.showFeature') : t('feature.hideFeature')}
              >
                {feature.suppressed ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <button
                onClick={(e) => {
                  if (feature.type === 'sketch') {
                    toggleSketchPick(feature, e.ctrlKey || e.metaKey);
                  } else {
                    setSelectedSketchIds([]);
                  }
                  setEditingFeature(feature);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditingFeature(feature); }}
                className={`flex-1 text-left truncate ${
                  feature.suppressed ? 'text-text-muted line-through'
                    : selectedSketchIds.includes(feature.id) ? 'text-accent'
                    : 'text-text-secondary'
                }`}
                aria-label={`${t('feature.editFeature')}: ${feature.name}`}
              >
                {feature.name}
              </button>
              <button
                onClick={() => setEditingFeature(feature)}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent"
                aria-label={t('feature.editFeature')}
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => removeFeature(feature.id)}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-error"
                aria-label={t('feature.deleteFeature')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {selectedSketchIds.length >= 2 && (
        <button
          onClick={handleCreateLoft}
          className="mt-2 w-full px-2 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover"
          aria-label={t('feature.createLoft')}
        >
          {t('feature.createLoft')} ({selectedSketchIds.length})
        </button>
      )}

      {editingFeature && (
        <FeatureEditDialog
          feature={editingFeature}
          onClose={() => setEditingFeature(null)}
        />
      )}
    </>
  );
}

function FeatureEditDialog({
  feature,
  onClose,
}: {
  feature: Feature;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(onClose, true);
  useFocusRestore();

  if (feature.type === 'extrude') {
    return <ExtrudeEditDialog feature={feature} onClose={onClose} />;
  }

  if (feature.type === 'revolve') {
    return <RevolveEditDialog feature={feature} onClose={onClose} />;
  }

  if (isNumericFeature(feature)) {
    return <NumericEditDialog feature={feature} onClose={onClose} />;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={dialogRef}
        className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4"
      >
        <h2 className="text-lg font-semibold text-text-primary mb-4">{feature.name}</h2>
        <p className="text-sm text-text-muted">No editable parameters for this feature type.</p>
        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RevolveEditDialog({
  feature,
  onClose,
}: {
  feature: RevolveFeature;
  onClose: () => void;
}) {
  const updateFeature = useStore((s) => s.updateFeature);
  const [angleDeg, setAngleDeg] = useState((feature.params.angle * 180) / Math.PI);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(onClose, true);
  useFocusRestore();

  const handleApply = () => {
    // Clamp to a usable (0, 360°] sweep and store back in radians.
    const deg = Math.min(360, Math.max(1, angleDeg));
    updateFeature(feature.id, (f) =>
      f.type === 'revolve' ? { ...f, params: { ...f.params, angle: (deg * Math.PI) / 180 } } : f,
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-revolve-title"
    >
      <div ref={dialogRef} className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4">
        <h2 id="edit-revolve-title" className="text-lg font-semibold text-text-primary mb-4">
          Edit Revolve
        </h2>
        <div>
          <label className="block text-sm text-text-secondary mb-1">Angle (°)</label>
          <input
            type="number"
            value={angleDeg}
            onChange={(e) => setAngleDeg(Number(e.target.value))}
            min={1}
            max={360}
            step={5}
            className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover"
            autoFocus
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtrudeEditDialog({
  feature,
  onClose,
}: {
  feature: ExtrudeFeature;
  onClose: () => void;
}) {
  const updateFeature = useStore((s) => s.updateFeature);
  const [distance, setDistance] = useState(feature.params.distance);
  const [symmetric, setSymmetric] = useState(feature.params.symmetric ?? false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(onClose, true);
  useFocusRestore();

  const handleApply = () => {
    updateFeature(feature.id, (f) =>
      f.type === 'extrude'
        ? { ...f, params: { ...f.params, distance, symmetric } }
        : f,
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-extrude-title"
    >
      <div
        ref={dialogRef}
        className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4"
      >
        <h2 id="edit-extrude-title" className="text-lg font-semibold text-text-primary mb-4">
          Edit Extrude
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Distance (mm)</label>
            <input
              type="number"
              value={distance}
              onChange={(e) => setDistance(Number(e.target.value))}
              min={0.1}
              step={0.5}
              className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={symmetric}
              onChange={(e) => setSymmetric(e.target.checked)}
              className="rounded border-panel-border"
            />
            <label className="text-sm text-text-secondary">Symmetric</label>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover"
            autoFocus
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Field descriptor for the numeric feature editor. */
interface NumField {
  key: string;
  label: string;
  value: number;
  min?: number;
  step?: number;
}

function numericFields(f: NumericFeature): NumField[] {
  switch (f.type) {
    case 'fillet':
      return [{ key: 'radius', label: 'Radius (mm)', value: f.params.radius, min: 0.1, step: 0.5 }];
    case 'chamfer':
      return [{ key: 'distance', label: 'Distance (mm)', value: f.params.distance, min: 0.1, step: 0.5 }];
    case 'shell':
      return [{ key: 'thickness', label: 'Thickness (mm)', value: f.params.thickness, min: 0.1, step: 0.5 }];
    case 'scale':
      return [{ key: 'target', label: `Target extent ${f.params.axis.toUpperCase()} (mm)`, value: f.params.target, min: 0.1, step: 0.5 }];
    case 'linearArray':
      return [
        { key: 'count', label: 'Count', value: f.params.count, min: 1, step: 1 },
        { key: 'spacing', label: 'Spacing (mm)', value: f.params.spacing, min: 0.1, step: 1 },
      ];
    case 'circularArray':
      return [{ key: 'count', label: 'Count', value: f.params.count, min: 2, step: 1 }];
    case 'mirror':
      return [];
  }
}

function applyNumeric(f: NumericFeature, values: Record<string, number>): Feature {
  switch (f.type) {
    case 'fillet':
      return { ...f, params: { ...f.params, radius: values.radius! } };
    case 'chamfer':
      return { ...f, params: { ...f.params, distance: values.distance! } };
    case 'shell':
      return { ...f, params: { ...f.params, thickness: values.thickness! } };
    case 'scale':
      return { ...f, params: { ...f.params, target: values.target! } };
    case 'linearArray':
      return { ...f, params: { ...f.params, count: values.count!, spacing: values.spacing! } };
    case 'circularArray':
      return { ...f, params: { ...f.params, count: values.count! } };
    case 'mirror':
      return f;
  }
}

function NumericEditDialog({ feature, onClose }: { feature: NumericFeature; onClose: () => void }) {
  const updateFeature = useStore((s) => s.updateFeature);
  const [keepOriginal, setKeepOriginal] = useState(feature.type === 'mirror' ? feature.params.keepOriginal !== false : false);
  const initial = Object.fromEntries(numericFields(feature).map((f) => [f.key, f.value]));
  const [values, setValues] = useState<Record<string, number>>(initial);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeClose(onClose, true);
  useFocusRestore();

  const fields = numericFields(feature);

  const handleApply = () => {
    updateFeature(feature.id, (f) => {
      if (!isNumericFeature(f)) return f;
      const next = applyNumeric(f, values);
      if (next.type === 'mirror') {
        return { ...next, params: { ...next.params, keepOriginal } };
      }
      return next;
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-numeric-feature-title"
    >
      <div ref={dialogRef} className="bg-panel border border-panel-border rounded-lg shadow-xl p-6 w-80 mx-4">
        <h2 id="edit-numeric-feature-title" className="text-lg font-semibold text-text-primary mb-4">
          {feature.name}
        </h2>
        <div className="space-y-4">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="block text-sm text-text-secondary mb-1">{f.label}</label>
              <input
                type="number"
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                min={f.min}
                step={f.step}
                className="w-full px-3 py-2 bg-surface border border-panel-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          ))}
          {feature.type === 'mirror' && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={keepOriginal}
                onChange={(e) => setKeepOriginal(e.target.checked)}
                className="rounded border-panel-border"
              />
              <label className="text-sm text-text-secondary">Keep original</label>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-text-secondary hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent-hover"
            autoFocus
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
