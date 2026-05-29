import { describe, it, expect } from 'vitest';
import { confirm, resolveConfirm, subscribeConfirm, getPendingConfirm } from './confirm';

describe('confirm', () => {
  it('should return a promise', () => {
    const result = confirm({ title: 'Test', message: 'Are you sure?' });
    expect(result).toBeInstanceOf(Promise);
    // Clean up
    resolveConfirm(false);
  });

  it('should resolve with true when confirmed', async () => {
    const promise = confirm({ title: 'Test', message: 'Are you sure?' });
    resolveConfirm(true);
    const result = await promise;
    expect(result).toBe(true);
  });

  it('should resolve with false when cancelled', async () => {
    const promise = confirm({ title: 'Test', message: 'Are you sure?' });
    resolveConfirm(false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('should notify subscribers', () => {
    let receivedOpts: unknown = null;
    const unsub = subscribeConfirm((opts) => { receivedOpts = opts; });

    confirm({ title: 'Test', message: 'Msg' });
    expect(receivedOpts).toEqual({ title: 'Test', message: 'Msg' });

    resolveConfirm(false);
    unsub();
  });

  it('should clear pending confirm after resolve', () => {
    confirm({ title: 'Test', message: 'Msg' });
    expect(getPendingConfirm()).toBeDefined();
    resolveConfirm(false);
    expect(getPendingConfirm()).toBeNull();
  });
});
