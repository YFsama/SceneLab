import { useRef } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { serializeProject, saveToFile, loadFromFile, deserializeFeatures, downloadFile, readFileAsText, exportSTLBinary, export3MF } from '../../lib/io';
import { showToast } from '../../lib/toast';
import { Save, FolderOpen, Download, FileBox, Image } from 'lucide-react';

export function ProjectMenu() {
  const { t } = useT();
  const projectName = useStore((s) => s.projectName);
  const featureTree = useStore((s) => s.featureTree);
  const bodies = useStore((s) => s.bodies);
  const setProjectDirty = useStore((s) => s.setProjectDirty);
  const loadProject = useStore((s) => s.loadProject);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = () => {
    try {
      const project = serializeProject(projectName, featureTree.features, bodies);
      const json = saveToFile(project);
      downloadFile(json, `${projectName}.studio3d`);
      setProjectDirty(false);
      showToast(t('toast.projectSaved'), 'success');
    } catch (e) {
      showToast(`${t('toast.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const handleLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const json = await readFileAsText(file);
      const project = loadFromFile(json);
      // Rebuild the parametric model, not just the name.
      loadProject(deserializeFeatures(project), project.name);
      showToast(`${t('toast.loaded')} "${project.name}"`, 'success');
    } catch (err) {
      showToast(`${t('toast.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleExportSTL = () => {
    if (bodies.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    try {
      for (const body of bodies) {
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

  const handleExport3MF = () => {
    if (bodies.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    try {
      const xml = export3MF(bodies);
      const blob = new Blob([xml], { type: 'application/xml' });
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
    const canvas = document.querySelector('canvas');
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
        onClick={handleSave}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.save')}
        title={t('project.save') + ' .studio3d'}
      >
        <Save size={14} />
        <span className="hidden sm:inline">{t('project.save')}</span>
      </button>

      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
        aria-label={t('project.open')}
        title={t('project.open') + ' .studio3d'}
      >
        <FolderOpen size={14} />
        <span className="hidden sm:inline">{t('project.open')}</span>
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
        ref={fileInputRef}
        type="file"
        accept=".studio3d,.json"
        onChange={handleLoad}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
