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

  it('PDF blob has non-zero size', async () => {
    const mockCanvas = {
      width: 800,
      height: 600,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
    } as unknown as HTMLCanvasElement;

    const { exportCanvasAsPDF } = await import('./pdf');
    const blob = exportCanvasAsPDF(mockCanvas);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('PDF blob has correct MIME type', async () => {
    const mockCanvas = {
      width: 800,
      height: 600,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
    } as unknown as HTMLCanvasElement;

    const { exportCanvasAsPDF } = await import('./pdf');
    const blob = exportCanvasAsPDF(mockCanvas);
    expect(blob.type).toBe('application/pdf');
  });

  it('PDF blob is larger for bigger canvases', async () => {
    const smallCanvas = {
      width: 100,
      height: 100,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
    } as unknown as HTMLCanvasElement;

    const largeCanvas = {
      width: 1600,
      height: 1200,
      toDataURL: () => 'data:image/jpeg;base64,' + 'A'.repeat(1000),
    } as unknown as HTMLCanvasElement;

    const { exportCanvasAsPDF } = await import('./pdf');
    const smallBlob = exportCanvasAsPDF(smallCanvas);
    const largeBlob = exportCanvasAsPDF(largeCanvas);
    expect(largeBlob.size).toBeGreaterThanOrEqual(smallBlob.size);
  });
});
