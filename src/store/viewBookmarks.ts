import { create } from 'zustand';

/**
 * Camera view bookmarks (Fusion-style "bookmark this inspection angle"): a
 * small dedicated store, deliberately separate from app.ts — these are a
 * viewport preference, not document state (they survive New/Clear scene and
 * never dirty the project fingerprint / autosave).
 */
export interface ViewBookmark {
  id: string;
  /** Locale-neutral default 'View 1..n' (no i18n); no rename UI yet. */
  name: string;
  /** Perspective camera position at capture (plain-serializable). */
  position: { x: number; y: number; z: number };
  /** OrbitControls target (the orbit centre) at capture. */
  target: { x: number; y: number; z: number };
  /** Perspective camera orientation at capture; restore derives the up axis
   *  from it (camera-local +Y in world space). */
  quaternion: { x: number; y: number; z: number; w: number };
}

/** What capture sites hand to `add`; the store assigns id + default name. */
export type ViewBookmarkCapture = Omit<ViewBookmark, 'id' | 'name'> & Partial<Pick<ViewBookmark, 'name'>>;

const STORAGE_KEY = 'scenelab.viewBookmarks';
/** Maximum stored bookmarks; overflow drops the OLDEST entry. */
export const VIEW_BOOKMARK_CAP = 12;

// localStorage access guarded like app.ts's theme persistence helpers so the
// module also imports cleanly in non-DOM contexts.
const persist = (value: string): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const isVec3 = (v: unknown, keys: readonly string[]): boolean =>
  isRecord(v) && keys.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));

export const isViewBookmark = (v: unknown): v is ViewBookmark =>
  isRecord(v) &&
  typeof v.id === 'string' && v.id.length > 0 &&
  typeof v.name === 'string' &&
  isVec3(v.position, ['x', 'y', 'z']) &&
  isVec3(v.target, ['x', 'y', 'z']) &&
  isVec3(v.quaternion, ['x', 'y', 'z', 'w']);

/** Boot state: the persisted list, shape-checked entry by entry (a corrupted
 *  or truncated payload degrades to fewer bookmarks, never a crash). */
const loadPersisted = (): ViewBookmark[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isViewBookmark).slice(0, VIEW_BOOKMARK_CAP);
  } catch {
    return [];
  }
};

// Ids must stay unique ACROSS reloads (the list is persisted), so prefer
// randomUUID and fall back to a timestamped counter where crypto is absent.
let seq = 0;
const newId = (): string => {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;
  return uuid ?? `bm_${Date.now().toString(36)}_${(seq++).toString(36)}`;
};

export interface ViewBookmarkState {
  bookmarks: ViewBookmark[];
  /** Append a captured pose; returns the stored bookmark. Default name is the
   *  first free 'View n'; overflow drops the OLDEST entry. */
  add: (capture: ViewBookmarkCapture) => ViewBookmark;
  removeAt: (i: number) => void;
  clear: () => void;
}

export const useViewBookmarks = create<ViewBookmarkState>((set, get) => ({
  bookmarks: loadPersisted(),
  add: (capture) => {
    const { bookmarks } = get();
    // 'View 1..n': the smallest unused number, so a full set reads 1..n and a
    // freed slot is reused instead of drifting to ever-larger numbers.
    const taken = new Set(bookmarks.map((b) => b.name));
    let n = 1;
    while (taken.has(`View ${n}`)) n++;
    const bookmark: ViewBookmark = {
      id: newId(),
      name: capture.name ?? `View ${n}`,
      position: { ...capture.position },
      target: { ...capture.target },
      quaternion: { ...capture.quaternion },
    };
    const grown = [...bookmarks, bookmark];
    const next = grown.length > VIEW_BOOKMARK_CAP ? grown.slice(grown.length - VIEW_BOOKMARK_CAP) : grown;
    persist(JSON.stringify(next));
    set({ bookmarks: next });
    return bookmark;
  },
  removeAt: (i) => {
    const next = get().bookmarks.filter((_, idx) => idx !== i);
    persist(JSON.stringify(next));
    set({ bookmarks: next });
  },
  clear: () => {
    persist('[]');
    set({ bookmarks: [] });
  },
}));
