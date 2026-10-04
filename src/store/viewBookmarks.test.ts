import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useViewBookmarks, VIEW_BOOKMARK_CAP, isViewBookmark, type ViewBookmarkCapture } from './viewBookmarks';

const STORAGE_KEY = 'scenelab.viewBookmarks';

const capture = (n: number): ViewBookmarkCapture => ({
  position: { x: n, y: n + 1, z: n + 2 },
  target: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
});

/** The persisted JSON payload (what a reload would read). */
const storedJson = (): unknown[] => {
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as unknown[];
};

beforeEach(() => {
  localStorage.clear();
  useViewBookmarks.setState({ bookmarks: [] });
});

describe('viewBookmarks store', () => {
  it('adds bookmarks with sequential default names View 1..n and stable order', () => {
    useViewBookmarks.getState().add(capture(1));
    useViewBookmarks.getState().add(capture(2));
    useViewBookmarks.getState().add(capture(3));
    const bms = useViewBookmarks.getState().bookmarks;
    expect(bms.map((b) => b.name)).toEqual(['View 1', 'View 2', 'View 3']);
    expect(bms.map((b) => b.position.x)).toEqual([1, 2, 3]);
    // Plain-serializable payloads: numbers only, distinct ids.
    expect(new Set(bms.map((b) => b.id)).size).toBe(3);
    for (const b of bms) {
      expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    }
  });

  it('stores a plain copy — later mutation of the input cannot corrupt the entry', () => {
    const input = capture(5);
    useViewBookmarks.getState().add(input);
    input.position.x = 99;
    expect(useViewBookmarks.getState().bookmarks[0]!.position.x).toBe(5);
  });

  it('removeAt drops the indexed bookmark; clear empties the set', () => {
    useViewBookmarks.getState().add(capture(1));
    useViewBookmarks.getState().add(capture(2));
    useViewBookmarks.getState().add(capture(3));
    useViewBookmarks.getState().removeAt(1);
    expect(useViewBookmarks.getState().bookmarks.map((b) => b.name)).toEqual(['View 1', 'View 3']);
    // A freed number is reused: the next add fills the View 2 slot.
    useViewBookmarks.getState().add(capture(9));
    expect(useViewBookmarks.getState().bookmarks.map((b) => b.name)).toEqual(['View 1', 'View 3', 'View 2']);
    useViewBookmarks.getState().clear();
    expect(useViewBookmarks.getState().bookmarks).toEqual([]);
  });

  it('caps at 12 bookmarks, dropping the OLDEST on overflow', () => {
    for (let i = 0; i < VIEW_BOOKMARK_CAP + 3; i++) useViewBookmarks.getState().add(capture(i));
    const bms = useViewBookmarks.getState().bookmarks;
    expect(bms).toHaveLength(VIEW_BOOKMARK_CAP);
    // The first three captures were pushed out; survivors are captures 3..14.
    expect(bms[0]!.position.x).toBe(3);
    expect(bms[bms.length - 1]!.position.x).toBe(VIEW_BOOKMARK_CAP + 2);
  });

  it('every mutation round-trips through localStorage (same content as the state)', () => {
    useViewBookmarks.getState().add(capture(1));
    useViewBookmarks.getState().add(capture(2));
    expect(storedJson()).toEqual(useViewBookmarks.getState().bookmarks);
    useViewBookmarks.getState().removeAt(0);
    expect(storedJson()).toEqual(useViewBookmarks.getState().bookmarks);
    useViewBookmarks.getState().clear();
    expect(storedJson()).toEqual([]);
  });

  it('rehydrates the persisted list on module load (fresh import reads localStorage)', async () => {
    useViewBookmarks.getState().add(capture(7));
    useViewBookmarks.getState().add(capture(8));
    // Simulate a page reload: reset the module registry and re-import — the
    // store's initial state must be exactly what was persisted.
    vi.resetModules();
    const { useViewBookmarks: fresh } = await import('./viewBookmarks');
    const rehydrated = fresh.getState().bookmarks;
    expect(rehydrated.map((b) => b.position.x)).toEqual([7, 8]);
    expect(rehydrated.map((b) => b.name)).toEqual(['View 1', 'View 2']);
    // …and it keeps persisting from there.
    fresh.getState().removeAt(0);
    expect(storedJson()).toEqual(rehydrated.slice(1));
  });

  it('degrades to empty on corrupted or non-array payloads instead of crashing', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    vi.resetModules();
    const { useViewBookmarks: broken } = await import('./viewBookmarks');
    expect(broken.getState().bookmarks).toEqual([]);

    localStorage.setItem(STORAGE_KEY, '"just a string"');
    vi.resetModules();
    const { useViewBookmarks: notArray } = await import('./viewBookmarks');
    expect(notArray.getState().bookmarks).toEqual([]);
  });

  it('filters malformed entries out of a partially-valid persisted list', async () => {
    const good = useViewBookmarks.getState().add(capture(1));
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      good,
      { id: 'x', name: 'missing transforms' },
      { id: 42, name: 'bad id type', position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'y', name: 'NaN position', position: { x: Number.NaN, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
    ]));
    vi.resetModules();
    const { useViewBookmarks: partial } = await import('./viewBookmarks');
    const bms = partial.getState().bookmarks;
    expect(bms).toHaveLength(1);
    expect(bms[0]!.name).toBe('View 1');
  });

  it('a custom name is honoured as-is', () => {
    useViewBookmarks.getState().add({ ...capture(1), name: 'Undercut check' });
    expect(useViewBookmarks.getState().bookmarks[0]!.name).toBe('Undercut check');
  });

  it('isViewBookmark guards exported shape-checking', () => {
    expect(isViewBookmark(useViewBookmarks.getState().add(capture(1)))).toBe(true);
    expect(isViewBookmark(null)).toBe(false);
    expect(isViewBookmark({ id: 'a', name: 'a' })).toBe(false);
  });
});
