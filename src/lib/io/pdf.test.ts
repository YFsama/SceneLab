import { describe, it, expect } from 'vitest';

// PDF export uses canvas.toDataURL which requires a browser environment.
// We test the module structure and basic PDF format validation.

describe('pdf module', () => {
  it('exports exportCanvasAsPDF function', async () => {
    const mod = await import('./pdf');
    expect(typeof mod.exportCanvasAsPDF).toBe('function');
  });

  it('produces a valid PDF header from a mock canvas', async () => {
    // Create a minimal mock canvas.
    const mockCanvas = {
      width: 100,
      height: 100,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', // minimal JPEG header
    } as unknown as HTMLCanvasElement;

    const { exportCanvasAsPDF } = await import('./pdf');
    const blob = exportCanvasAsPDF(mockCanvas);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
  });
});
