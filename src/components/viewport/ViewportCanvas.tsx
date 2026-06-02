import { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useStore, type ViewDirection, type SketchPlaneId } from '../../store/app';
import { createSketch, polygonPoints } from '../../lib/sketch/engine';
import { previewDimensionLabel } from '../../lib/sketch/dimensions';
import { buildBodyMeshArrays } from '../../lib/render/bodyGeometry';
import { buildEdgePositions, edgeMidpoints, faceCenters } from '../../lib/render/edgeGeometry';
import { datumPlaneTriangles, datumPlaneOutline } from '../../lib/render/datumPlane';
import { combinedBounds, fitCameraDistance, framingBodies } from '../../lib/render/fitView';
import { pickCycle, distinctInOrder } from '../../lib/render/pickCycle';
import { snapToPoints, sketchSnapPoints, inferLineEnd, nearestVertexWithin, angleAtVertex } from '../../lib/sketch/snap';
import { pickSketchEntity } from '../../lib/sketch/pick';
import { centerBody, convexHullBody, mirrorAcrossAxis, splitAcrossAxis, computeVolumetricCentroid, type Axis } from '../../lib/geometry';
import { layFlat, seatOnBed } from '../../lib/print';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { Maximize2, Check } from 'lucide-react';
import { useT } from '../../lib/i18n';

const VIEW_DIRECTIONS: Record<ViewDirection, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
  top: { pos: new THREE.Vector3(0, 10, 0), up: new THREE.Vector3(0, 0, -1) },
  bottom: { pos: new THREE.Vector3(0, -10, 0), up: new THREE.Vector3(0, 0, 1) },
  front: { pos: new THREE.Vector3(0, 0, 10), up: new THREE.Vector3(0, 1, 0) },
  back: { pos: new THREE.Vector3(0, 0, -10), up: new THREE.Vector3(0, 1, 0) },
  right: { pos: new THREE.Vector3(10, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  left: { pos: new THREE.Vector3(-10, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  iso: { pos: new THREE.Vector3(5, 5, 5), up: new THREE.Vector3(0, 1, 0) },
};

const PLANE_COLORS: Record<SketchPlaneId, number> = {
  xy: 0x89b4fa,
  xz: 0xa6e3a1,
  yz: 0xf38ba8,
};

/**
 * Build a camera-facing text label as a THREE.Sprite (canvas texture). Used for
 * sketch dimensions and the X/Y/Z axis gnomon. `worldHeight` sets the label's
 * height in scene units; it always faces the camera and ignores depth so it
 * stays readable.
 */
function makeTextSprite(text: string, hex: number, worldHeight = 0.8): THREE.Sprite {
  const fontPx = 64;
  const pad = 10;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `bold ${fontPx}px sans-serif`;
  const textW = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = textW + pad * 2;
  canvas.height = fontPx + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  return sprite;
}

function disposeSprite(s: THREE.Sprite) {
  const mat = s.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.dispose();
}

export function ViewportCanvas() {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const planesGroupRef = useRef<THREE.Group | null>(null);
  const datumGroupRef = useRef<THREE.Group | null>(null);
  const axisGroupRef = useRef<THREE.Group | null>(null);
  const pointGroupRef = useRef<THREE.Group | null>(null);
  const csGroupRef = useRef<THREE.Group | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const edgesGroupRef = useRef<THREE.Group | null>(null);
  const comGroupRef = useRef<THREE.Group | null>(null);
  const sketchGroupRef = useRef<THREE.Group | null>(null);
  const sketchDimGroupRef = useRef<THREE.Group | null>(null);
  const previewGroupRef = useRef<THREE.Group | null>(null);
  const bodiesGroupRef = useRef<THREE.Group | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  // Lets the (earlier-declared) context menu call fitView without a TDZ.
  const fitViewRef = useRef<((selectionOnly?: boolean) => void) | null>(null);

  const viewDirection = useStore((s) => s.viewDirection);
  const sketchActive = useStore((s) => s.sketchActive);
  const sketchTool = useStore((s) => s.sketchTool);
  const currentSketch = useStore((s) => s.currentSketch);
  const drawStart = useStore((s) => s.drawStart);
  const gridSize = useStore((s) => s.gridSize);
  const selectedSketchId = useStore((s) => s.selectedSketchId);
  const polygonSides = useStore((s) => s.polygonSides);
  const bodies = useStore((s) => s.bodies);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const wireframe = useStore((s) => s.wireframe);
  const showGrid = useStore((s) => s.showGrid);
  const showCenterOfMass = useStore((s) => s.showCenterOfMass);
  const datumPlanes = useStore((s) => s.planes);
  const datumAxes = useStore((s) => s.axes);
  const datumPoints = useStore((s) => s.points);
  const coordSystems = useStore((s) => s.coordSystems);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectObject = useStore((s) => s.selectObject);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const nudgeSelected = useStore((s) => s.nudgeSelected);
  const deselectAll = useStore((s) => s.deselectAll);
  const replaceBody = useStore((s) => s.replaceBody);
  const removeDirectBody = useStore((s) => s.removeDirectBody);
  const addDirectBodies = useStore((s) => s.addDirectBodies);
  const setPendingPrimitive = useStore((s) => s.setPendingPrimitive);
  const ensureStandardPlanes = useStore((s) => s.ensureStandardPlanes);
  const theme = useStore((s) => s.theme);
  const measureActive = useStore((s) => s.measureActive);
  const measurePts = useStore((s) => s.measurePts);
  const addMeasurePoint = useStore((s) => s.addMeasurePoint);
  const [bodyMenu, setBodyMenu] = useState<{ x: number; y: number; bodyId: string | null } | null>(null);
  const hoveredId = useStore((s) => s.hoveredId);
  const setHoveredId = useStore((s) => s.setHoveredId);
  const [measureHover, setMeasureHover] = useState<{ x: number; y: number; z: number; snapped: boolean } | null>(null);
  const measureGroupRef = useRef<THREE.Group | null>(null);
  const setSketchActive = useStore((s) => s.setSketchActive);
  const exitSketch = useStore((s) => s.exitSketch);
  const setCurrentSketch = useStore((s) => s.setCurrentSketch);
  const setSketchPlaneId = useStore((s) => s.setSketchPlaneId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const setDrawStart = useStore((s) => s.setDrawStart);
  const addSketchLine = useStore((s) => s.addSketchLine);
  const addSketchRect = useStore((s) => s.addSketchRect);
  const addSketchCircle = useStore((s) => s.addSketchCircle);
  const addSketchArc = useStore((s) => s.addSketchArc);
  const addSketchPolygon = useStore((s) => s.addSketchPolygon);

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
      // Keep the last frame readable so screenshots / AI-vision capture
      // (canvas.toDataURL) return the rendered image instead of a black frame.
      preserveDrawingBuffer: true,
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
    // Wheel zoom moves toward the cursor (Fusion / SolidWorks behaviour) rather
    // than the orbit centre, so you can zoom into the detail you're pointing at.
    controls.zoomToCursor = true;
    controlsRef.current = controls;

    const grid = new THREE.GridHelper(20, 20, 0x313244, 0x313244);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    scene.add(grid);
    gridRef.current = grid;

    const axes = new THREE.AxesHelper(2);
    scene.add(axes);

    // X/Y/Z gnomon labels at the axis tips (red/green/blue) for orientation.
    const axisLabels = new THREE.Group();
    axisLabels.name = 'axis-labels';
    const xl = makeTextSprite('X', 0xf38ba8, 0.5); xl.position.set(2.3, 0, 0);
    const yl = makeTextSprite('Y', 0xa6e3a1, 0.5); yl.position.set(0, 2.3, 0);
    const zl = makeTextSprite('Z', 0x89b4fa, 0.5); zl.position.set(0, 0, 2.3);
    axisLabels.add(xl, yl, zl);
    scene.add(axisLabels);

    // Soft, even studio lighting: a sky/ground hemisphere for ambient fill plus
    // a key and a dimmer back light so parts read as solid from any angle.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.55);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    const backLight = new THREE.DirectionalLight(0xffffff, 0.25);
    backLight.position.set(-6, 4, -8);
    scene.add(backLight);

    const planesGroup = new THREE.Group();
    planesGroup.name = 'sketch-planes';
    scene.add(planesGroup);
    planesGroupRef.current = planesGroup;

    const sketchGroup = new THREE.Group();
    sketchGroup.name = 'sketch-drawing';
    scene.add(sketchGroup);
    sketchGroupRef.current = sketchGroup;

    const previewGroup = new THREE.Group();
    previewGroup.name = 'sketch-preview';
    scene.add(previewGroup);
    previewGroupRef.current = previewGroup;

    const sketchDimGroup = new THREE.Group();
    sketchDimGroup.name = 'sketch-dimensions';
    scene.add(sketchDimGroup);
    sketchDimGroupRef.current = sketchDimGroup;

    const measureGroup = new THREE.Group();
    measureGroup.name = 'measure';
    scene.add(measureGroup);
    measureGroupRef.current = measureGroup;

    const bodiesGroup = new THREE.Group();
    bodiesGroup.name = 'bodies';
    scene.add(bodiesGroup);
    bodiesGroupRef.current = bodiesGroup;

    const edgesGroup = new THREE.Group();
    edgesGroup.name = 'body-edges';
    scene.add(edgesGroup);
    edgesGroupRef.current = edgesGroup;

    const comGroup = new THREE.Group();
    comGroup.name = 'center-of-mass';
    scene.add(comGroup);
    comGroupRef.current = comGroup;

    const datumGroup = new THREE.Group();
    datumGroup.name = 'datum-planes';
    scene.add(datumGroup);
    datumGroupRef.current = datumGroup;

    const axisGroup = new THREE.Group();
    axisGroup.name = 'datum-axes';
    scene.add(axisGroup);
    axisGroupRef.current = axisGroup;

    const pointGroup = new THREE.Group();
    pointGroup.name = 'datum-points';
    scene.add(pointGroup);
    pointGroupRef.current = pointGroup;

    const csGroup = new THREE.Group();
    csGroup.name = 'coordinate-systems';
    scene.add(csGroup);
    csGroupRef.current = csGroup;

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

  // While sketching, lock camera rotation (so a left-drag draws instead of
  // orbiting the view) and snap to a top-down view facing the sketch plane —
  // the "normal to" behaviour that makes 2D drawing usable. Restore on exit.
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    controls.enableRotate = !sketchActive;
    if (sketchActive) {
      camera.position.set(0, 14, 0);
      camera.up.set(0, 0, -1);
      controls.target.set(0, 0, 0);
      controls.update();
      dirtyRef.current = true;
    }
  }, [sketchActive]);

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
  const sketchHlMatRef = useRef(new THREE.LineBasicMaterial({ color: 0xfab387 }));

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

    const pointMat = sketchPointMatRef.current;
    // Selected entity draws in the highlight colour.
    const matFor = (id: string) => (id === selectedSketchId ? sketchHlMatRef.current : sketchLineMatRef.current);

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
            sketchGroup.add(new THREE.Line(geo, matFor(entity.id)));
          }
          break;
        }
        case 'circle': {
          const center = currentSketch.entities.get(entity.centerId);
          if (center?.type === 'point') {
            const curve = new THREE.EllipseCurve(center.x, center.y, entity.radius, entity.radius, 0, Math.PI * 2, false, 0);
            const pts = curve.getPoints(64);
            const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)));
            sketchGroup.add(new THREE.Line(geo, matFor(entity.id)));
          }
          break;
        }
        case 'arc': {
          const center = currentSketch.entities.get(entity.centerId);
          if (center?.type === 'point') {
            const curve = new THREE.EllipseCurve(center.x, center.y, entity.radius, entity.radius, entity.startAngle, entity.endAngle, false, 0);
            const pts = curve.getPoints(64);
            const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)));
            sketchGroup.add(new THREE.Line(geo, matFor(entity.id)));
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
            sketchGroup.add(new THREE.Line(geo, matFor(entity.id)));
          }
          break;
        }
      }
    }
    dirtyRef.current = true;
  }, [currentSketch, sketchActive, selectedSketchId]);

  // Live rubber-band preview of the shape being drawn (from the mouse-down point
  // to the current cursor) so you can see the line/rect/circle/arc before
  // releasing, instead of clicking two points blind.
  useEffect(() => {
    const previewGroup = previewGroupRef.current;
    if (!previewGroup) return;

    while (previewGroup.children.length > 0) {
      const child = previewGroup.children[0]!;
      previewGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Points) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Sprite) {
        disposeSprite(child);
      }
    }

    if (sketchActive && mousePos && sketchTool !== 'select') {
      const v = (x: number, y: number) => new THREE.Vector3(x, 0.01, y);
      const m = mousePos;
      const s = drawStart;
      // A marker dot at a sketch point, drawn on top (depthTest off) so it's
      // always visible regardless of the geometry behind it.
      const marker = (x: number, y: number, color: number, size: number) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([x, 0.01, y], 3));
        return new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
      };
      // Current cursor — turns green (and larger) when snapped onto an existing
      // endpoint or the origin, so it's clear the new geometry will connect there.
      const endpoints: { x: number; y: number }[] = [];
      if (currentSketch) {
        for (const ent of currentSketch.entities.values()) {
          if (ent.type === 'point') endpoints.push({ x: ent.x, y: ent.y });
        }
      }
      const onPoint = snapToPoints(m, sketchSnapPoints(endpoints), 1e-6).snapped;
      previewGroup.add(marker(m.x, m.y, onPoint ? 0xa6e3a1 : 0x89b4fa, onPoint ? 12 : 9));
      if (s) {
        previewGroup.add(marker(s.x, s.y, 0xa6e3a1, 11)); // green start point
        let pts: THREE.Vector3[] = [];
        switch (sketchTool) {
          case 'line': {
            const end = inferLineEnd(s, m).point; // honour H/V inference in the preview
            pts = [v(s.x, s.y), v(end.x, end.y)];
            break;
          }
          case 'rect':
            pts = [v(s.x, s.y), v(m.x, s.y), v(m.x, m.y), v(s.x, m.y), v(s.x, s.y)];
            break;
          case 'circle': {
            const r = Math.hypot(m.x - s.x, m.y - s.y);
            pts = new THREE.EllipseCurve(s.x, s.y, r, r, 0, Math.PI * 2, false, 0).getPoints(64).map((p) => v(p.x, p.y));
            break;
          }
          case 'arc': {
            const r = Math.hypot(m.x - s.x, m.y - s.y);
            const end = Math.atan2(m.y - s.y, m.x - s.x);
            pts = new THREE.EllipseCurve(s.x, s.y, r, r, 0, end, false, 0).getPoints(64).map((p) => v(p.x, p.y));
            break;
          }
          case 'polygon': {
            const r = Math.hypot(m.x - s.x, m.y - s.y);
            const poly = polygonPoints(s.x, s.y, r, polygonSides);
            pts = [...poly, poly[0]!].map((p) => v(p.x, p.y)); // closed outline
            break;
          }
        }
        if (pts.length >= 2) {
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          // Solid, bright, always-on-top line — far more visible than a dashed one.
          const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf9e2af, depthTest: false }));
          previewGroup.add(line);
        }
        // Live size readout next to the cursor so you can see the dimensions
        // while dragging (SolidWorks shows W×H / radius as you draw).
        const labelEnd = sketchTool === 'line' ? inferLineEnd(s, m).point : m;
        const label = previewDimensionLabel(sketchTool, s, labelEnd, polygonSides);
        if (label) {
          const sprite = makeTextSprite(label, 0xf9e2af, 0.35);
          sprite.position.set(m.x + 0.5, 0.06, m.y + 0.5);
          previewGroup.add(sprite);
        }
      }
    }
    dirtyRef.current = true;
  }, [drawStart, mousePos, sketchTool, sketchActive, currentSketch, polygonSides]);

  // Dimension labels on the sketch: each line shows its length, each circle/arc
  // its radius — drawn as camera-facing text sprites at the entity.
  useEffect(() => {
    const group = sketchDimGroupRef.current;
    if (!group) return;
    while (group.children.length > 0) {
      const child = group.children[0]!;
      group.remove(child);
      if (child instanceof THREE.Sprite) disposeSprite(child);
    }
    if (currentSketch && sketchActive) {
      const pt = (id: string) => { const e = currentSketch.entities.get(id); return e?.type === 'point' ? e : null; };
      for (const e of currentSketch.entities.values()) {
        if (e.type === 'line') {
          const a = pt(e.p1Id); const b = pt(e.p2Id);
          if (a && b) {
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (len > 1e-6) {
              const s = makeTextSprite(`${len.toFixed(1)}`, 0xf9e2af, 0.3);
              s.position.set((a.x + b.x) / 2, 0.05, (a.y + b.y) / 2);
              group.add(s);
            }
          }
        } else if (e.type === 'circle' || e.type === 'arc') {
          const c = pt(e.centerId);
          if (c) {
            const s = makeTextSprite(`R${e.radius.toFixed(1)}`, 0xf9e2af, 0.3);
            s.position.set(c.x, 0.05, c.y);
            group.add(s);
          }
        }
      }
    }
    dirtyRef.current = true;
  }, [currentSketch, sketchActive, selectedSketchId]);

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
      if (hiddenIds.includes(body.id)) continue; // hidden bodies aren't rendered
      const geo = new THREE.BufferGeometry();
      const { positions, indices } = buildBodyMeshArrays(body);

      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      // Neutral material; selection/hover styling is applied separately so
      // hovering or selecting never rebuilds geometry.
      const op = body.opacity ?? 1;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x89b4fa,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide,
        wireframe,
        transparent: op < 1,
        opacity: op,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = body.name;
      mesh.userData = { bodyId: body.id };
      bodiesGroup.add(mesh);
    }
    dirtyRef.current = true;
  }, [bodies, hiddenIds, wireframe]);

  // Edge overlay: draw each (visible) body's edges as dark line segments so the
  // shape reads clearly, like a CAD viewport's edge display. Kept in its own
  // group (not raycast) so it never interferes with picking.
  useEffect(() => {
    const edgesGroup = edgesGroupRef.current;
    if (!edgesGroup) return;
    while (edgesGroup.children.length > 0) {
      const child = edgesGroup.children[0]!;
      edgesGroup.remove(child);
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    if (!wireframe) {
      for (const body of bodies) {
        if (hiddenIds.includes(body.id)) continue;
        const pos = buildEdgePositions(body);
        if (pos.length === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        // Selected bodies get bright (orange) edges that draw on top, so the
        // selection reads clearly even against the face tint (SolidWorks-style).
        const selected = selectedIds.includes(body.id);
        const seg = new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: selected ? 0xfab387 : 0x45475a, depthTest: !selected }),
        );
        seg.renderOrder = selected ? 1 : 0;
        edgesGroup.add(seg);
      }
    }
    dirtyRef.current = true;
  }, [bodies, hiddenIds, wireframe, selectedIds]);

  // Center-of-mass markers for selected bodies (when enabled).
  useEffect(() => {
    const comGroup = comGroupRef.current;
    if (!comGroup) return;
    while (comGroup.children.length > 0) {
      const child = comGroup.children[0]!;
      comGroup.remove(child);
      if (child instanceof THREE.Points) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
    }
    if (showCenterOfMass) {
      for (const body of bodies) {
        if (hiddenIds.includes(body.id) || !selectedIds.includes(body.id)) continue;
        const c = computeVolumetricCentroid(body);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([c.x, c.y, c.z], 3));
        comGroup.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf9e2af, size: 13, sizeAttenuation: false, depthTest: false })));
      }
    }
    dirtyRef.current = true;
  }, [bodies, selectedIds, hiddenIds, showCenterOfMass]);

  // Apply selection / hover styling by tweaking materials (no geometry rebuild):
  // selected → orange glow, hovered (unselected) → a lighter blue preselect.
  useEffect(() => {
    const bodiesGroup = bodiesGroupRef.current;
    if (!bodiesGroup) return;
    const colorOf = new Map(bodies.map((b) => [b.id, b.color ?? 0x89b4fa]));
    for (const child of bodiesGroup.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const id = child.userData.bodyId as string | undefined;
      const mat = child.material as THREE.MeshStandardMaterial;
      const selected = !!id && selectedIds.includes(id);
      const hovered = !sketchActive && !!id && id === hoveredId;
      // Brightness is encoded in the emissive colour (no emissiveIntensity write)
      // so the material is mutated only through setHex.
      if (selected) {
        mat.color.setHex(0xfab387); mat.emissive.setHex(0x6e3b00);
      } else if (hovered) {
        mat.color.setHex(0xb4befe); mat.emissive.setHex(0x232a52);
      } else {
        mat.color.setHex((id && colorOf.get(id)) || 0x89b4fa); mat.emissive.setHex(0x000000);
      }
    }
    dirtyRef.current = true;
  }, [bodies, selectedIds, hoveredId, sketchActive]);

  // Render the store's datum/reference planes as translucent outlined quads.
  useEffect(() => {
    const datumGroup = datumGroupRef.current;
    if (!datumGroup) return;

    while (datumGroup.children.length > 0) {
      const child = datumGroup.children[0]!;
      datumGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    const size = 6;
    for (const plane of datumPlanes) {
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(datumPlaneTriangles(plane, size), 3));
      fillGeo.computeVertexNormals();
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0xf9e2af,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.name = `datum-${plane.id}`;
      datumGroup.add(fill);

      const outlineGeo = new THREE.BufferGeometry().setFromPoints(
        datumPlaneOutline(plane, size).map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      );
      const outlineMat = new THREE.LineBasicMaterial({ color: 0xf9e2af, transparent: true, opacity: 0.6 });
      datumGroup.add(new THREE.Line(outlineGeo, outlineMat));
    }
    dirtyRef.current = true;
  }, [datumPlanes]);

  // Render the store's datum axes as long line segments through their origins.
  useEffect(() => {
    const axisGroup = axisGroupRef.current;
    if (!axisGroup) return;

    while (axisGroup.children.length > 0) {
      const child = axisGroup.children[0]!;
      axisGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    const half = 12; // draw the (infinite) axis as a finite segment ±half mm
    for (const axis of datumAxes) {
      const o = axis.origin;
      const d = axis.direction;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(o.x - d.x * half, o.y - d.y * half, o.z - d.z * half),
        new THREE.Vector3(o.x + d.x * half, o.y + d.y * half, o.z + d.z * half),
      ]);
      const mat = new THREE.LineDashedMaterial({ color: 0xf38ba8, dashSize: 0.6, gapSize: 0.3 });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances(); // required for dashed lines
      line.name = `axis-${axis.id}`;
      axisGroup.add(line);
    }
    dirtyRef.current = true;
  }, [datumAxes]);

  // Render the store's datum points as small markers.
  useEffect(() => {
    const pointGroup = pointGroupRef.current;
    if (!pointGroup) return;

    while (pointGroup.children.length > 0) {
      const child = pointGroup.children[0]!;
      pointGroup.remove(child);
      if (child instanceof THREE.Points) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    for (const pt of datumPoints) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([pt.position.x, pt.position.y, pt.position.z], 3));
      const mat = new THREE.PointsMaterial({ color: 0xf9e2af, size: 8, sizeAttenuation: false });
      const marker = new THREE.Points(geo, mat);
      marker.name = `point-${pt.id}`;
      pointGroup.add(marker);
    }
    dirtyRef.current = true;
  }, [datumPoints]);

  // Render the store's coordinate systems as an RGB axis triad at each origin.
  useEffect(() => {
    const csGroup = csGroupRef.current;
    if (!csGroup) return;

    while (csGroup.children.length > 0) {
      const child = csGroup.children[0]!;
      csGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    const len = 3;
    for (const cs of coordSystems) {
      const o = cs.origin;
      const triad: [THREE.Vector3, number][] = [
        [new THREE.Vector3(cs.xAxis.x, cs.xAxis.y, cs.xAxis.z), 0xf38ba8], // X red
        [new THREE.Vector3(cs.yAxis.x, cs.yAxis.y, cs.yAxis.z), 0xa6e3a1], // Y green
        [new THREE.Vector3(cs.zAxis.x, cs.zAxis.y, cs.zAxis.z), 0x89b4fa], // Z blue
      ];
      for (const [dir, color] of triad) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(o.x, o.y, o.z),
          new THREE.Vector3(o.x + dir.x * len, o.y + dir.y * len, o.z + dir.z * len),
        ]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
        line.name = `cs-${cs.id}`;
        csGroup.add(line);
      }
    }
    dirtyRef.current = true;
  }, [coordSystems]);

  // Show/hide the ground grid by attaching/detaching it (methods only, so no
  // property mutation of a ref value inside the effect).
  useEffect(() => {
    const scene = sceneRef.current;
    const grid = gridRef.current;
    if (!scene || !grid) return;
    if (showGrid) scene.add(grid);
    else scene.remove(grid);
    dirtyRef.current = true;
  }, [showGrid]);

  // Theme the 3D viewport so light/high-contrast modes change the scene too —
  // the canvas background and grid follow the active theme, not just the panels.
  useEffect(() => {
    const palette: Record<string, { bg: number; grid: number }> = {
      dark: { bg: 0x1e1e2e, grid: 0x313244 },
      light: { bg: 0xeff1f5, grid: 0xccd0da },
      'high-contrast': { bg: 0x000000, grid: 0x666666 },
    };
    const p = palette[theme] ?? palette.dark!;
    rendererRef.current?.setClearColor(p.bg);
    const grid = gridRef.current;
    if (grid) (grid.material as THREE.LineBasicMaterial).color.setHex(p.grid);
    dirtyRef.current = true;
  }, [theme]);

  // Render measure points and the segment between them.
  useEffect(() => {
    const measureGroup = measureGroupRef.current;
    if (!measureGroup) return;
    while (measureGroup.children.length > 0) {
      const child = measureGroup.children[0]!;
      measureGroup.remove(child);
      if (child instanceof THREE.Points || child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    for (const pt of measurePts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([pt.x, pt.y, pt.z], 3));
      measureGroup.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf38ba8, size: 10, sizeAttenuation: false })));
    }
    if (measurePts.length >= 2) {
      // Polyline through the picks (1→2→3) — a segment for distance, two for angle.
      const g = new THREE.BufferGeometry().setFromPoints(measurePts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf38ba8, dashSize: 0.5, gapSize: 0.25 }));
      line.computeLineDistances();
      measureGroup.add(line);
    }
    // Live snap-preview marker under the cursor (green when snapped to a feature).
    if (measureActive && measureHover) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([measureHover.x, measureHover.y, measureHover.z], 3));
      measureGroup.add(new THREE.Points(g, new THREE.PointsMaterial({ color: measureHover.snapped ? 0xa6e3a1 : 0x89b4fa, size: measureHover.snapped ? 12 : 8, sizeAttenuation: false, depthTest: false })));
    }
    dirtyRef.current = true;
  }, [measurePts, measureActive, measureHover]);

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

    const raw = { x: intersection.x, y: intersection.z };
    // Hold Shift to draw freely (no snapping at all).
    if (e.shiftKey) return raw;

    // Endpoint/origin snapping takes priority over the grid so new geometry
    // connects precisely to existing sketch points and the origin (SolidWorks).
    const endpoints: { x: number; y: number }[] = [];
    if (currentSketch) {
      for (const ent of currentSketch.entities.values()) {
        if (ent.type === 'point') endpoints.push({ x: ent.x, y: ent.y });
      }
    }
    const snap = snapToPoints(raw, sketchSnapPoints(endpoints), 0.4);
    if (snap.snapped) return snap.point;

    // Otherwise snap to the configurable grid step.
    return { x: Math.round(raw.x / gridSize) * gridSize, y: Math.round(raw.y / gridSize) * gridSize };
  }, [currentSketch, gridSize]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      const scene = sceneRef.current;
      if (!container || !camera || !scene) return;

      if (sketchActive) {
        // In the select tool, clicking near an entity selects it (for deletion).
        if (sketchTool === 'select' && currentSketch) {
          const p = getSketchPoint(e);
          const id = p ? pickSketchEntity(currentSketch, p, Math.max(gridSize, 0.4)) : null;
          useStore.getState().setSelectedSketchId(id);
        }
        return;
      }

      const rect = container.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera);

      const bodiesGroup = bodiesGroupRef.current;

      // Measure mode: each click drops a point on the surface under the cursor;
      // after two points the readout shows the distance. A third click restarts.
      if (measureActive) {
        if (!bodiesGroup) return;
        const hit = raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0];
        if (hit) {
          let pt = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
          // Snap to the hit body's nearest corner (within 10% of its size) for
          // exact corner-to-corner measurements.
          const body = bodies.find((b) => b.id === (hit.object.userData.bodyId as string | undefined));
          const bb = body && combinedBounds([body]);
          if (body && bb) {
            const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
            // Snap to corners, edge midpoints and face centres (SolidWorks Measure).
            const v = nearestVertexWithin(pt, [...body.vertices, ...edgeMidpoints(body), ...faceCenters(body)], diag * 0.1);
            if (v) pt = v;
          }
          addMeasurePoint(pt);
        }
        return;
      }

      // 1) A body under the cursor takes priority — clicking it selects it.
      if (bodiesGroup) {
        const bodyHits = raycasterRef.current.intersectObjects(bodiesGroup.children, true);
        const ordered = distinctInOrder(bodyHits.map((h) => h.object.userData.bodyId as string | undefined));
        if (ordered.length > 0) {
          // Ctrl/⌘/Shift-click adds to (or toggles) the selection, like SolidWorks.
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            toggleSelect(ordered[0]!);
          } else {
            // Plain click cycles through stacked bodies so occluded parts are
            // reachable by clicking the same spot again ("select other").
            const next = pickCycle(ordered, selectedIds);
            if (next) selectObject(next);
          }
          return;
        }
      }

      // 2) Otherwise a datum sketch plane starts a sketch.
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
        // 3) Empty space clears the selection.
        deselectAll();
      }
    },
    [sketchActive, sketchTool, currentSketch, gridSize, getSketchPoint, measureActive, addMeasurePoint, bodies, selectedIds, selectObject, toggleSelect, setSketchActive, setWorkspace, setCurrentSketch, setSketchPlaneId, deselectAll],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!sketchActive) {
        setMousePos(null);
        const container = containerRef.current;
        const camera = cameraRef.current;
        const bodiesGroup = bodiesGroupRef.current;
        if (!container || !camera || !bodiesGroup) return;
        const rect = container.getBoundingClientRect();
        mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycasterRef.current.setFromCamera(mouseRef.current, camera);
        if (measureActive) {
          // Preview the point a click would drop, snapped to the nearest feature.
          const hit = raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0];
          if (!hit) { setMeasureHover(null); return; }
          let pt = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
          let snapped = false;
          const b = bodies.find((x) => x.id === (hit.object.userData.bodyId as string | undefined));
          const bb = b && combinedBounds([b]);
          if (b && bb) {
            const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
            const v = nearestVertexWithin(pt, [...b.vertices, ...edgeMidpoints(b), ...faceCenters(b)], diag * 0.1);
            if (v) { pt = v; snapped = true; }
          }
          setMeasureHover({ ...pt, snapped });
          return;
        }
        // Hover-highlight the body under the cursor (preselect).
        const id = (raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0]?.object.userData.bodyId as string | undefined) ?? null;
        setHoveredId(id);
        return;
      }
      const pt = getSketchPoint(e);
      setMousePos(pt);
    },
    [sketchActive, measureActive, bodies, getSketchPoint, setHoveredId],
  );

  // Right-click a body in the 3D view → select it and open its context menu.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (sketchActive) return;
      const container = containerRef.current;
      const camera = cameraRef.current;
      const bodiesGroup = bodiesGroupRef.current;
      if (!container || !camera || !bodiesGroup) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera);
      const hit = raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0];
      const bodyId = (hit?.object.userData.bodyId as string | undefined) ?? null;
      // Always show our menu (and suppress the browser's): body actions on a
      // body, general insert/scene actions on empty space.
      e.preventDefault();
      // Keep an existing multi-selection if right-clicking one of its members.
      if (bodyId && !selectedIds.includes(bodyId)) selectObject(bodyId);
      setBodyMenu({ x: e.clientX, y: e.clientY, bodyId });
    },
    [sketchActive, selectObject, selectedIds],
  );

  const bodyMenuItems = useCallback(
    (bodyId: string | null): ContextMenuItem[] => {
      // Empty-space menu: quick insert + scene actions.
      if (!bodyId) {
        const kinds = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism', 'tube', 'coil'] as const;
        const setView = (d: import('../../store/app').ViewDirection) => useStore.getState().setViewDirection(d);
        return [
          {
            label: t('dialog.insert'),
            submenu: kinds.map((k) => ({ label: t(`primitive.${k}`), onClick: () => setPendingPrimitive(k) })),
          },
          { label: t('viewport.fit'), onClick: () => fitViewRef.current?.(false), separatorBefore: true },
          {
            label: t('menu.views'),
            submenu: [
              { label: t('viewport.front'), onClick: () => setView('front') },
              { label: t('viewport.back'), onClick: () => setView('back') },
              { label: t('viewport.left'), onClick: () => setView('left') },
              { label: t('viewport.right'), onClick: () => setView('right') },
              { label: t('viewport.top'), onClick: () => setView('top') },
              { label: t('viewport.bottom'), onClick: () => setView('bottom') },
              { label: t('viewport.iso'), onClick: () => setView('iso'), separatorBefore: true },
            ],
          },
          ...(useStore.getState().clipboard.length > 0
            ? [{ label: t('menu.paste'), onClick: () => useStore.getState().paste(), separatorBefore: true }]
            : []),
          { label: t('reference.standardPlanes'), onClick: () => ensureStandardPlanes(), separatorBefore: true },
          { label: t('menu.selectAll'), onClick: () => useStore.getState().selectAll() },
          { label: t('menu.deselectAll'), onClick: () => deselectAll() },
        ];
      }
      const body = () => bodies.find((b) => b.id === bodyId);
      const apply = (op: (b: import('../../lib/geometry/types').SolidBody) => import('../../lib/geometry/types').SolidBody) => { const b = body(); if (b) replaceBody(bodyId, op(b)); };
      const mirror = (axis: Axis) => { const b = body(); if (b) { const r = mirrorAcrossAxis(b, axis); if (r) replaceBody(bodyId, r); } };
      const split = (axis: Axis) => { const b = body(); if (b) { const h = splitAcrossAxis(b, axis); if (h.length) { removeDirectBody(bodyId); addDirectBodies(h); } } };
      const st = () => useStore.getState();
      const pre = (fn: () => void) => () => { if (!selectedIds.includes(bodyId)) selectObject(bodyId); fn(); };
      // Grouped flyouts, matching the browser-tree menu.
      return [
        { label: t('menu.copy'), onClick: () => { if (!selectedIds.includes(bodyId)) selectObject(bodyId); st().copySelected(); } },
        { label: t('menu.duplicate'), onClick: () => { selectObject(bodyId); st().duplicateSelected(); } },
        {
          label: t('menu.transform'),
          separatorBefore: true,
          submenu: [
            { label: t('menu.move'), onClick: pre(() => st().setMoveDialogOpen(true)) },
            { label: t('menu.toOrigin'), onClick: pre(() => st().moveSelectionToOrigin()) },
            { label: t('menu.rotateDlg'), onClick: pre(() => st().setRotateDialogOpen(true)) },
            { label: t('menu.rotateX'), onClick: pre(() => st().rotateSelected('x', 90)), separatorBefore: true },
            { label: t('menu.rotateY'), onClick: pre(() => st().rotateSelected('y', 90)) },
            { label: t('menu.rotateZ'), onClick: pre(() => st().rotateSelected('z', 90)) },
            { label: t('menu.scaleDlg'), onClick: pre(() => st().setScaleDialogOpen(true)), separatorBefore: true },
            { label: t('menu.scaleUp'), onClick: pre(() => st().scaleSelected(2)) },
            { label: t('menu.scaleDown'), onClick: pre(() => st().scaleSelected(0.5)) },
            { label: t('menu.mirrorX'), onClick: () => mirror('x'), separatorBefore: true },
            { label: t('menu.mirrorY'), onClick: () => mirror('y') },
            { label: t('menu.mirrorZ'), onClick: () => mirror('z') },
            { label: t('menu.flipX'), onClick: pre(() => st().flipSelected('x')), separatorBefore: true },
            { label: t('menu.flipY'), onClick: pre(() => st().flipSelected('y')) },
            { label: t('menu.flipZ'), onClick: pre(() => st().flipSelected('z')) },
          ],
        },
        {
          label: t('menu.pattern'),
          submenu: [
            { label: t('menu.linearPattern'), onClick: () => st().setPendingPattern({ bodyId, mode: 'linear' }) },
            { label: t('menu.circularPattern'), onClick: () => st().setPendingPattern({ bodyId, mode: 'circular' }) },
            { label: t('menu.gridPattern'), onClick: () => st().setPendingPattern({ bodyId, mode: 'grid' }) },
          ],
        },
        ...(selectedIds.length >= 2
          ? [{
              label: t('menu.combine'),
              submenu: [
                { label: t('menu.union'), onClick: () => st().combineSelected('union') },
                { label: t('menu.subtract'), onClick: () => st().combineSelected('difference') },
                { label: t('menu.intersect'), onClick: () => st().combineSelected('intersect') },
                { label: t('menu.join'), onClick: () => st().joinSelected(), separatorBefore: true },
              ],
            }]
          : []),
        {
          label: t('menu.modify'),
          submenu: [
            { label: t('menu.splitX'), onClick: () => split('x') },
            { label: t('menu.splitY'), onClick: () => split('y') },
            { label: t('menu.splitZ'), onClick: () => split('z') },
            { label: t('menu.hollow'), onClick: () => st().setHollowDialogBody(bodyId), separatorBefore: true },
            { label: t('menu.center'), onClick: () => apply(centerBody), separatorBefore: true },
            { label: t('menu.convexHull'), onClick: () => apply((b) => convexHullBody(b)) },
            { label: t('menu.boundingBox'), onClick: () => st().makeBoundingBoxOfSelection() },
            { label: t('menu.cleanup'), onClick: pre(() => st().weldSelected()) },
            { label: t('menu.transparency'), onClick: () => st().toggleBodyTransparency(bodyId) },
          ],
        },
        {
          label: t('menu.placement'),
          submenu: [
            { label: t('menu.layFlat'), onClick: () => apply(layFlat) },
            { label: t('menu.seatOnBed'), onClick: () => apply((b) => seatOnBed(b)) },
            { label: t('menu.dropFloor'), onClick: pre(() => st().dropSelectedToFloor()) },
          ],
        },
        {
          label: t('menu.visibility'),
          submenu: [
            { label: t('menu.hide'), onClick: () => st().toggleBodyVisibility(bodyId) },
            { label: t('menu.isolate'), onClick: () => { selectObject(bodyId); st().isolateSelected(); } },
            ...(hiddenIds.length > 0 ? [{ label: t('menu.showAll'), onClick: () => st().showAllBodies() }] : []),
          ],
        },
        { label: t('menu.delete'), onClick: () => removeDirectBody(bodyId), separatorBefore: true, danger: true },
      ];
    },
    [bodies, t, selectedIds, hiddenIds, selectObject, replaceBody, removeDirectBody, addDirectBodies, setPendingPrimitive, ensureStandardPlanes, deselectAll],
  );

  // Zoom-to-fit: frame all bodies (or the default workspace volume) in view,
  // keeping the current viewing direction — SolidWorks "Zoom to Fit" (F).
  const fitView = useCallback((selectionOnly = false, targets?: import('../../lib/geometry/types').SolidBody[]) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const bb = combinedBounds(targets ?? framingBodies(bodies, selectedIds, selectionOnly));
    const center = bb
      ? new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
      : new THREE.Vector3(0, 0, 0);
    const size = bb
      ? { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z }
      : { x: 10, y: 10, z: 10 };
    const dist = fitCameraDistance(size, camera.fov, camera.aspect);
    let dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-9) dir = new THREE.Vector3(1, 0.8, 1);
    dir.normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    controls.target.copy(center);
    controls.update();
    dirtyRef.current = true;
  }, [bodies, selectedIds]);
  useEffect(() => { fitViewRef.current = fitView; }, [fitView]);

  // Double-click a body to select and frame it (SolidWorks/Fusion zoom-to-part).
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (sketchActive || measureActive) return;
      const container = containerRef.current;
      const camera = cameraRef.current;
      const bodiesGroup = bodiesGroupRef.current;
      if (!container || !camera || !bodiesGroup) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera);
      const id = raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0]?.object.userData.bodyId as string | undefined;
      const body = id ? bodies.find((b) => b.id === id) : undefined;
      if (body) { selectObject(body.id); fitView(false, [body]); }
    },
    [sketchActive, measureActive, bodies, selectObject, fitView],
  );

  // Home view: snap to a fitted isometric view (orient + frame), regardless of
  // the current orientation — the CAD "home"/reset-view action.
  const resetView = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const bb = combinedBounds(bodies);
    const center = bb
      ? new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
      : new THREE.Vector3(0, 0, 0);
    const size = bb
      ? { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z }
      : { x: 10, y: 10, z: 10 };
    const dist = fitCameraDistance(size, camera.fov, camera.aspect);
    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    camera.up.set(0, 1, 0);
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    controls.target.copy(center);
    controls.update();
    dirtyRef.current = true;
  }, [bodies]);

  // Auto-frame the first body added to an empty scene so it's immediately
  // visible (avoids "inserted but off-screen"), and only then.
  const prevBodyCountRef = useRef(0);
  useEffect(() => {
    if (prevBodyCountRef.current === 0 && bodies.length > 0 && !sketchActive) fitView(false);
    prevBodyCountRef.current = bodies.length;
  }, [bodies.length, sketchActive, fitView]);

  // Keyboard: F frames the model (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // F = zoom to fit (all); Shift+F = zoom to selection. Standard-view number
      // keys and Esc are handled by the central shortcut map (initShortcuts).
      if (e.key === 'f') { e.preventDefault(); fitView(false); }
      else if (e.key === 'F') { e.preventDefault(); fitView(true); }
      else if (e.key === 'Home') { e.preventDefault(); resetView(); }
      else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); useStore.getState().setShowGrid(!useStore.getState().showGrid); }
      // Arrow keys nudge the selection on the ground plane (top-view mapping):
      // ←/→ = X, ↑/↓ = Z; PageUp/PageDown = vertical (Y). Shift = 10mm coarse
      // step, else 1mm. Skipped in sketch.
      if (!sketchActive && (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown')) {
        const step = e.shiftKey ? 10 : 1;
        const move =
          e.key === 'ArrowLeft' ? [-step, 0, 0]
          : e.key === 'ArrowRight' ? [step, 0, 0]
          : e.key === 'ArrowUp' ? [0, 0, -step]
          : e.key === 'ArrowDown' ? [0, 0, step]
          : e.key === 'PageUp' ? [0, step, 0]
          : e.key === 'PageDown' ? [0, -step, 0]
          : null;
        if (move && nudgeSelected(move[0]!, move[1]!, move[2]!) > 0) e.preventDefault();
      }
      // Delete the selected sketch entity while sketching.
      if (sketchActive && (e.key === 'Delete' || e.key === 'Backspace')) {
        const id = useStore.getState().selectedSketchId;
        if (id) { e.preventDefault(); useStore.getState().removeSketchEntity(id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView, resetView, sketchActive, nudgeSelected]);

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
        case 'line': {
          const end = inferLineEnd(drawStart, pt).point; // commit with H/V inference
          addSketchLine(drawStart.x, drawStart.y, end.x, end.y);
          break;
        }
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
        case 'polygon': {
          const r = Math.hypot(pt.x - drawStart.x, pt.y - drawStart.y);
          if (r > 1e-6) addSketchPolygon(drawStart.x, drawStart.y, r, polygonSides);
          break;
        }
      }

      setDrawStart(null);
    },
    [sketchActive, drawStart, sketchTool, polygonSides, getSketchPoint, addSketchLine, addSketchRect, addSketchCircle, addSketchArc, addSketchPolygon, setDrawStart],
  );

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className={`w-full h-full bg-surface ${hoveredId && !sketchActive ? 'cursor-pointer' : ''}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHoveredId(null); setMeasureHover(null); }}
        onContextMenu={handleContextMenu}
        role="img"
        aria-label={t('viewport.title')}
      />
      {bodies.length === 0 && !sketchActive && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
          <div className="px-4 py-3 rounded-lg bg-panel/70 backdrop-blur-sm border border-panel-border text-center max-w-xs">
            <p className="text-sm font-medium text-text-primary mb-1">{t('empty.title')}</p>
            <p className="text-xs text-text-muted leading-relaxed">{t('empty.body')}</p>
          </div>
        </div>
      )}
      <button
        onClick={() => fitView(false)}
        className="absolute bottom-2 right-2 w-8 h-8 flex items-center justify-center rounded bg-panel/80 backdrop-blur-sm border border-panel-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        aria-label={t('viewport.fit')}
        title={`${t('viewport.fit')} (F)`}
      >
        <Maximize2 size={15} />
      </button>
      {sketchActive && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
          <button
            onClick={exitSketch}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-surface text-xs font-medium shadow-lg hover:bg-accent-hover transition-colors"
            title={`${t('sketch.exit')} (Esc)`}
          >
            <Check size={14} />
            {t('sketch.exit')}
          </button>
          <span className="px-2 py-0.5 rounded bg-panel/80 backdrop-blur-sm border border-panel-border text-[10px] text-text-muted">
            {t(`sketch.${sketchTool}`)} · {t('sketch.hint')}
          </span>
        </div>
      )}
      {bodyMenu && (
        <ContextMenu x={bodyMenu.x} y={bodyMenu.y} items={bodyMenuItems(bodyMenu.bodyId)} onClose={() => setBodyMenu(null)} />
      )}
      {measureActive && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-panel/90 backdrop-blur-sm border border-panel-border rounded text-[10px] text-text-secondary font-mono pointer-events-none space-y-0.5">
          {measureHover && (
            <div className={measureHover.snapped ? 'text-success' : 'text-text-muted'}>
              → ({measureHover.x.toFixed(2)}, {measureHover.y.toFixed(2)}, {measureHover.z.toFixed(2)})
            </div>
          )}
          {measurePts.length < 2 ? (
            <>
              <span className="text-accent">{t('measure.hint')} ({measurePts.length}/3)</span>
              {measurePts.length === 1 && (
                <div>P1: ({measurePts[0]!.x.toFixed(2)}, {measurePts[0]!.y.toFixed(2)}, {measurePts[0]!.z.toFixed(2)})</div>
              )}
            </>
          ) : measurePts.length === 2 ? (() => {
            const [a, b] = measurePts as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const dist = Math.hypot(dx, dy, dz);
            return (
              <>
                <div className="text-accent">{t('measure.distance')}: {dist.toFixed(2)} mm</div>
                <div>ΔX: {dx.toFixed(2)} ΔY: {dy.toFixed(2)} ΔZ: {dz.toFixed(2)}</div>
                <div className="text-text-muted">{t('measure.angleHint')}</div>
              </>
            );
          })() : (() => {
            const [a, b, c] = measurePts as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }];
            const ang = angleAtVertex(a, b, c);
            const d1 = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            const d2 = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z);
            return (
              <>
                <div className="text-accent">{t('measure.angle')}: {ang.toFixed(1)}°</div>
                <div>{d1.toFixed(2)} mm · {d2.toFixed(2)} mm</div>
              </>
            );
          })()}
        </div>
      )}
      {sketchActive && mousePos && (
        <div
          className="absolute bottom-2 left-2 px-2 py-1 bg-panel/80 backdrop-blur-sm border border-panel-border rounded text-[10px] text-text-muted font-mono pointer-events-none"
          aria-hidden="true"
        >
          X: {mousePos.x.toFixed(2)} Y: {mousePos.y.toFixed(2)}
          {drawStart && sketchTool !== 'select' && (() => {
            const dx = Math.abs(mousePos.x - drawStart.x);
            const dy = Math.abs(mousePos.y - drawStart.y);
            const r = Math.hypot(mousePos.x - drawStart.x, mousePos.y - drawStart.y);
            const constraint = sketchTool === 'line' ? inferLineEnd(drawStart, mousePos).constraint : null;
            const extra =
              sketchTool === 'rect' ? ` · ${dx.toFixed(2)} × ${dy.toFixed(2)} mm`
              : sketchTool === 'line' ? ` · L ${r.toFixed(2)} mm`
              : ` · R ${r.toFixed(2)} mm`;
            return (
              <span className="text-accent">
                {extra}
                {constraint && <span className="ml-1 px-1 rounded bg-accent/20">{constraint === 'horizontal' ? 'H' : 'V'}</span>}
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}
