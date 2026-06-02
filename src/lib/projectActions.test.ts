import { describe, it, expect } from 'vitest';
import { confirmDiscardIfDirty } from './projectActions';
import { getPendingConfirm, resolveConfirm } from './confirm';
import { useStore } from '../store/app';

describe('confirmDiscardIfDirty', () => {
  it('proceeds immediately (no dialog) when the document is clean', async () => {
    useStore.setState({ projectDirty: false });
    const result = await confirmDiscardIfDirty('project.new');
    expect(result).toBe(true);
    expect(getPendingConfirm()).toBeNull(); // never opened a dialog
  });

  it('opens a confirm dialog when dirty and resolves with the choice', async () => {
    useStore.setState({ projectDirty: true });
    const promise = confirmDiscardIfDirty('project.new');
    expect(getPendingConfirm()).not.toBeNull(); // dialog shown
    resolveConfirm(false);
    expect(await promise).toBe(false);

    const promise2 = confirmDiscardIfDirty('project.open');
    resolveConfirm(true);
    expect(await promise2).toBe(true);
    useStore.setState({ projectDirty: false });
  });
});
