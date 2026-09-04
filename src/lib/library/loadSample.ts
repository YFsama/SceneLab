// Sample-project orchestration: guard unsaved work, replace the scene, toast.
import { useStore } from '../../store/app';
import { confirmDiscardIfDirty } from '../projectActions';
import { findSampleProject, SAMPLE_PROJECTS } from './samples';
import { translations } from '../i18n';
import { showToast } from '../toast';

const tr = (k: string) => {
  const locale = useStore.getState().locale;
  return translations[locale]?.[k] ?? translations.en?.[k] ?? k;
};

/** Localized sample name for the welcome card / command palette / toasts. */
export function sampleLabel(id: string): string {
  const locale = useStore.getState().locale;
  const map = translations[locale] ?? translations.en!;
  return map[`sample.${id}`] ?? translations.en![`sample.${id}`] ?? id;
}

/**
 * Load a starter project by id: confirm if the current document is dirty,
 * start a fresh project and insert the sample's bodies (one undo step via
 * addDirectBodies). Returns true when the scene was replaced.
 */
export async function loadSampleProject(sampleId: string): Promise<boolean> {
  const sample = findSampleProject(sampleId);
  if (!sample) return false;
  if (!(await confirmDiscardIfDirty('sample.load'))) return false;

  const st = useStore.getState();
  st.newProject();
  const bodies = sample.build();
  st.addDirectBodies(bodies);
  useStore.setState({ selectedIds: bodies.map((b) => b.id) });
  showToast(`${tr('sample.loaded')}: ${sampleLabel(sampleId)}`, 'success');
  return true;
}

export { SAMPLE_PROJECTS };
