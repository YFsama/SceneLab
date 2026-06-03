import { useStore } from '../store/app';
import { confirm } from './confirm';
import { translations } from './i18n';
import { serializeProject, saveToFile, downloadFile } from './io';
import { showToast } from './toast';

const tr = (k: string) => {
  const locale = useStore.getState().locale;
  return translations[locale]?.[k] ?? translations.en?.[k] ?? k;
};

/** Serialize the current project and download it as a .studio3d file, clearing
 * the dirty flag — the canonical "Save" used by the toolbar and Ctrl+S. */
export function saveProjectToFile(): void {
  const s = useStore.getState();
  try {
    const project = serializeProject(s.projectName, s.featureTree.features, s.bodies, s.directBodies, {
      planes: s.planes, axes: s.axes, points: s.points, coordSystems: s.coordSystems,
    });
    downloadFile(saveToFile(project), `${s.projectName}.studio3d`);
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
