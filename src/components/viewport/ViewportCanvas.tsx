import { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useStore, type ViewDirection, type SketchPlaneId } from '../../store/app';
import { createSketch } from '../../lib/sketch/engine';
import { buildBodyMeshArrays } from '../../lib/render/bodyGeometry';
import { useT } from '../../lib/i18n';

const VIEW_DIRECTIONS: Record<ViewDirection, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
  top: { pos: new THREE.Vector3(0, 10, 0), up: new THREE.Vector3(0, 0, -1) },
  front: { pos: new THREE.Vector3(0, 0, 10), up: new THREE.Vector3(0, 1, 0) },
  right: { pos: new THREE.Vector3(10, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  iso: { pos: new THREE.Vector3(5, 5, 5), up: new THREE.Vector3(0, 1, 0) },
};

const PLANE_COLORS: Record<SketchPlaneId, number> = {
  xy: 0x89b4fa,
  xz: 0xa6e3a1,
  yz: 0xf38ba8,
};

export function ViewportCanvas() {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const planesGroupRef = useRef<THREE.Group | null>(null);
  const sketchGroupRef = useRef<THREE.Group | null>(null);
  const bodiesGroupRef = useRef<THREE.Group | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

  const viewDirection = useStore((s) => s.viewDirection);
  const sketchActive = useStore((s) => s.sketchActive);
  const sketchTool = useStore((s) => s.sketchTool);
  const currentSketch = useStore((s) => s.currentSketch);
  const drawStart = useStore((s) => s.drawStart);
  const bodies = useStore((s) => s.bodies);
  const deselectAll = useStore((s) => s.deselectAll);
  const setSketchActive = useStore((s) => s.setSketchActive);
  const setCurrentSketch = useStore((s) => s.setCurrentSketch);
  const setSketchPlaneId = useStore((s) => s.setSketchPlaneId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const setDrawStart = useStore((s) => s.setDrawStart);
  const addSketchLine = useStore((s) => s.addSketchLine);
  const addSketchRect = useStore((s) => s.addSketchRect);
  const addSketchCircle = useStore((s) => s.addSketchCircle);
  const addSketchArc = useStore((s) => s.addSketchArc);

  const dirtyRef = useRef(true);
  const frameIdRef2 = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const animate = () => {
      frameIdRef2.current = requestAnimationFrame(animate);
      const controls = controlsRef.current;
      if (controls) {
        const moved = controls.update();
        if (moved) dirtyRef.current = true;
      }
      if (dirtyRef.current) {
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (renderer && scene && camera) {
          renderer.render(scene, camera);
        }
        dirtyRef.current = false;
      }
    };

    // Capture the shared sketch materials so the cleanup disposes the exact
    // instances this effect set up (refs are stable across the component life).
    const lineMat = sketchLineMatRef.current;
    const pointMat = sketchPointMatRef.current;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // Ask the OS to pick the discrete GPU on dual-GPU machines.
      powerPreference: 'high-performance',
    });
    // Clamp the device pixel ratio: above 2x the extra fragments cost a lot of
    // GPU time for no visible gain on a CAD viewport.
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x1e1e2e);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    const grid = new THREE.GridHelper(20, 20, 0x313244, 0x313244);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    scene.add(grid);

    const axes = new THREE.AxesHelper(2);
    scene.add(axes);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const planesGroup = new THREE.Group();
    planesGroup.name = 'sketch-planes';
    scene.add(planesGroup);
    planesGroupRef.current = planesGroup;

    const sketchGroup = new THREE.Group();
    sketchGroup.name = 'sketch-drawing';
    scene.add(sketchGroup);
    sketchGroupRef.current = sketchGroup;

    const bodiesGroup = new THREE.Group();
    bodiesGroup.name = 'bodies';
    scene.add(bodiesGroup);
    bodiesGroupRef.current = bodiesGroup;

    animate();

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // Re-clamp in case the window moved to a monitor with a different DPR.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h);
      dirtyRef.current = true;
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    // Stop the render loop entirely while the window is hidden so a
    // backgrounded app draws nothing and consumes no GPU.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frameIdRef2.current);
        frameIdRef2.current = 0;
      } else if (frameIdRef2.current === 0) {
        dirtyRef.current = true;
        animate();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(frameIdRef2.current);
      ro.disconnect();
      controls.dispose();
      // Dispose shared sketch materials
      lineMat.dispose();
      pointMat.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const dir = VIEW_DIRECTIONS[viewDirection];
    camera.position.copy(dir.pos);
    camera.up.copy(dir.up);
    controls.target.set(0, 0, 0);
    controls.update();
    // Snapping the camera is an instant jump; mark dirty so the on-demand loop
    // repaints even if OrbitControls reports no incremental movement.
    dirtyRef.current = true;
  }, [viewDirection]);

  useEffect(() => {
    const planesGroup = planesGroupRef.current;
    if (!planesGroup) return;

    while (planesGroup.children.length > 0) {
      const child = planesGroup.children[0]!;
      planesGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    if (sketchActive) return;

    const planeSize = 3;
    const planeAlpha = 0.15;

    const makePlane = (rotAxis: 'x' | 'y' | null, color: number, planeId: SketchPlaneId) => {
      const geo = new THREE.PlaneGeometry(planeSize, planeSize);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: planeAlpha,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      if (rotAxis === 'x') mesh.rotation.x = Math.PI / 2;
      if (rotAxis === 'y') mesh.rotation.y = Math.PI / 2;
      mesh.name = `plane-${planeId}`;
      mesh.userData = { planeId };
      planesGroup.add(mesh);
    };

    makePlane(null, PLANE_COLORS.xy, 'xy');
    makePlane('x', PLANE_COLORS.xz, 'xz');
    makePlane('y', PLANE_COLORS.yz, 'yz');
    dirtyRef.current = true;
  }, [sketchActive]);

  // Shared materials for sketch rendering (created once, disposed on unmount)
  const sketchLineMatRef = useRef(new THREE.LineBasicMaterial({ color: 0xcdd6f4 }));
  const sketchPointMatRef = useRef(new THREE.PointsMaterial({ color: 0x89b4fa, size: 6, sizeAttenuation: false }));

  useEffect(() => {
    const sketchGroup = sketchGroupRef.current;
    if (!sketchGroup) return;

    // Clean up geometry only (materials are shared and managed separately)
    while (sketchGroup.children.length > 0) {
      const child = sketchGroup.children[0]!;
      sketchGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Points) {
        child.geometry.dispose();
      } else if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }

    if (!currentSketch || !sketchActive) return;

    const lineMat = sketchLineMatRef.current;
    const pointMat = sketchPointMatRef.current;

    for (const entity of currentSketch.entities.values()) {
      switch (entity.type) {
        case 'point': {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute([entity.x, 0, entity.y], 3));
          sketchGroup.add(new THREE.Points(geo, pointMat));
          break;
        }
        case 'line': {
          const p1 = currentSketch.entities.get(entity.p1Id);
          const p2 = currentSketch.entities.get(entity.p2Id);
          if (p1?.type === 'point' && p2?.type === 'point') {
            const geo = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(p1.x, 0, p1.y),
              new THREE.Vector3(p2.x, 0, p2.y),
            ]);
            sketchGroup.add(new THREE.Line(geo, lineMat));
          }
          break;
        }
        case 'circle': {
          const center = currentSketch.entities.get(entity.centerId);
          if (center?.type === 'point') {
            const curve = new THREE.EllipseCurve(center.x, center.y, entity.radius, entity.radius, 0, Math.PI * 2, false, 0);
            const pts = curve.getPoints(64);
            const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)));
            sketchGroup.add(new THREE.Line(geo, lineMat));
          }
          break;
        }
        case 'arc': {
          const center = currentSketch.entities.get(entity.centerId);
          if (center?.type === 'point') {
            const curve = new THREE.EllipseCurve(center.x, center.y, entity.radius, entity.radius, entity.startAngle, entity.endAngle, false, 0);
            const pts = curve.getPoints(64);
            const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)));
            sketchGroup.add(new THREE.Line(geo, lineMat));
          }
          break;
        }
        case 'rectangle': {
          const ids = [entity.p1Id, entity.p2Id, entity.p3Id, entity.p4Id, entity.p1Id];
          const pts = ids
            .map((id) => currentSketch.entities.get(id))
            .filter((e): e is import('../../lib/sketch/types').SketchPoint => e?.type === 'point')
            .map((e) => new THREE.Vector3(e.x, 0, e.y));
          if (pts.length >= 5) {
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            sketchGroup.add(new THREE.Line(geo, lineMat));
          }
          break;
        }
      }
    }
    dirtyRef.current = true;
  }, [currentSketch, sketchActive]);

  useEffect(() => {
    const bodiesGroup = bodiesGroupRef.current;
    if (!bodiesGroup) return;

    while (bodiesGroup.children.length > 0) {
      const child = bodiesGroup.children[0]!;
      bodiesGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    for (const body of bodies) {
      const geo = new THREE.BufferGeometry();
      const { positions, indices } = buildBodyMeshArrays(body);

      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        color: 0x89b4fa,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = body.name;
      bodiesGroup.add(mesh);
    }
    dirtyRef.current = true;
  }, [bodies]);

  const getSketchPoint = useCallback((e: React.MouseEvent): { x: number; y: number } | null => {
    const container = containerRef.current;
    const camera = cameraRef.current;
    if (!container || !camera) return null;

    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersection = new THREE.Vector3();
    raycasterRef.current.ray.intersectPlane(plane, intersection);
    if (!intersection) return null;

    // Grid snapping (hold Shift to disable)
    const gridSize = 0.5;
    let x = intersection.x;
    let y = intersection.z;
    if (!e.shiftKey) {
      x = Math.round(x / gridSize) * gridSize;
      y = Math.round(y / gridSize) * gridSize;
    }
    return { x, y };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      const scene = sceneRef.current;
      if (!container || !camera || !scene) return;

      if (sketchActive) return;

      const rect = container.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera);

      const planesGroup = planesGroupRef.current;
      if (!planesGroup) return;

      const intersects = raycasterRef.current.intersectObjects(planesGroup.children);
      if (intersects.length > 0) {
        const planeId = intersects[0]!.object.userData.planeId as SketchPlaneId;
        setSketchPlaneId(planeId);
        setSketchActive(true);
        setWorkspace('sketch');
        setCurrentSketch(createSketch(planeId));
      } else {
        deselectAll();
      }
    },
    [sketchActive, setSketchActive, setWorkspace, setCurrentSketch, setSketchPlaneId, deselectAll],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!sketchActive) {
        setMousePos(null);
        return;
      }
      const pt = getSketchPoint(e);
      setMousePos(pt);
    },
    [sketchActive, getSketchPoint],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!sketchActive || sketchTool === 'select') return;
      const pt = getSketchPoint(e);
      if (pt) setDrawStart(pt);
    },
    [sketchActive, sketchTool, getSketchPoint, setDrawStart],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!sketchActive || !drawStart || sketchTool === 'select') return;
      const pt = getSketchPoint(e);
      if (!pt) return;

      switch (sketchTool) {
        case 'line':
          addSketchLine(drawStart.x, drawStart.y, pt.x, pt.y);
          break;
        case 'rect':
          addSketchRect(drawStart.x, drawStart.y, pt.x, pt.y);
          break;
        case 'circle': {
          const dx = pt.x - drawStart.x;
          const dy = pt.y - drawStart.y;
          addSketchCircle(drawStart.x, drawStart.y, Math.sqrt(dx * dx + dy * dy));
          break;
        }
        case 'arc': {
          const dx = pt.x - drawStart.x;
          const dy = pt.y - drawStart.y;
          const radius = Math.sqrt(dx * dx + dy * dy);
          addSketchArc(drawStart.x, drawStart.y, radius, 0, Math.atan2(dy, dx));
          break;
        }
      }

      setDrawStart(null);
    },
    [sketchActive, drawStart, sketchTool, getSketchPoint, addSketchLine, addSketchRect, addSketchCircle, addSketchArc, setDrawStart],
  );

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="w-full h-full bg-surface"
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        role="img"
        aria-label={t('viewport.title')}
      />
      {sketchActive && mousePos && (
        <div
          className="absolute bottom-2 left-2 px-2 py-1 bg-panel/80 backdrop-blur-sm border border-panel-border rounded text-[10px] text-text-muted font-mono pointer-events-none"
          aria-hidden="true"
        >
          X: {mousePos.x.toFixed(2)} Y: {mousePos.y.toFixed(2)}
        </div>
      )}
    </div>
  );
}
