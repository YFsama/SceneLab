import { useStore } from '../store/app';
import { confirm } from './confirm';
import { translations } from './i18n';

/**
 * Guard a scene-replacing action (New / Open) against discarding unsaved work,
 * mirroring SolidWorks' prompt. Returns true to proceed: immediately when the
 * document is clean, otherwise after the user confirms the discard. `titleKey`
 * is the i18n key for the dialog title (e.g. 'project.new' / 'project.open').
 */
export async function confirmDiscardIfDirty(titleKey: string): Promise<boolean> {
  const s = useStore.getState();
  if (!s.projectDirty) return true;
  const tr = (k: string) => translations[s.locale]?.[k] ?? translations.en?.[k] ?? k;
  return confirm({
    title: tr(titleKey),
    message: tr('project.unsavedWarning'),
    confirmLabel: tr('project.discard'),
    destructive: true,
  });
}
