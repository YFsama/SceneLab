import { describe, it, expect } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { registerTool, getTool, getAllTools, unregisterTool, clearTools } from '../../lib/ai/toolRegistry';
import { registerBuiltinTools } from '../../lib/ai';
import type { AITool } from '../../lib/ai/types';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { AIPanel } from './AIPanel';

// Real coverage for the AI tool layer the AIPanel executes through: the
// registry contract and the builtin tool surface. Previously this file
// asserted literals about itself. AIPanel calls registerBuiltinTools() on
// mount — do the same, then snapshot the registered surface.

registerBuiltinTools();
const BUILTIN_TOOL_NAMES = getAllTools().map((t) => t.name);

function fakeTool(name: string): AITool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ ok: true }),
  };
}

describe('builtin tool surface', () => {
  it('registers a broad modeling toolset', () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(80);
    for (const expected of [
      'create_box', 'create_cylinder', 'extrude', 'revolve',
      'fillet', 'chamfer', 'shell', 'boolean_op', 'measure_face_angle',
      'import_mesh', 'export_body', 'linear_array', 'split_by_plane',
    ]) {
      expect(BUILTIN_TOOL_NAMES).toContain(expected);
    }
  });

  it('import_mesh accepts STEP content', () => {
    const tool = getTool('import_mesh')!;
    const enumProp = (tool.parameters.properties as Record<string, { enum?: string[] }>).format;
    expect(enumProp?.enum).toContain('step');
  });

  it('every builtin tool declares a JSON-schema description for the model', () => {
    for (const tool of getAllTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
    }
  });
});

describe('AI tool registry', () => {
  it('registers, retrieves and removes tools by name', () => {
    clearTools();
    registerTool(fakeTool('probe'));
    expect(getTool('probe')?.name).toBe('probe');
    expect(getAllTools()).toHaveLength(1);
    unregisterTool('probe');
    expect(getTool('probe')).toBeUndefined();
  });

  it('executing a registered tool runs its handler', async () => {
    clearTools();
    registerTool(fakeTool('runner'));
    const result = await getTool('runner')!.execute({});
    expect(result).toEqual({ ok: true });
  });
});

// F6 — the panel floats fixed bottom-right (z-40), which is where the CAM and
// Drawing panels put their lower controls; open-by-default it covered them.
// It must auto-collapse on those workspaces while manual open/close keeps
// working. jsdom + createRoot + act, the project's mount-harness style.
describe('AIPanel workspace auto-collapse (F6)', () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom does not implement scrollIntoView; the panel's message-autoscroll
  // effect calls it whenever messages change.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  const mountPanel = async (): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(AIPanel));
    });
    return {
      container,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  };

  const panelEl = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[role="complementary"]');
  const openButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${translations.en!['ai.openAssistant']}"]`);

  it('collapses when the workspace switches to cam or drawing, and toggling still works', async () => {
    useStore.setState({ workspace: 'model' });
    const { container, unmount } = await mountPanel();

    // Default-open in model: the floating panel body renders.
    expect(panelEl(container)).not.toBeNull();

    // CAM: body hidden, collapsed bot button shows instead.
    await act(async () => {
      useStore.getState().setWorkspace('cam');
    });
    expect(panelEl(container)).toBeNull();
    expect(openButton(container)).not.toBeNull();

    // Manual reopen still works while staying in cam.
    await act(async () => {
      openButton(container)!.click();
    });
    expect(panelEl(container)).not.toBeNull();

    // Drawing collapses it again.
    await act(async () => {
      useStore.getState().setWorkspace('drawing');
    });
    expect(panelEl(container)).toBeNull();

    // Back in model the panel stays collapsed until reopened manually — the
    // effect only ever collapses, never forces the panel open.
    await act(async () => {
      useStore.getState().setWorkspace('model');
    });
    expect(panelEl(container)).toBeNull();
    await act(async () => {
      openButton(container)!.click();
    });
    expect(panelEl(container)).not.toBeNull();

    await unmount();
    useStore.setState({ workspace: 'model' });
  });

  it('renders collapsed when mounted while already in the cam workspace', async () => {
    useStore.setState({ workspace: 'cam' });
    const { container, unmount } = await mountPanel();
    expect(panelEl(container)).toBeNull();
    expect(openButton(container)).not.toBeNull();
    await unmount();
    useStore.setState({ workspace: 'model' });
  });
});
