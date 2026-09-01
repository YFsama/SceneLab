import { useStore } from '../store/app';
import { confirm } from './confirm';
import { translations } from './i18n';
import { serializeProject, saveToFile, downloadFile, loadFromFile, deserializeFeatures, deserializeDirectBodies, deserializeReferenceGeometry, readFileAsText } from './io';
import { showToast } from './toast';
import { isTauri, callNative } from './runtime';

const tr = (k: string) => {
  const locale = useStore.getState().locale;
  return translations[locale]?.[k] ?? translations.en?.[k] ?? k;
};

/** Confirm (if dirty) then pick a .studio3d file and load it, replacing the
 * scene — the canonical "Open" used by the toolbar and Ctrl+O. Desktop (Tauri)
 * uses a native file dialog; browsers fall back to a hidden file input. */
export async function openProjectFromFile(): Promise<void> {
  if (!(await confirmDiscardIfDirty('project.open'))) return;
  if (isTauri()) {
    try {
      const picked = (await callNative('open_project_file')) as [string, string] | null;
      if (!picked) return; // cancelled
      const [json, name] = picked;
      const project = loadFromFile(json);
      useStore.getState().loadProject(
        deserializeFeatures(project), project.name, deserializeDirectBodies(project), deserializeReferenceGeometry(project),
      );
      showToast(`${tr('toast.loaded')} "${name}"`, 'success');
      return;
    } catch (err) {
      showToast(`${tr('toast.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.studio3d,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const project = loadFromFile(await readFileAsText(file));
      useStore.getState().loadProject(
        deserializeFeatures(project), project.name, deserializeDirectBodies(project), deserializeReferenceGeometry(project),
      );
      showToast(`${tr('toast.loaded')} "${project.name}"`, 'success');
    } catch (err) {
      showToast(`${tr('toast.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });
  input.click();
}

/** Serialize the current project and save it as a .studio3d file, clearing
 * the dirty flag — the canonical "Save" used by the toolbar and Ctrl+S.
 * Desktop writes a real file through a native Save dialog; browsers download. */
export async function saveProjectToFile(): Promise<void> {
  const s = useStore.getState();
  try {
    const project = serializeProject(s.projectName, s.featureTree.features, s.bodies, s.directBodies, {
      planes: s.planes, axes: s.axes, points: s.points, coordSystems: s.coordSystems, annotations: s.annotations,
    });
    const json = saveToFile(project);
    if (isTauri()) {
      const savedPath = (await callNative('save_project_file', {
        json,
        defaultName: `${s.projectName}.studio3d`,
      })) as string | null;
      if (savedPath === null) return; // cancelled — keep the dirty flag
    } else {
      downloadFile(json, `${s.projectName}.studio3d`);
    }
    s.setProjectDirty(false);
    showToast(tr('toast.projectSaved'), 'success');
  } catch (e) {
    showToast(`${tr('toast.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/**
 * Guard a scene-replacing action (New / Open) against discarding unsaved work,
 * mirroring SolidWorks' prompt. Returns true to proceed: immediately when the
 * document is clean, otherwise after the user confirms the discard. `titleKey`
 * is the i18n key for the dialog title (e.g. 'project.new' / 'project.open').
 */
export async function confirmDiscardIfDirty(titleKey: string): Promise<boolean> {
  const s = useStore.getState();
  if (!s.projectDirty) return true;
  return confirm({
    title: tr(titleKey),
    message: tr('project.unsavedWarning'),
    confirmLabel: tr('project.discard'),
    destructive: true,
  });
}
