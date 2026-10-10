import { useMemo, useState } from 'react';
import { X, Copy, Check, Download } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';

/**
 * Hard render cap: a 100k-line program must never become 100k DOM nodes —
 * everything past this many lines is summarized as "+N more lines" under the
 * code area (the Copy/Download callbacks still receive the FULL program).
 */
const PREVIEW_MAX_LINES = 4000;

interface GCodePreviewProps {
  /** Full G-code program text (rendering is capped, callbacks get it all). */
  gcode: string;
  /** True total line count of the program. */
  lineCount: number;
  /** Program size in bytes. */
  sizeBytes: number;
  /** Preformatted tool summary, e.g. "T1 ⌀6 · T2 ⌀3". */
  toolsUsed: string;
  /** Preformatted feed range, e.g. "300–1000 mm/min" (or "—"). */
  feedRange: string;
  /** Estimated machining time, minutes. */
  timeMin: number;
  /** Machine profile the program was generated for ('grbl' / 'linuxcnc'). */
  profile: string;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

/** One tile in the stats row above the code area. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-surface border border-panel-border px-2 py-1.5">
      <div className="text-[10px] text-text-muted">{label}</div>
      <div className="truncate font-mono text-xs text-text-primary" title={value}>{value}</div>
    </div>
  );
}

/**
 * Read-only G-code preview modal (pure display — the owner generates the
 * program and owns copy/download): title bar, a stats row, a scrollable
 * monospace code area capped at PREVIEW_MAX_LINES, and Copy/Download actions.
 * Mirrors the DiagnosticsDialog overlay style (backdrop click and Escape
 * close, stopPropagation on the panel).
 */
export function GCodePreview(props: GCodePreviewProps) {
  const { t } = useT();
  useEscapeClose(props.onClose);
  // Optimistic 1.5 s label swap after the copy click (DiagnosticsDialog's
  // copyOne feedback pattern); the real clipboard result is toasted by the
  // owner through onCopy.
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => {
    const all = props.gcode.split('\n');
    if (all.length > 0 && all[all.length - 1] === '') all.pop(); // trailing newline
    return all;
  }, [props.gcode]);
  const shown = lines.slice(0, PREVIEW_MAX_LINES);
  const hidden = Math.max(0, lines.length - shown.length);

  const onCopyClick = () => {
    props.onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={props.onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('cam.previewTitle')}
    >
      <div
        className="w-[44rem] max-w-[92vw] max-h-[80vh] flex flex-col bg-panel border border-panel-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('cam.previewTitle')}</h2>
          <button
            onClick={props.onClose}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
          <StatCard label={t('cam.lines')} value={String(props.lineCount)} />
          <StatCard label={t('cam.size')} value={`${(props.sizeBytes / 1024).toFixed(1)} KB`} />
          <StatCard label={t('cam.toolsUsed')} value={props.toolsUsed} />
          <StatCard label={t('cam.feedRange')} value={props.feedRange} />
          <StatCard label={t('cam.estTime')} value={`${props.timeMin.toFixed(1)} ${t('cam.minutes')}`} />
          <StatCard label={t('cam.profile')} value={props.profile} />
        </div>

        <div className="flex-1 min-h-0 overflow-auto border-t border-panel-border">
          <pre className="p-3 font-mono text-[11px] leading-relaxed text-text-primary whitespace-pre">{shown.join('\n')}</pre>
          {hidden > 0 && (
            <div className="sticky bottom-0 px-3 py-2 border-t border-panel-border bg-panel text-xs text-text-muted">
              {t('cam.moreLines', { n: hidden })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-panel-border p-3">
          <button
            type="button"
            onClick={onCopyClick}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-white bg-accent hover:bg-accent/80 transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t('cam.copied') : t('cam.copy')}
          </button>
          <button
            type="button"
            onClick={props.onDownload}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <Download size={12} />
            {t('cam.download')}
          </button>
        </div>
      </div>
    </div>
  );
}
