import { describe, it, expect, vi, beforeEach } from 'vitest';
import { showToast, subscribe, getToasts, clearToasts } from './toast';

describe('toast', () => {
  beforeEach(() => {
    clearToasts();
  });

  it('should start with empty toasts', () => {
    expect(getToasts()).toEqual([]);
  });

  it('should add a toast', () => {
    showToast('Test message', 'info');
    const toasts = getToasts();
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.message).toBe('Test message');
    expect(toasts[0]?.type).toBe('info');
  });

  it('should remove toast after duration', async () => {
    vi.useFakeTimers();
    showToast('Temporary', 'success', 100);
    expect(getToasts().length).toBe(1);

    vi.advanceTimersByTime(150);
    expect(getToasts().length).toBe(0);
    vi.useRealTimers();
  });

  it('should notify subscribers', () => {
    let received: unknown[] = [];
    const unsub = subscribe((t) => { received = t; });

    showToast('Test', 'warning');
    expect(received.length).toBe(1);
    expect((received[0] as { message: string }).message).toBe('Test');

    unsub();
  });

  it('should support different toast types', () => {
    showToast('Error msg', 'error');
    showToast('Success msg', 'success');
    const toasts = getToasts();
    expect(toasts.some((t) => t.type === 'error')).toBe(true);
    expect(toasts.some((t) => t.type === 'success')).toBe(true);
  });
});
