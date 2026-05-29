import { useState, useRef } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';
import { useFocusRestore } from '../../lib/hooks/useFocusRestore';
import type { Feature, ExtrudeFeature } from '../../lib/features/types';
import { Pencil, Trash2, Eye, EyeOff } from 'lucide-react';

export function FeatureEditor() {
  const { t } = useT();
  const featureTree = useStore((s) => s.featureTree);
  const removeFeature = useStore((s) => s.removeFeature);
  const updateFeature = useStore((s) => s.updateFeature);

  const [editingFeature, setEditingFeature] = useState<Feature | null>(null);

  useEscapeClose(() => setEditingFeature(null), !!editingFeature);
  useFocusRestore();

  const handleToggleSuppress = (feature: Feature) => {
    updateFeature(feature.id, (f) => ({ ...f, suppressed: !f.suppressed }));
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
                onClick={() => setEditingFeature(feature)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditingFeature(feature); }}
                className={`flex-1 text-left truncate ${
                  feature.suppressed ? 'text-text-muted line-through' : 'text-text-secondary'
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
