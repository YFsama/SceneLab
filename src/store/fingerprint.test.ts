// Fingerprint memoization (T1) and autosave tick efficiency / quota surfacing
// (T2). serializeProject is spied via a module mock so the tests can count
// full serializations — the expensive part the memo exists to avoid.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/io')>();
  return {
    ...actual,
    serializeProject: vi.fn(actual.serializeProject),
  };
});

import { useStore } from './app';
import { serializeProject } from '../lib/io';
import { FeatureTree } from '../lib/features/tree';
import { createBox } from '../lib/geometry';
import { createSketch, addRectangle } from '../lib/sketch/engine';
import { subscribe, clearToasts } from '../lib/toast';

const serializeSpy = vi.mocked(serializeProject);

const messages: string[] = [];
subscribe((ts) => {
  messages.length = 0;
  messages.push(...ts.map((t) => t.message));
});

/** Fresh scene: empty tree, empty history, no sketch session. */
const resetScene = () => {
  useStore.setState({
    featureTree: new FeatureTree(),
    bodies: [],
    directBodies: [],
    objectIds: [],
    selectedIds: [],
    undoStack: [],
    redoStack: [],
    currentSketch: null,
    sketchActive: false,
    workspace: 'model',
  });
};

beforeEach(() => {
  resetScene();
  clearToasts();
  serializeSpy.mockClear();
});

describe('projectFingerprint memoization (T1)', () => {
  it('serializes once for repeated calls with unchanged input references', () => {
    useStore.setState({ directBodies: [createBox(10, 10, 10)] });

    useStore.getState().captureSavedFingerprint(); // calls projectFingerprint()
    expect(serializeSpy).toHaveBeenCalledTimes(1);
    const first = useStore.getState().savedFingerprint;

    useStore.getState().captureSavedFingerprint(); // same refs → memo hit
    expect(serializeSpy).toHaveBeenCalledTimes(1);
    expect(useStore.getState().savedFingerprint).toBe(first);
    expect(first).toBeTruthy();
  });

  it('recomputes when the directBodies array identity changes', () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ directBodies: [box] });
    useStore.getState().captureSavedFingerprint();
    expect(serializeSpy).toHaveBeenCalledTimes(1);

    // Same content, NEW array identity — the memo must not trust stale refs.
    useStore.setState({ directBodies: [box] });
    useStore.getState().captureSavedFingerprint();
    expect(serializeSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the feature list mutates in place (performExtrude adds features)', () => {
    useStore.getState().captureSavedFingerprint(); // empty tree baseline
    const empty = useStore.getState().savedFingerprint;
    expect(serializeSpy).toHaveBeenCalledTimes(1);

    const sketch = createSketch('xy');
    addRectangle(sketch, 0, 0, 10, 10);
    useStore.setState({ currentSketch: sketch });
    expect(useStore.getState().performExtrude(10, false)).toBe(true);

    serializeSpy.mockClear();
    useStore.getState().captureSavedFingerprint();
    expect(serializeSpy).toHaveBeenCalledTimes(1); // recomputed, not the stale memo
    expect(useStore.getState().savedFingerprint).not.toBe(empty);
  });

  it('undo/redo fingerprint comparisons reuse the memo when refs repeat', () => {
    useStore.setState({ directBodies: [] });
    useStore.getState().addDirectBody(createBox(10, 10, 10)); // boxA — the future baseline
    useStore.getState().captureSavedFingerprint();

    // Two real (undoable) edits, then undo×2 — the fingerprint is asked for on
    // every undo/redo to decide the dirty dot.
    useStore.getState().addDirectBody(createBox(4, 4, 4));
    useStore.getState().addDirectBody(createBox(2, 2, 2));
    serializeSpy.mockClear();

    useStore.getState().undo(); // → [boxA, boxB]
    useStore.getState().undo(); // → [boxA] (=== saved baseline)
    expect(useStore.getState().projectDirty).toBe(false);
    const afterUndos = serializeSpy.mock.calls.length;
    expect(afterUndos).toBeGreaterThan(0); // each restored state computed once

    // A second consumer asking for the SAME state (refs unchanged) is free.
    useStore.getState().captureSavedFingerprint();
    expect(serializeSpy.mock.calls.length).toBe(afterUndos); // memo hit
  });
});

describe('autosave tick efficiency + quota surfacing (T2)', () => {
  beforeEach(() => {
    localStorage.removeItem('scenelab.autosave');
  });

  it('skips the serialize+write when nothing changed since the last successful write', () => {
    useStore.setState({ directBodies: [createBox(10, 10, 10)], projectDirty: true });
    expect(useStore.getState().autosave()).toBe(true);
    expect(localStorage.getItem('scenelab.autosave')).not.toBeNull();

    // projectDirty is still true (only an explicit save clears it) — the skip
    // must come from the fingerprint comparison, not the dirty flag.
    expect(useStore.getState().projectDirty).toBe(true);
    const afterFirst = serializeSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    serializeSpy.mockClear();
    expect(useStore.getState().autosave()).toBe(false); // unchanged → fast skip
    expect(serializeSpy).not.toHaveBeenCalled(); // zero serializations
  });

  it('writes again after an edit changes the project', () => {
    useStore.setState({ directBodies: [createBox(10, 10, 10)], projectDirty: true });
    expect(useStore.getState().autosave()).toBe(true);
    serializeSpy.mockClear();

    useStore.setState({ directBodies: [createBox(10, 10, 10), createBox(3, 3, 3)], projectDirty: true });
    expect(useStore.getState().autosave()).toBe(true);
    expect(serializeSpy).toHaveBeenCalled();
  });

  it('surfaces a quota failure exactly once per session and keeps returning false', () => {
    useStore.setState({ directBodies: [createBox(7, 7, 7)], projectDirty: true });
    const quotaToasts = () => messages.filter((m) => /quota/i.test(m));

    // Spy on the REALM of the test's localStorage object — the setup file
    // mounts it from a private JSDOM realm, so Storage.prototype of the
    // global realm would not intercept it.
    const storageProto = Object.getPrototypeOf(localStorage) as Storage;
    const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      expect(useStore.getState().autosave()).toBe(false);
      expect(quotaToasts()).toHaveLength(1);

      // Still dirty + still failing — the retry must not repeat the warning.
      expect(useStore.getState().autosave()).toBe(false);
      expect(quotaToasts()).toHaveLength(1);
    } finally {
      setItem.mockRestore();
    }
  });
});
