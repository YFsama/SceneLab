import { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useStore, type ViewDirection, type SketchPlaneId } from '../../store/app';
import { createSketch } from '../../lib/sketch/engine';
import { buildBodyMeshArrays } from '../../lib/render/bodyGeometry';
import { datumPlaneTriangles, datumPlaneOutline } from '../../lib/render/datumPlane';
import { centerBody, mirrorAcrossAxis, splitAcrossAxis, type Axis } from '../../lib/geometry';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
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
  const sketchGroupRef = useRef<THREE.Group | null>(null);
  const sketchDimGroupRef = useRef<THREE.Group | null>(null);
  const previewGroupRef = useRef<THREE.Group | null>(null);
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
  const datumPlanes = useStore((s) => s.planes);
  const datumAxes = useStore((s) => s.axes);
  const datumPoints = useStore((s) => s.points);
  const coordSystems = useStore((s) => s.coordSystems);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectObject = useStore((s) => s.selectObject);
  const deselectAll = useStore((s) => s.deselectAll);
  const replaceBody = useStore((s) => s.replaceBody);
  const removeDirectBody = useStore((s) => s.removeDirectBody);
  const addDirectBodies = useStore((s) => s.addDirectBodies);
  const theme = useStore((s) => s.theme);
  const measureActive = useStore((s) => s.measureActive);
  const measurePts = useStore((s) => s.measurePts);
  const addMeasurePoint = useStore((s) => s.addMeasurePoint);
  const [bodyMenu, setBodyMenu] = useState<{ x: number; y: number; bodyId: string } | null>(null);
  const measureGroupRef = useRef<THREE.Group | null>(null);
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

  // Live rubber-band preview of the shape being drawn (from the mouse-down point
  // to the current cursor) so you can see the line/rect/circle/arc before
  // releasing, instead of clicking two points blind.
  useEffect(() => {
    const previewGroup = previewGroupRef.current;
    if (!previewGroup) return;

    while (previewGroup.children.length > 0) {
      const child = previewGroup.children[0]!;
      previewGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    if (sketchActive && drawStart && mousePos && sketchTool !== 'select') {
      const v = (x: number, y: number) => new THREE.Vector3(x, 0, y);
      const s = drawStart;
      const m = mousePos;
      let pts: THREE.Vector3[] = [];
      switch (sketchTool) {
        case 'line':
          pts = [v(s.x, s.y), v(m.x, m.y)];
          break;
        case 'rect':
          pts = [v(s.x, s.y), v(m.x, s.y), v(m.x, m.y), v(s.x, m.y), v(s.x, s.y)];
          break;
        case 'circle': {
          const r = Math.hypot(m.x - s.x, m.y - s.y);
          const curve = new THREE.EllipseCurve(s.x, s.y, r, r, 0, Math.PI * 2, false, 0);
          pts = curve.getPoints(64).map((p) => v(p.x, p.y));
          break;
        }
        case 'arc': {
          const r = Math.hypot(m.x - s.x, m.y - s.y);
          const end = Math.atan2(m.y - s.y, m.x - s.x);
          const curve = new THREE.EllipseCurve(s.x, s.y, r, r, 0, end, false, 0);
          pts = curve.getPoints(64).map((p) => v(p.x, p.y));
          break;
        }
      }
      if (pts.length >= 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({ color: 0xf9e2af, dashSize: 0.4, gapSize: 0.2 });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        previewGroup.add(line);
      }
    }
    dirtyRef.current = true;
  }, [drawStart, mousePos, sketchTool, sketchActive]);

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
              const s = makeTextSprite(`${len.toFixed(1)}`, 0xf9e2af, 0.6);
              s.position.set((a.x + b.x) / 2, 0.05, (a.y + b.y) / 2);
              group.add(s);
            }
          }
        } else if (e.type === 'circle' || e.type === 'arc') {
          const c = pt(e.centerId);
          if (c) {
            const s = makeTextSprite(`R${e.radius.toFixed(1)}`, 0xf9e2af, 0.6);
            s.position.set(c.x, 0.05, c.y);
            group.add(s);
          }
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

      // Selected bodies render in orange with an emissive glow so the pick is
      // obvious; unselected stay the default blue.
      const selected = selectedIds.includes(body.id);
      const mat = new THREE.MeshStandardMaterial({
        color: selected ? 0xfab387 : 0x89b4fa,
        emissive: selected ? 0xf38800 : 0x000000,
        emissiveIntensity: selected ? 0.35 : 0,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = body.name;
      mesh.userData = { bodyId: body.id };
      bodiesGroup.add(mesh);
    }
    dirtyRef.current = true;
  }, [bodies, selectedIds]);

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
    if (measurePts.length === 2) {
      const [a, b] = measurePts as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)]);
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf38ba8, dashSize: 0.5, gapSize: 0.25 }));
      line.computeLineDistances();
      measureGroup.add(line);
    }
    dirtyRef.current = true;
  }, [measurePts]);

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

      const bodiesGroup = bodiesGroupRef.current;

      // Measure mode: each click drops a point on the surface under the cursor;
      // after two points the readout shows the distance. A third click restarts.
      if (measureActive) {
        if (!bodiesGroup) return;
        const p = raycasterRef.current.intersectObjects(bodiesGroup.children, true)[0]?.point;
        if (p) addMeasurePoint({ x: p.x, y: p.y, z: p.z });
        return;
      }

      // 1) A body under the cursor takes priority — clicking it selects it.
      if (bodiesGroup) {
        const bodyHits = raycasterRef.current.intersectObjects(bodiesGroup.children, true);
        const bodyId = bodyHits[0]?.object.userData.bodyId as string | undefined;
        if (bodyId) {
          selectObject(bodyId);
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
    [sketchActive, measureActive, addMeasurePoint, selectObject, setSketchActive, setWorkspace, setCurrentSketch, setSketchPlaneId, deselectAll],
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
      const bodyId = hit?.object.userData.bodyId as string | undefined;
      if (bodyId) {
        e.preventDefault();
        selectObject(bodyId);
        setBodyMenu({ x: e.clientX, y: e.clientY, bodyId });
      }
    },
    [sketchActive, selectObject],
  );

  const bodyMenuItems = useCallback(
    (bodyId: string): ContextMenuItem[] => {
      const body = () => bodies.find((b) => b.id === bodyId);
      const mirror = (axis: Axis) => { const b = body(); if (b) { const r = mirrorAcrossAxis(b, axis); if (r) replaceBody(bodyId, r); } };
      const split = (axis: Axis) => { const b = body(); if (b) { const h = splitAcrossAxis(b, axis); if (h.length) { removeDirectBody(bodyId); addDirectBodies(h); } } };
      return [
        { label: t('menu.center'), onClick: () => { const b = body(); if (b) replaceBody(bodyId, centerBody(b)); } },
        { label: t('menu.mirrorX'), onClick: () => mirror('x'), separatorBefore: true },
        { label: t('menu.mirrorY'), onClick: () => mirror('y') },
        { label: t('menu.mirrorZ'), onClick: () => mirror('z') },
        { label: t('menu.splitX'), onClick: () => split('x'), separatorBefore: true },
        { label: t('menu.splitY'), onClick: () => split('y') },
        { label: t('menu.splitZ'), onClick: () => split('z') },
        { label: t('menu.delete'), onClick: () => removeDirectBody(bodyId), separatorBefore: true, danger: true },
      ];
    },
    [bodies, t, replaceBody, removeDirectBody, addDirectBodies],
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
        onContextMenu={handleContextMenu}
        role="img"
        aria-label={t('viewport.title')}
      />
      {bodyMenu && (
        <ContextMenu x={bodyMenu.x} y={bodyMenu.y} items={bodyMenuItems(bodyMenu.bodyId)} onClose={() => setBodyMenu(null)} />
      )}
      {measureActive && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-panel/90 backdrop-blur-sm border border-panel-border rounded text-[10px] text-text-secondary font-mono pointer-events-none space-y-0.5">
          {measurePts.length < 2 ? (
            <span className="text-accent">{t('measure.hint')} ({measurePts.length}/2)</span>
          ) : (() => {
            const [a, b] = measurePts as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const dist = Math.hypot(dx, dy, dz);
            return (
              <>
                <div className="text-accent">{t('measure.distance')}: {dist.toFixed(2)} mm</div>
                <div>ΔX: {dx.toFixed(2)} ΔY: {dy.toFixed(2)} ΔZ: {dz.toFixed(2)}</div>
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
            const extra =
              sketchTool === 'rect' ? ` · ${dx.toFixed(2)} × ${dy.toFixed(2)} mm`
              : sketchTool === 'line' ? ` · L ${r.toFixed(2)} mm`
              : ` · R ${r.toFixed(2)} mm`;
            return <span className="text-accent">{extra}</span>;
          })()}
        </div>
      )}
    </div>
  );
}
