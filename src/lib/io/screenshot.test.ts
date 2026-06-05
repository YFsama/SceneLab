import { describe, it, expect } from 'vitest';
import { captureViewport, getViewportBase64 } from './screenshot';

// Screenshot functions require a WebGL renderer — test the logic directly.

describe('screenshot module', () => {
  it('captureViewport returns a data URL', () => {
    // Mock renderer with a canvas that returns a data URL.
    const mockRenderer = {
      domElement: {
        toDataURL: (type: string) => `data:${type};base64,mockdata`,
      },
    } as unknown as import('three').WebGLRenderer;
    const result = captureViewport(mockRenderer);
    expect(result).toContain('data:image/png');
  });

  it('getViewportBase64 strips the data URL prefix', () => {
    const mockRenderer = {
      domElement: {
        toDataURL: () => 'data:image/png;base64,abc123def456',
      },
    } as unknown as import('three').WebGLRenderer;
    const result = getViewportBase64(mockRenderer);
    expect(result).toBe('abc123def456');
    expect(result).not.toContain('data:image');
  });

  it('getViewportBase64 returns empty string for empty data', () => {
    const mockRenderer = {
      domElement: {
        toDataURL: () => 'data:image/png;base64,',
      },
    } as unknown as import('three').WebGLRenderer;
    const result = getViewportBase64(mockRenderer);
    expect(result).toBe('');
  });
});
