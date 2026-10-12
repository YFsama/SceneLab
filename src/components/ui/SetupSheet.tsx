import { useRef, useState } from 'react';
import { X, Copy, Check, Download, Printer } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { copyText } from '../../lib/errorLog';
import { useEscapeClose } from '../../lib/hooks/useEscapeClose';

interface SetupSheetProps {
  /** The complete self-contained HTML document (generateSetupSheetHtml). */
  html: string;
  onClose: () => void;
}

/**
 * Setup sheet ("工艺卡") modal: previews the generated HTML document in an
 * iframe (the document carries its own inline styles, so the preview is the
 * print target) and owns its three hand-off actions — Copy (HTML source to
 * the clipboard), Download (.html file) and Print (the iframe's own document,
 * so the @media print rules of the sheet apply). GCodePreview's overlay
 * pattern: backdrop click and Escape close, stopPropagation on the panel.
 */
export function SetupSheet(props: SetupSheetProps) {
  const { t } = useT();
  useEscapeClose(props.onClose);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Optimistic 1.5 s label swap after the copy click (GCodePreview's copied
  // feedback); the real clipboard result lands as a toast.
  const [copied, setCopied] = useState(false);

  const onCopyClick = () => {
    void copyText(props.html).then((ok) => {
      showToast(ok ? t('cam.copied') : t('cam.copyFailed'), ok ? 'success' : 'error');
    });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const onDownloadClick = () => {
    // Dynamic import: a static one drags io/studio3d (and its io barrel
    // chain) into the entry chunk; this is an on-click path, latency-free.
    void import('../../lib/io/studio3d').then(({ downloadFile }) => {
      downloadFile(props.html, 'setup-sheet.html');
    });
  };

  const onPrintClick = () => {
    try {
      // Print the IFRAME's document, not the host page — the sheet's own
      // @media print rules then apply. jsdom/test webviews lack print();
      // swallowing keeps the modal usable there (Download still works).
      iframeRef.current?.contentWindow?.print();
    } catch {
      // Not supported — the downloaded file is the print fallback.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={props.onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('cam.setupSheetTitle')}
    >
      <div
        className="w-[44rem] max-w-[92vw] max-h-[80vh] flex flex-col bg-panel border border-panel-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('cam.setupSheetTitle')}</h2>
          <button
            onClick={props.onClose}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <X size={14} />
          </button>
        </div>

        {/* Bounded preview: the iframe scrolls its own document, so the modal
         * stays within its max height regardless of sheet length. White
         * background — the sheet's inline stylesheet assumes paper. */}
        <div className="flex-1 min-h-0 bg-white">
          <iframe
            ref={iframeRef}
            title={t('cam.setupSheetTitle')}
            srcDoc={props.html}
            className="w-full h-full min-h-[24rem] border-0"
          />
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
            onClick={onDownloadClick}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <Download size={12} />
            {t('cam.download')}
          </button>
          <button
            type="button"
            onClick={onPrintClick}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <Printer size={12} />
            {t('cam.print')}
          </button>
        </div>
      </div>
    </div>
  );
}
