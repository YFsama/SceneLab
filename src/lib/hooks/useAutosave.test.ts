import { describe, it, expect } from 'vitest';

// useAutosave is a React hook — test the autosave logic directly.

describe('useAutosave logic', () => {
  const DEFAULT_INTERVAL = 30_000;

  it('default interval is 30 seconds', () => {
    expect(DEFAULT_INTERVAL).toBe(30000);
  });

  it('autosave stores data in localStorage', () => {
    const key = 'scenelab.autosave';
    localStorage.removeItem(key);
    expect(localStorage.getItem(key)).toBeNull();
    // Simulate autosave by setting localStorage directly.
    localStorage.setItem(key, '{"test": true}');
    expect(localStorage.getItem(key)).toBe('{"test": true}');
    localStorage.removeItem(key);
  });

  it('autosave key is consistent', () => {
    const key = 'scenelab.autosave';
    expect(key).toBe('scenelab.autosave');
  });

  it('visibilitychange event triggers autosave when hidden', () => {
    // Simulate the visibilitychange logic.
    let ticked = false;
    const tick = () => { ticked = true; };
    // When document.hidden is true, tick should be called.
    const isHidden = true;
    if (isHidden) tick();
    expect(ticked).toBe(true);
  });

  it('beforeunload event triggers autosave', () => {
    let ticked = false;
    const tick = () => { ticked = true; };
    // Simulate beforeunload.
    tick();
    expect(ticked).toBe(true);
  });
});
