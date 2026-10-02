import { describe, it, expect, beforeEach } from 'vitest';
import { PrimitiveBar } from './PrimitiveBar';
import { PRIMITIVES } from './primitives';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The bar is data-driven — test the real exported table so the component
// cannot drift from it (previously this test re-declared the array).

describe('PrimitiveBar primitive table', () => {
  it('offers exactly the 9 PrimitiveKind values, in bar order', () => {
    expect(PRIMITIVES.map((p) => p.kind)).toEqual([
      'box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism', 'tube', 'coil',
    ]);
  });

  it('all kinds are unique (one button per primitive)', () => {
    const kinds = PRIMITIVES.map((p) => p.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('every entry has an icon, all distinct (renderability is proven by the rendered tests below)', () => {
    expect(PRIMITIVES.every((p) => p.icon != null)).toBe(true);
    expect(new Set(PRIMITIVES.map((p) => p.icon)).size).toBe(PRIMITIVES.length);
  });

  it('every kind has a label in both locales', () => {
    for (const { kind } of PRIMITIVES) {
      const key = `primitive.${kind}`;
      expect(translations.en?.[key], key).toBeTruthy();
      expect(translations.zh?.[key], key).toBeTruthy();
    }
  });
});

// --- Rendered coverage --------------------------------------------------------
// Same minimal mount harness the other component tests use (no testing-library
// in this project): render with createRoot inside act(), click the real button.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountBar(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmountBar({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function primitiveButton(container: HTMLElement, kind: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${translations.en![`primitive.${kind}`]!}"]`);
}

describe('PrimitiveBar (rendered)', () => {
  beforeEach(() => {
    useStore.setState({
      locale: 'en',
      pendingPrimitive: null,
      lastCommand: null,
      measureActive: false,
      showPartsLibrary: false,
    });
  });

  it('renders a toolbar with one labeled button per primitive plus library, planes and measure', async () => {
    const m = await mountBar(createElement(PrimitiveBar));
    try {
      const bar = m.container.querySelector('div[role="toolbar"]');
      expect(bar).not.toBeNull();
      expect(bar!.getAttribute('aria-label')).toBe(translations.en!['primitive.add']!);

      const buttons = m.container.querySelectorAll('button');
      // parts library + 9 primitives + standard planes + measure
      expect(buttons).toHaveLength(PRIMITIVES.length + 3);
      for (const { kind } of PRIMITIVES) {
        expect(primitiveButton(m.container, kind), kind).not.toBeNull();
      }
    } finally {
      await unmountBar(m);
    }
  });

  it('renders with the Chinese labels in the zh locale', async () => {
    useStore.getState().setLocale('zh');
    const m = await mountBar(createElement(PrimitiveBar));
    try {
      const btn = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.zh!['primitive.box']!}"]`,
      );
      expect(btn).not.toBeNull();
    } finally {
      await unmountBar(m);
      useStore.getState().setLocale('en');
    }
  });

  it('clicking a primitive button arms the pending primitive and the repeat command', async () => {
    const m = await mountBar(createElement(PrimitiveBar));
    try {
      await act(async () => {
        primitiveButton(m.container, 'box')!.click();
      });
      expect(useStore.getState().pendingPrimitive).toBe('box');
      expect(useStore.getState().lastCommand).toEqual({ type: 'primitive', kind: 'box' });
    } finally {
      await unmountBar(m);
    }
  });

  it('clicking the measure button toggles the measure tool', async () => {
    const m = await mountBar(createElement(PrimitiveBar));
    try {
      const measure = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.en!['measure.tool']!}"]`,
      )!;
      expect(measure.getAttribute('aria-pressed')).toBe('false');
      await act(async () => {
        measure.click();
      });
      expect(useStore.getState().measureActive).toBe(true);
      expect(measure.getAttribute('aria-pressed')).toBe('true');
    } finally {
      await unmountBar(m);
    }
  });
});
