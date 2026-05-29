import type * as THREE from 'three';

/** Capture the current viewport as a PNG data URL */
export function captureViewport(renderer: THREE.WebGLRenderer): string {
  const canvas = renderer.domElement;

  // Force a render
  renderer.render(renderer.domElement as unknown as THREE.Scene, renderer.domElement as unknown as THREE.Camera);

  return canvas.toDataURL('image/png');
}

/** Capture viewport and trigger download */
export function downloadViewportPNG(renderer: THREE.WebGLRenderer, filename = 'scenelab-screenshot.png'): void {
  const canvas = renderer.domElement;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/** Get viewport as base64 string for AI vision */
export function getViewportBase64(renderer: THREE.WebGLRenderer): string {
  const dataUrl = captureViewport(renderer);
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
