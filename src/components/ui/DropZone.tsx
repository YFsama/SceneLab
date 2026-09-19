import { useEffect, useState, useCallback, useRef } from 'react';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { classifyDroppedFile, importMeshFile, openProjectFile } from '../../lib/io/importFiles';
import { confirmDiscardIfDirty } from '../../lib/projectActions';
import { Upload, FileBox, Box } from 'lucide-react';

/**
 * Window-wide drag-and-drop import (TinkerCAD/Fusion-style): drop mesh files
 * (.stl/.obj/.step/.stp/.3mf) or a .studio3d project anywhere onto the app.
 * A full-viewport overlay confirms the drop target; mesh files merge into the
 * scene, a project file replaces it (dirty-guarded). Any files that classify
 * as unknown are rejected with a toast naming the accepted types.
 */
export function DropZone() {
  const { t } = useT();
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire per-element; count depth so the overlay is steady.
  const depthRef = useRef(0);

  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    depthRef.current = 0;
    setDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;

    // Projects replace the scene — only the first, and only after confirm.
    const projectIdx = files.findIndex((f) => classifyDroppedFile(f.name) === 'studio3d');
    if (projectIdx !== -1 && !(await confirmDiscardIfDirty('project.open'))) {
      files.splice(projectIdx, 1);
    }

    let imported = 0;
    for (const file of files) {
      try {
        if (classifyDroppedFile(file.name) === 'studio3d') {
          await openProjectFile(file);
          return; // a project replaces the scene; stop processing the rest
        }
        const r = await importMeshFile(file);
        imported += r.bodyCount;
        if (r.exactEngine) showToast(t('toast.stepExact'), 'info');
      } catch (err) {
        showToast(`${t('toast.loadFailed')} "${file.name}": ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    if (imported > 0) showToast(`${t('toast.loaded')} — ${imported}`, 'success');
  }, [t]);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      depthRef.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault(); // needed so the browser lets us drop
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDrop]);

  if (!dragging) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface/70 backdrop-blur-sm pointer-events-none"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-2 px-10 py-8 rounded-xl border-2 border-dashed border-accent bg-panel/90">
        <Upload size={28} className="text-accent" />
        <p className="text-sm font-medium text-text-primary">{t('dropzone.title')}</p>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1"><Box size={12} /> STL · OBJ · STEP</span>
          <span className="flex items-center gap-1"><FileBox size={12} /> 3MF · studio3d</span>
        </div>
      </div>
    </div>
  );
}
