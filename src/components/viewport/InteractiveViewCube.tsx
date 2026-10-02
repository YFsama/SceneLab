import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useT } from '../../lib/i18n';
// The 26-orientation tables and hit-classifying logic live in
// viewcubeOrientations.ts (shared with ViewCube.test.ts).
import { ORIENTATIONS, FACE_DIRS, classifyHit, type HitResult } from './viewcubeOrientations';

const FACE_BASE_COLORS = [0x4488cc, 0x4488cc, 0xcc6644, 0xcc6644, 0xcccccc, 0x666666];
const FACE_HOVER_COLOR = 0xffcc44;
const EDGE_HOVER_COLOR = 0xffaa22;
const CORNER_HOVER_COLOR = 0xff8800;

/** Material for a cube face (shared, mutated on hover). */
function faceMat(baseColor: number) {
  return new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.85 });
}

/** Build the cube as 6 separate face meshes + labels, parented to `group`. */
function buildCube(group: THREE.Group) {
  const half = 1;
  const faces: THREE.Mesh[] = [];
  const labels: THREE.Sprite[] = [];

  for (let i = 0; i < 6; i++) {
    const { normal, label } = FACE_DIRS[i]!;
    const geo = new THREE.PlaneGeometry(half * 2, half * 2);
    const mesh = new THREE.Mesh(geo, faceMat(FACE_BASE_COLORS[i]!));
    // Position the plane at the face of the cube
    mesh.position.copy(normal).multiplyScalar(half);
    // Orient it to face outward
    mesh.lookAt(mesh.position.clone().add(normal));
    mesh.userData = { faceIndex: i, label };
    group.add(mesh);
    faces.push(mesh);

    // Label sprite on the face
    const sprite = makeLabel(label, 0xffffff, 0.45);
    sprite.position.copy(normal).multiplyScalar(half + 0.01);
    // Orient label to face outward (same as the plane)
    sprite.lookAt(sprite.position.clone().add(normal));
    group.add(sprite);
    labels.push(sprite);
  }
  return { faces, labels };
}

/** Create a camera-facing text sprite. */
function makeLabel(text: string, color: number, worldHeight: number): THREE.Sprite {
  const fontPx = 48;
  const pad = 8;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `bold ${fontPx}px sans-serif`;
  const textW = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = textW + pad * 2;
  canvas.height = fontPx + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  return sprite;
}

// ── Hover highlight colors ──────────────────────────────────────────────────

function highlightColor(type: 'face' | 'edge' | 'corner'): number {
  if (type === 'corner') return CORNER_HOVER_COLOR;
  if (type === 'edge') return EDGE_HOVER_COLOR;
  return FACE_HOVER_COLOR;
}

// ── Component ───────────────────────────────────────────────────────────────

const CUBE_SIZE = 120; // px

export function InteractiveViewCube() {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cubeCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cubeGroupRef = useRef<THREE.Group | null>(null);
  const facesRef = useRef<THREE.Mesh[]>([]);
  const frameRef = useRef(0);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const hoveredFaceRef = useRef<number>(-1);
  const hoveredHitRef = useRef<HitResult | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; pos: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const mainCamStateRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const dirtyRef = useRef(true);

  // Listen for camera state responses from ViewportCanvas (for drag start).
  useEffect(() => {
    const onResponse = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        up: { x: number; y: number; z: number };
      };
      mainCamStateRef.current = {
        pos: new THREE.Vector3(d.position.x, d.position.y, d.position.z),
        target: new THREE.Vector3(d.target.x, d.target.y, d.target.z),
        up: new THREE.Vector3(d.up.x, d.up.y, d.up.z),
      };
    };
    window.addEventListener('viewport-camera-response', onResponse);
    return () => window.removeEventListener('viewport-camera-response', onResponse);
  }, []);

  // Set up the mini-scene
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(CUBE_SIZE, CUBE_SIZE);
    renderer.setClearColor(0x000000, 0); // transparent background
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    cubeCameraRef.current = camera;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(2, 3, 4);
    scene.add(dir);

    // Cube group (rotated to match main camera)
    const cubeGroup = new THREE.Group();
    scene.add(cubeGroup);
    cubeGroupRef.current = cubeGroup;

    const { faces } = buildCube(cubeGroup);
    facesRef.current = faces;

    // Wireframe overlay
    const wireGeo = new THREE.BoxGeometry(2.002, 2.002, 2.002);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 });
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(wireGeo), wireMat);
    cubeGroup.add(wire);

    // Render loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      if (dirtyRef.current) {
        renderer.render(scene, camera);
        dirtyRef.current = false;
      }
    };
    animate();

    // Listen for main camera updates from ViewportCanvas
    const onCamUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      };
      // Rotate the cube to match the main camera's orientation relative to the target.
      const dir = new THREE.Vector3(
        detail.position.x - detail.target.x,
        detail.position.y - detail.target.y,
        detail.position.z - detail.target.z,
      ).normalize();
      // The cube should show the same face the main camera sees.
      // We orient the cube so that its +Z face points toward the camera.
      cubeGroup.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        dir,
      );
      dirtyRef.current = true;
    };
    window.addEventListener('viewport-camera-update', onCamUpdate);

    return () => {
      window.removeEventListener('viewport-camera-update', onCamUpdate);
      cancelAnimationFrame(frameRef.current);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Mouse move: highlight face/edge/corner
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current;
    const camera = cubeCameraRef.current;
    const cubeGroup = cubeGroupRef.current;
    if (!container || !camera || !cubeGroup) return;

    if (draggingRef.current && dragStartRef.current && mainCamStateRef.current) {
      // Drag to orbit the main camera
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

      // Rotate the camera around the target by the drag delta.
      const camPos = mainCamStateRef.current.pos.clone();
      const camTarget = mainCamStateRef.current.target.clone();
      const camUp = mainCamStateRef.current.up.clone();

      // Offset from target
      const offset = camPos.clone().sub(camTarget);

      // Build rotations from drag delta
      const theta = -dx * 0.008; // horizontal rotation
      const phi = -dy * 0.008;   // vertical rotation

      // Horizontal rotation (around world Y)
      const rotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), theta);
      offset.applyQuaternion(rotY);
      camUp.applyQuaternion(rotY);

      // Vertical rotation (around the right axis)
      const right = new THREE.Vector3().crossVectors(camUp, offset).normalize();
      if (right.lengthSq() > 1e-6) {
        const rotV = new THREE.Quaternion().setFromAxisAngle(right, phi);
        offset.applyQuaternion(rotV);
        camUp.applyQuaternion(rotV);
      }

      const newPos = camTarget.clone().add(offset);
      window.dispatchEvent(new CustomEvent('viewport-camera-orbit', {
        detail: { position: { x: newPos.x, y: newPos.y, z: newPos.z }, up: { x: camUp.x, y: camUp.y, z: camUp.z } },
      }));
      return;
    }

    // Raycast to find hovered face
    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const hits = raycasterRef.current.intersectObjects(facesRef.current, false);

    // Reset previous highlight
    const prevFace = hoveredFaceRef.current;
    if (prevFace >= 0 && facesRef.current[prevFace]) {
      (facesRef.current[prevFace]!.material as THREE.MeshBasicMaterial).color.setHex(FACE_BASE_COLORS[prevFace]!);
    }

    if (hits.length > 0) {
      const hit = hits[0]!;
      const faceIdx = hit.object.userData.faceIndex as number;
      hoveredFaceRef.current = faceIdx;
      const result = classifyHit(hit);
      hoveredHitRef.current = result;
      if (result) {
        ((hit.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(highlightColor(result.type));
      }
      container.style.cursor = 'pointer';
    } else {
      hoveredFaceRef.current = -1;
      hoveredHitRef.current = null;
      container.style.cursor = 'default';
    }
    dirtyRef.current = true;
  }, []);

  // Mouse down: start drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const container = containerRef.current;
    const camera = cubeCameraRef.current;
    if (!container || !camera) return;

    // Check if we hit the cube
    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const hits = raycasterRef.current.intersectObjects(facesRef.current, false);

    if (hits.length > 0) {
      draggingRef.current = true;
      // Request current camera state from the viewport for drag orbiting
      window.dispatchEvent(new CustomEvent('viewport-camera-request'));
      dragStartRef.current = { x: e.clientX, y: e.clientY, pos: new THREE.Vector3(), up: new THREE.Vector3() };
    }
  }, []);

  // Mouse up: if it was a click (not a drag), navigate to that orientation
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const start = dragStartRef.current;
    draggingRef.current = false;
    dragStartRef.current = null;

    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);

    // If the mouse barely moved, treat it as a click → snap to orientation
    if (dx < 4 && dy < 4 && hoveredHitRef.current) {
      const ori = ORIENTATIONS[hoveredHitRef.current.orientationIndex];
      if (ori) {
        window.dispatchEvent(new CustomEvent('viewport-camera-snap', {
          detail: {
            position: { x: ori.position.x, y: ori.position.y, z: ori.position.z },
            up: { x: ori.up.x, y: ori.up.y, z: ori.up.z },
          },
        }));
      }
    }
  }, []);

  // Mouse leave: clear highlight
  const handleMouseLeave = useCallback(() => {
    const prevFace = hoveredFaceRef.current;
    if (prevFace >= 0 && facesRef.current[prevFace]) {
      (facesRef.current[prevFace]!.material as THREE.MeshBasicMaterial).color.setHex(FACE_BASE_COLORS[prevFace]!);
    }
    hoveredFaceRef.current = -1;
    hoveredHitRef.current = null;
    draggingRef.current = false;
    dragStartRef.current = null;
    dirtyRef.current = true;
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute top-3 right-3 rounded-md overflow-hidden border border-panel-border shadow-lg"
      style={{ width: CUBE_SIZE, height: CUBE_SIZE }}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      role="img"
      aria-label={t('viewport.controls')}
    />
  );
}
