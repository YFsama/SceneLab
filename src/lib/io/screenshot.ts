import type * as THREE from 'three';

/**
 * Render the scene once and capture the viewport as a PNG data URL, all in
 * the same task — the only way pixel reads are guaranteed to work now that
 * the renderer no longer keeps `preserveDrawingBuffer` on (that flag cost GPU
 * bandwidth on every frame; rendering on demand before a capture is free).
 * `camera` is optional; the renderer's current camera state is used when
 * omitted only if you pass one — three has no "current camera", so pass the
 * active camera explicitly.
 */
export function captureViewport(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): string {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

/** Render once, capture the viewport and trigger a PNG download. */
export function downloadViewportPNG(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  filename = 'scenelab-screenshot.png',
): void {
  renderer.render(scene, camera);
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

/** Render once and return the viewport as a base64 PNG for AI vision. */
export function getViewportBase64(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): string {
  const dataUrl = captureViewport(renderer, scene, camera);
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
