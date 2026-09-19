// Shared mesh/project file import — one routing point used by the ProjectMenu
// picker AND the window-wide drag-and-drop zone (TinkerCAD/Fusion-style drop).
// Pure-ish: DOM File in, bodies into the store, result summary out; toasts and
// store access follow the projectActions pattern.
import { useStore } from '../../store/app';
import { translations } from '../i18n';
import { showToast } from '../toast';
import {
  readFileAsText, readFileAsArrayBuffer,
  importSTL, importOBJ, importSTEPAuto, import3MF,
  loadFromFile, deserializeFeatures, deserializeDirectBodies, deserializeReferenceGeometry,
} from '../io';

const tr = (k: string) => {
  const locale = useStore.getState().locale;
  return translations[locale]?.[k] ?? translations.en?.[k] ?? k;
};

export type DroppedKind = 'stl' | 'obj' | 'step' | '3mf' | 'studio3d' | 'unknown';

/** Route a filename to its importer (pure — unit-tested). */
export function classifyDroppedFile(name: string): DroppedKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step';
  if (lower.endsWith('.3mf')) return '3mf';
  if (lower.endsWith('.studio3d') || lower.endsWith('.json')) return 'studio3d';
  return 'unknown';
}

export interface ImportFileResult {
  kind: DroppedKind;
  /** Bodies added to the scene (0 for a project open). */
  bodyCount: number;
  /** True when the exact OCCT kernel produced the STEP bodies. */
  exactEngine?: boolean;
}

/**
 * Import ONE mesh file (.stl/.obj/.step/.stp/.3mf) into the scene. Throws on
 * parse failure — callers catch and toast. A `.studio3d`/`.json` file is NOT
 * handled here (it replaces the scene; see openProjectFile).
 */
export async function importMeshFile(file: File): Promise<ImportFileResult> {
  const kind = classifyDroppedFile(file.name);
  if (kind === 'unknown' || kind === 'studio3d') {
    throw new Error(tr('import.unsupportedType'));
  }
  const st = useStore.getState();
  if (kind === '3mf') {
    // 3MF: a ZIP package → one body per model object.
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const bodies = import3MF(bytes);
    if (bodies.length === 0) throw new Error('No faces parsed');
    st.addDirectBodies(bodies);
    return { kind, bodyCount: bodies.length };
  }
  if (kind === 'obj') {
    const body = importOBJ(await readFileAsText(file));
    if (body.faces.length === 0) throw new Error('No faces parsed');
    st.addDirectBody(body);
    return { kind, bodyCount: 1 };
  }
  if (kind === 'step') {
    // Curved STEP loads the exact OCCT kernel (lazy, first use only);
    // planar files stay on the fast pure parser.
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const text = new TextDecoder().decode(bytes);
    const { bodies, engine } = await importSTEPAuto(text, file.name.replace(/\.(step|stp)$/i, ''), bytes);
    if (bodies.every((b) => b.faces.length === 0)) throw new Error('No faces parsed');
    st.addDirectBodies(bodies);
    return { kind, bodyCount: bodies.length, exactEngine: engine === 'occt' };
  }
  // STL (binary or ASCII — importSTL sniffs).
  const body = importSTL(await readFileAsArrayBuffer(file));
  if (body.faces.length === 0) throw new Error('No faces parsed');
  st.addDirectBody(body);
  return { kind, bodyCount: 1 };
}

/** Open a `.studio3d` project file, replacing the scene (guarded if dirty). */
export async function openProjectFile(file: File): Promise<boolean> {
  const project = loadFromFile(await readFileAsText(file));
  const st = useStore.getState();
  st.loadProject(
    deserializeFeatures(project), project.name, deserializeDirectBodies(project), deserializeReferenceGeometry(project),
  );
  showToast(`${tr('toast.loaded')} "${file.name}"`, 'success');
  return true;
}
