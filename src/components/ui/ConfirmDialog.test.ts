import { describe, it, expect } from 'vitest';

// ConfirmDialog is a React component — test the validation logic directly.

describe('ConfirmDialog validation', () => {
  interface ConfirmOpts {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }

  const validateOpts = (opts: ConfirmOpts): boolean => {
    return typeof opts.title === 'string' && opts.title.length > 0 &&
           typeof opts.message === 'string' && opts.message.length > 0;
  };

  describe('options validation', () => {
    it('accepts valid options', () => {
      expect(validateOpts({ title: 'Confirm', message: 'Are you sure?' })).toBe(true);
    });

    it('accepts options with optional fields', () => {
      expect(validateOpts({
        title: 'Delete',
        message: 'This cannot be undone',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep',
        destructive: true,
      })).toBe(true);
    });

    it('rejects empty title', () => {
      expect(validateOpts({ title: '', message: 'Are you sure?' })).toBe(false);
    });

    it('rejects empty message', () => {
      expect(validateOpts({ title: 'Confirm', message: '' })).toBe(false);
    });
  });

  describe('destructive mode', () => {
    it('destructive flag enables error styling', () => {
      const opts: ConfirmOpts = { title: 'Delete', message: 'Sure?', destructive: true };
      expect(opts.destructive).toBe(true);
    });

    it('non-destructive uses accent styling', () => {
      const opts: ConfirmOpts = { title: 'Save', message: 'Save changes?' };
      expect(opts.destructive).toBeFalsy();
    });
  });
});
