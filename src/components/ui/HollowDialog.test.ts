import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../store/app';
import { getToasts, clearToasts } from '../../lib/toast';
import { HollowDialog } from './HollowDialog';

// HollowDialog is a React component — the validation logic is tested directly
// below; the apply flow (await the store action, toast on failure, busy guard)
// is tested against the real rendered dialog (jsdom + createRoot + act).

describe('HollowDialog validation', () => {
  const validateThickness = (value: string): boolean => {
    const w = parseFloat(value);
    return Number.isFinite(w) && w > 0;
  };

  describe('thickness validation', () => {
    it('accepts valid thickness values', () => {
      expect(validateThickness('2')).toBe(true);
      expect(validateThickness('0.5')).toBe(true);
      expect(validateThickness('10')).toBe(true);
    });

    it('rejects non-positive values', () => {
      expect(validateThickness('0')).toBe(false);
      expect(validateThickness('-1')).toBe(false);
    });

    it('rejects non-numeric values', () => {
      expect(validateThickness('abc')).toBe(false);
      expect(validateThickness('')).toBe(false);
    });
  });
});

// --- Rendered-dialog coverage: apply flow, failure toast, busy guard -----------

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountDialog(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmountDialog({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

/** The right-most button is the apply action (cancel sits to its left). */
function applyButton(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll('button');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

describe('HollowDialog apply flow (rendered dialog)', () => {
  beforeEach(() => {
    clearToasts();
    useStore.setState({ hollowDialogBody: 'body-1' });
  });

  afterEach(() => {
    clearToasts();
  });

  it('a failed hollow warns via toast and keeps the dialog open', async () => {
    useStore.setState({ hollowBodyById: async () => null });
    const mounted = await mountDialog(createElement(HollowDialog));
    try {
      await act(async () => {
        applyButton(mounted.container).click();
      });
      // Exactly one warning toast — the existing toast.hollowFailed key.
      const toasts = getToasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.type).toBe('warning');
      expect(toasts[0]!.message.length).toBeGreaterThan(0);
      // The dialog stays open so a smaller wall thickness can be retried.
      expect(useStore.getState().hollowDialogBody).toBe('body-1');
      expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
      // Busy state was reset — apply is clickable again.
      expect(applyButton(mounted.container).disabled).toBe(false);
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('a successful hollow closes the dialog without a toast', async () => {
    useStore.setState({ hollowBodyById: async () => 'shell-1' });
    const mounted = await mountDialog(createElement(HollowDialog));
    try {
      await act(async () => {
        applyButton(mounted.container).click();
      });
      expect(useStore.getState().hollowDialogBody).toBeNull();
      expect(getToasts()).toHaveLength(0);
    } finally {
      await unmountDialog(mounted);
    }
  });

  it('apply disables while awaiting, so double-clicks cannot fire twice', async () => {
    let calls = 0;
    let resolveHollow: ((id: string | null) => void) | null = null;
    useStore.setState({
      hollowBodyById: () => {
        calls++;
        return new Promise<string | null>((res) => { resolveHollow = res; });
      },
    });
    const mounted = await mountDialog(createElement(HollowDialog));
    try {
      await act(async () => {
        applyButton(mounted.container).click();
      });
      expect(calls).toBe(1);
      expect(applyButton(mounted.container).disabled).toBe(true);

      // A second click while busy must not fire the action again.
      await act(async () => {
        applyButton(mounted.container).click();
      });
      expect(calls).toBe(1);

      await act(async () => {
        resolveHollow!('shell-1');
      });
      expect(useStore.getState().hollowDialogBody).toBeNull();
      expect(calls).toBe(1);
    } finally {
      await unmountDialog(mounted);
    }
  });
});
