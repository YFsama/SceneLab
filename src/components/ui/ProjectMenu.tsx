import { useRef } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { downloadFile, exportSTLBinary, exportOBJ, export3MFPackage } from '../../lib/io';
import { importMeshFile } from '../../lib/io/importFiles';
import { showToast } from '../../lib/toast';
import { confirmDiscardIfDirty, saveProjectToFile, openProjectFromFile } from '../../lib/projectActions';
import { Save, FolderOpen, Download, FileBox, Image, Upload, FilePlus } from 'lucide-react';
import { framingBodies } from '../../lib/render/fitView';
import { captureFreshCanvas } from '../../lib/render/capture';

export function ProjectMenu() {
  const { t } = useT();
  const projectName = useStore((s) => s.projectName);
  const bodies = useStore((s) => s.bodies);
  const selectedIds = useStore((s) => s.selectedIds);
  const meshInputRef = useRef<HTMLInputElement>(null);

  const handleSave = () => saveProjectToFile();

  const handleImportMesh = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const r = await importMeshFile(file);
      showToast(`${t('toast.loaded')} "${file.name}"${r.bodyCount > 1 ? ` (${r.bodyCount})` : ''}`, 'success');
      if (r.exactEngine) showToast(t('toast.stepExact'), 'info');
    } catch (err) {
      showToast(`${t('toast.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    if (meshInputRef.current) meshInputRef.current.value = '';
  };

  // Export the selection when something is selected, otherwise the whole scene.
  const exportBodies = () => framingBodies(bodies, selectedIds, true);

  const handleExportSTL = () => {
    const targets = exportBodies();
    if (targets.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    try {
      for (const body of targets) {
        const buffer = exportSTLBinary(body);
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${body.name}.stl`;
        a.click();
        URL.revokeObjectURL(url);
      }
      showToast(t('toast.stlExported'), 'success');
    } catch (e) {
      showToast(`${t('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const handleExportOBJ = () => {
    const targets = exportBodies();
    if (targets.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    try {
      for (const body of targets) {
        downloadFile(exportOBJ(body), `${body.name}.obj`);
      }
      showToast(t('toast.objExported'), 'success');
    } catch (e) {
      showToast(`${t('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const handleExport3MF = () => {
    const targets = exportBodies();
    if (targets.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    try {
      const pkg = export3MFPackage(targets);
      const blob = new Blob([pkg as BlobPart], { type: 'model/3mf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName}.3mf`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('toast.threemfExported'), 'success');
    } catch (e) {
      showToast(`${t('toast.exportFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const handleExportPNG = () => {
    // captureFreshCanvas forces a render right before reading pixels, so the
    // export works without preserveDrawingBuffer and always shows the current
    // frame (not whatever was last dirty).
    const canvas = captureFreshCanvas();
    if (!canvas) {
      showToast(t('toast.noViewport'), 'warning');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('toast.pngExported'), 'success');
    }, 'image/png');
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={async () => {
          // Guard against discarding unsaved work, as SolidWorks prompts on New.
          if (await confirmDiscardIfDirty('project.new')) useStore.getState().newProject();
        }}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.new')}
        title={t('project.new')}
      >
        <FilePlus size={14} />
        <span className="hidden sm:inline">{t('project.new')}</span>
      </button>

      <button
        onClick={handleSave}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.save')}
        title={t('project.save') + ' .studio3d'}
      >
        <Save size={14} />
        <span className="hidden sm:inline">{t('project.save')}</span>
      </button>

      <button
        onClick={() => openProjectFromFile()}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.open')}
        title={t('project.open') + ' .studio3d'}
      >
        <FolderOpen size={14} />
        <span className="hidden sm:inline">{t('project.open')}</span>
      </button>

      <button
        onClick={() => meshInputRef.current?.click()}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.import')}
        title={t('project.import') + ' STL / OBJ'}
      >
        <Upload size={14} />
        <span className="hidden sm:inline">{t('project.import')}</span>
      </button>

      <div className="w-px h-4 bg-panel-border mx-0.5" />

      <button
        onClick={handleExportSTL}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('export.stl')}
        title={t('export.stl')}
      >
        <Download size={14} />
        <span className="hidden md:inline">STL</span>
      </button>

      <button
        onClick={handleExportOBJ}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('export.obj')}
        title={t('export.obj')}
      >
        <Download size={14} />
        <span className="hidden md:inline">OBJ</span>
      </button>

      <button
        onClick={handleExport3MF}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('export.threemf')}
        title={t('export.threemf')}
      >
        <FileBox size={14} />
        <span className="hidden md:inline">3MF</span>
      </button>

      <button
        onClick={handleExportPNG}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('export.png')}
        title={t('export.png')}
      >
        <Image size={14} />
        <span className="hidden md:inline">PNG</span>
      </button>

      <input
        ref={meshInputRef}
        type="file"
        accept=".stl,.obj,.3mf,.step,.stp"
        onChange={handleImportMesh}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
