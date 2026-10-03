import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PropertiesPanel } from './PropertiesPanel';
import { useStore } from '../../store/app';
import { createBox, createSphere, computeVolume } from '../../lib/geometry/brep';
import type { SolidBody } from '../../lib/geometry/types';
import * as brepModule from '../../lib/geometry/brep';

// Real coverage for the panel's memoization: the whole measurement battery
// (volume, area, print analysis, mesh stats) used to run inline in JSX on
// every render — including rename keystrokes, which only touch the renaming
// draft. These tests mount the real component (jsdom + createRoot + act, the
// project's mount-harness style — there is no testing-library) and count
// module-level calls across store-driven re-renders.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountPanel(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PropertiesPanel />);
  });
  return { container, root };
}

async function unmountPanel({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function selectBody(bodyId: string): void {
  act(() => {
    useStore.setState({ selectedIds: [bodyId] });
  });
}

/** Store seed applied while the panel is mounted (act-wrapped: subscribers). */
function seedMounted(body: ReturnType<typeof createBox>): void {
  act(() => {
    useStore.setState({ bodies: [body], directBodies: [body], objectIds: [body.id] });
  });
}

/** Store seed applied before the panel mounts (no subscribers yet). */
function seedIdle(body: ReturnType<typeof createBox>): void {
  useStore.setState({ bodies: [body], directBodies: [body], objectIds: [body.id] });
}

describe('PropertiesPanel measurement battery memoization', () => {
  let volumeSpy: MockInstance<(body: SolidBody) => number>;

  beforeEach(() => {
    useStore.setState({
      directBodies: [],
      bodies: [],
      objectIds: [],
      selectedIds: [],
      hiddenIds: [],
      undoStack: [],
      redoStack: [],
      renaming: null,
      sketchActive: false,
      currentSketch: null,
      selectedSketchId: null,
      showExtrudeDialog: false,
      showRevolveDialog: false,
    });
    volumeSpy = vi.spyOn(brepModule, 'computeVolume');
  });

  afterEach(() => {
    volumeSpy.mockRestore();
  });

  it('renders the selected body with its volume readout', async () => {
    const body = createBox(10, 10, 10);
    seedIdle(body);
    selectBody(body.id);
    const mounted = await mountPanel();
    const text = mounted.container.textContent ?? '';
    expect(text).toContain(`${computeVolume(body).toFixed(2)} mm³`);
    expect(text).toContain(body.name);
    await unmountPanel(mounted);
  });

  it('does not recompute the battery on rename keystrokes (memoized per body)', async () => {
    const body = createBox(10, 10, 10);
    seedIdle(body);
    selectBody(body.id);
    const mounted = await mountPanel();

    const initialCalls = volumeSpy.mock.calls.length;
    // The battery ran once for this body reference (volume section + anything
    // internal that delegates to computeVolume) — never zero, never huge.
    expect(initialCalls).toBeGreaterThanOrEqual(1);
    expect(initialCalls).toBeLessThanOrEqual(4);

    // Begin renaming and type three keystrokes — each setRenameValue is a
    // store update that re-renders the panel with the SAME body reference.
    act(() => { useStore.getState().beginRename(body.id); });
    for (const value of ['B', 'Bo', 'Box!']) {
      act(() => { useStore.getState().setRenameValue(value); });
    }
    expect(volumeSpy.mock.calls.length).toBe(initialCalls);

    // Cancelling the rename is also just a re-render — still no recompute.
    act(() => { useStore.getState().cancelRename(); });
    expect(volumeSpy.mock.calls.length).toBe(initialCalls);

    await unmountPanel(mounted);
  });

  it('recomputes exactly once more when the body is actually edited', async () => {
    const body = createBox(10, 10, 10);
    seedIdle(body);
    selectBody(body.id);
    const mounted = await mountPanel();
    const initialCalls = volumeSpy.mock.calls.length;

    // Committing a rename replaces the body object → the memo key changes →
    // the battery re-runs (once), exactly like any real edit would.
    act(() => { useStore.getState().beginRename(body.id); });
    act(() => { useStore.getState().setRenameValue('Renamed'); });
    act(() => { useStore.getState().commitRename(); });
    const afterCommit = volumeSpy.mock.calls.length;
    expect(afterCommit).toBeGreaterThan(initialCalls);
    expect(afterCommit - initialCalls).toBeLessThanOrEqual(4);
    expect(useStore.getState().bodies[0]!.name).toBe('Renamed');

    // Switching to a different body recomputes for the new reference.
    const sphere = createSphere(6, 24);
    seedMounted(sphere);
    selectBody(sphere.id);
    await act(async () => {});
    expect(volumeSpy.mock.calls.length).toBeGreaterThan(afterCommit);

    await unmountPanel(mounted);
  });

  it('keeps displayed values unchanged by the memoization (golden strings)', async () => {
    const body = createBox(10, 10, 10);
    seedIdle(body);
    selectBody(body.id);
    const mounted = await mountPanel();
    const before = mounted.container.textContent ?? '';

    act(() => { useStore.getState().beginRename(body.id); });
    act(() => { useStore.getState().setRenameValue('x'); });
    act(() => { useStore.getState().cancelRename(); });

    // Same body, same battery → every displayed figure identical after the
    // re-renders (the rename draft never reaches the readouts).
    expect(mounted.container.textContent).toBe(before);
    await unmountPanel(mounted);
  });
});
