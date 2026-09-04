import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { combinedBounds } from '../../lib/render/fitView';
import { Scissors, FlipHorizontal2, X } from 'lucide-react';
import type { SectionAxis } from '../../lib/render/section';

const AXES: SectionAxis[] = ['x', 'y', 'z'];

/**
 * Live section analysis controls (Fusion-style): toggle a global clip plane,
 * pick the axis, slide the offset through the model's bounding box, flip which
 * half is kept. Viewport-only — geometry is never modified, so it's a safe
 * inspection tool for beginners.
 */
export function SectionPanel() {
  const { t } = useT();
  const section = useStore((s) => s.sectionAnalysis);
  const setSection = useStore((s) => s.setSectionAnalysis);
  const bodies = useStore((s) => s.bodies);

  // Slide range from the scene extents so the plane can sweep the whole model.
  const bb = combinedBounds(bodies);
  const range = bb
    ? {
        x: [bb.min.x - 5, bb.max.x + 5] as const,
        y: [bb.min.y - 5, bb.max.y + 5] as const,
        z: [bb.min.z - 5, bb.max.z + 5] as const,
      }
    : { x: [-50, 50] as const, y: [-50, 50] as const, z: [-50, 50] as const };
  const [lo, hi] = range[section.axis];

  return (
    <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-1.5">
      {section.active && (
        <div
          className="w-52 bg-panel/90 backdrop-blur-sm border border-panel-border rounded-lg shadow-lg p-2 space-y-2"
          role="group"
          aria-label={t('section.title')}
        >
          <div className="flex items-center gap-1.5">
            <Scissors size={12} className="text-accent" />
            <span className="text-[11px] font-medium text-text-primary flex-1">{t('section.title')}</span>
            <button
              onClick={() => setSection({ active: false })}
              className="text-text-muted hover:text-text-primary"
              aria-label={t('dialog.close')}
              title={t('dialog.close')}
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex items-center gap-1" role="tablist" aria-label={t('section.axis')}>
            {AXES.map((ax) => (
              <button
                key={ax}
                role="tab"
                aria-selected={section.axis === ax}
                onClick={() => setSection({ axis: ax, offset: 0 })}
                className={`flex-1 px-1.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  section.axis === ax
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`}
              >
                {ax.toUpperCase()}
              </button>
            ))}
            <button
              onClick={() => setSection({ flip: !section.flip })}
              className={`px-1.5 py-1 rounded transition-colors ${
                section.flip ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
              aria-label={t('section.flip')}
              aria-pressed={section.flip}
              title={t('section.flip')}
            >
              <FlipHorizontal2 size={12} />
            </button>
          </div>
          <label className="block">
            <span className="text-[10px] text-text-muted">
              {t('section.offset')}: <span className="font-mono text-text-secondary">{section.offset.toFixed(1)} mm</span>
            </span>
            <input
              type="range"
              min={lo}
              max={hi}
              step={0.5}
              value={Math.min(Math.max(section.offset, lo), hi)}
              onChange={(e) => setSection({ offset: Number(e.target.value) })}
              className="w-full accent-accent"
              aria-label={t('section.offset')}
            />
          </label>
          <p className="text-[10px] text-text-muted">{t('section.hint')}</p>
        </div>
      )}
      <button
        onClick={() => setSection({ active: !section.active })}
        className={`w-8 h-8 flex items-center justify-center rounded-md bg-panel/80 backdrop-blur-sm border transition-colors ${
          section.active
            ? 'border-accent/60 text-accent bg-accent/10'
            : 'border-panel-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
        }`}
        aria-label={t('section.title')}
        aria-pressed={section.active}
        title={`${t('section.title')} (X)`}
      >
        <Scissors size={15} />
      </button>
    </div>
  );
}
