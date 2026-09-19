import { describe, it, expect } from 'vitest';
import { captureViewport, getViewportBase64 } from './screenshot';

// Screenshot functions require a WebGL renderer — test the logic with mocks.
// The capture helpers render first (preserveDrawingBuffer is off), so the
// mocks record the render call.

function mockRenderer(dataUrl: string) {
  const calls: string[] = [];
  const renderer = {
    domElement: { toDataURL: () => dataUrl },
    render: (scene: unknown, camera: unknown) => {
      calls.push(`render:${(scene as { id: string }).id}:${(camera as { id: string }).id}`);
    },
  } as unknown as import('three').WebGLRenderer;
  return { renderer, calls };
}

describe('screenshot module', () => {
  it('captureViewport renders first, then returns a data URL', () => {
    const { renderer, calls } = mockRenderer('data:image/png;base64,mockdata');
    const result = captureViewport(renderer, { id: 's1' } as never, { id: 'c1' } as never);
    expect(result).toContain('data:image/png');
    expect(calls).toEqual(['render:s1:c1']);
  });

  it('getViewportBase64 renders first and strips the data URL prefix', () => {
    const { renderer, calls } = mockRenderer('data:image/png;base64,abc123def456');
    const result = getViewportBase64(renderer, { id: 's1' } as never, { id: 'c1' } as never);
    expect(result).toBe('abc123def456');
    expect(result).not.toContain('data:image');
    expect(calls).toHaveLength(1);
  });

  it('getViewportBase64 returns empty string for empty data', () => {
    const { renderer } = mockRenderer('data:image/png;base64,');
    const result = getViewportBase64(renderer, {} as never, {} as never);
    expect(result).toBe('');
  });
});
