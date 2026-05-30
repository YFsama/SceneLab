import { useEffect } from 'react';
import { useStore } from '../../store/app';

/**
 * Periodically autosave the project to localStorage while there are unsaved
 * changes, and once on tab-hide / unload. Restore with store.restoreAutosave().
 */
export function useAutosave(intervalMs = 30_000) {
  useEffect(() => {
    const tick = () => useStore.getState().autosave();
    const id = setInterval(tick, intervalMs);
    const onHide = () => {
      if (document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', tick);
    };
  }, [intervalMs]);
}
