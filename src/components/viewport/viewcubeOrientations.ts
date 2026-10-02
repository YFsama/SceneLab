import * as THREE from 'three';

// Extracted verbatim from InteractiveViewCube so the tables and hit-classifying
// logic can be shared with the test (a component file may only export the
// component — eslint react-refresh/only-export-components — same pattern as
// toolbar/workspaces.ts). No behavior change: the component imports these.

// ── 26 orientations: 6 faces + 12 edges + 8 corners ────────────────────────

export interface Orientation {
  position: THREE.Vector3;
  up: THREE.Vector3;
  label: string;
}

/** Build the 26 standard CAD orientations (SolidWorks ViewCube). */
export function buildOrientations(): Orientation[] {
  const F = (x: number, y: number, z: number, ux: number, uy: number, uz: number, label: string) => ({
    position: new THREE.Vector3(x, y, z).normalize(),
    up: new THREE.Vector3(ux, uy, uz),
    label,
  });
  return [
    // 6 faces
    F(0, 0, 1, 0, 1, 0, 'Front'),
    F(0, 0, -1, 0, 1, 0, 'Back'),
    F(1, 0, 0, 0, 1, 0, 'Right'),
    F(-1, 0, 0, 0, 1, 0, 'Left'),
    F(0, 1, 0, 0, 0, -1, 'Top'),
    F(0, -1, 0, 0, 0, 1, 'Bottom'),
    // 12 edges
    F(0, 1, 1, 0, 1, 0, 'Front-Top'),
    F(0, -1, 1, 0, 1, 0, 'Front-Bottom'),
    F(0, 1, -1, 0, 1, 0, 'Back-Top'),
    F(0, -1, -1, 0, 1, 0, 'Back-Bottom'),
    F(1, 1, 0, 0, 1, 0, 'Right-Top'),
    F(-1, 1, 0, 0, 1, 0, 'Left-Top'),
    F(1, -1, 0, 0, 1, 0, 'Right-Bottom'),
    F(-1, -1, 0, 0, 1, 0, 'Left-Bottom'),
    F(1, 0, 1, 0, 1, 0, 'Front-Right'),
    F(-1, 0, 1, 0, 1, 0, 'Front-Left'),
    F(1, 0, -1, 0, 1, 0, 'Back-Right'),
    F(-1, 0, -1, 0, 1, 0, 'Back-Left'),
    // 8 corners
    F(1, 1, 1, 0, 1, 0, 'Front-Right-Top'),
    F(-1, 1, 1, 0, 1, 0, 'Front-Left-Top'),
    F(1, -1, 1, 0, 1, 0, 'Front-Right-Bottom'),
    F(-1, -1, 1, 0, 1, 0, 'Front-Left-Bottom'),
    F(1, 1, -1, 0, 1, 0, 'Back-Right-Top'),
    F(-1, 1, -1, 0, 1, 0, 'Back-Left-Top'),
    F(1, -1, -1, 0, 1, 0, 'Back-Right-Bottom'),
    F(-1, -1, -1, 0, 1, 0, 'Back-Left-Bottom'),
  ];
}

export const ORIENTATIONS = buildOrientations();

// ── Face geometry (each face is a separate mesh for raycasting) ─────────────

export const FACE_DIRS = [
  { normal: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), uDir: new THREE.Vector3(1, 0, 0), label: 'Front' },
  { normal: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), uDir: new THREE.Vector3(-1, 0, 0), label: 'Back' },
  { normal: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), uDir: new THREE.Vector3(0, 0, -1), label: 'Right' },
  { normal: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), uDir: new THREE.Vector3(0, 0, 1), label: 'Left' },
  { normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), uDir: new THREE.Vector3(1, 0, 0), label: 'Top' },
  { normal: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), uDir: new THREE.Vector3(1, 0, 0), label: 'Bottom' },
];

// ── Hit detection: classify intersection as face / edge / corner ────────────

export interface HitResult {
  type: 'face' | 'edge' | 'corner';
  orientationIndex: number;
}

export const EDGE_THRESHOLD = 0.72; // how close to the edge (in UV) to count as edge
export const CORNER_THRESHOLD = 0.72;

/**
 * Given a raycast hit on a face mesh, determine whether the user clicked the
 * face, an edge, or a corner — and return the matching orientation index.
 */
export function classifyHit(hit: THREE.Intersection): HitResult | null {
  const faceIndex = hit.object.userData.faceIndex as number | undefined;
  if (faceIndex == null) return null;
  const { normal } = FACE_DIRS[faceIndex]!;

  // The hit point in local face coordinates → UV in [-1, 1].
  const local = hit.point.clone();
  // Project onto the face plane to get 2D coordinates.
  const inv = new THREE.Matrix4().copy((hit.object as THREE.Mesh).matrixWorld).invert();
  const lp = local.clone().applyMatrix4(inv);
  // lp.x and lp.y are the 2D face coordinates in [-1, 1] (PlaneGeometry 2x2).
  const fu = lp.x;
  const fv = lp.y;
  const au = Math.abs(fu);
  const av = Math.abs(fv);

  if (au > CORNER_THRESHOLD && av > CORNER_THRESHOLD) {
    // Corner: combine the face normal with the two edge directions
    const cornerDir = normal.clone();
    cornerDir.x += Math.sign(fu) * (1 - Math.abs(normal.x));
    cornerDir.y += Math.sign(fv) * (1 - Math.abs(normal.y));
    // Wait, this doesn't work for all faces. Let me use a simpler approach.
    // The corner direction is the face normal + the two perpendicular directions.
    const { uDir, up } = FACE_DIRS[faceIndex]!;
    const corner = normal.clone()
      .add(uDir.clone().multiplyScalar(Math.sign(fu)))
      .add(up.clone().multiplyScalar(Math.sign(fv)))
      .normalize();
    const idx = findOrientation(corner);
    return idx != null ? { type: 'corner', orientationIndex: idx } : null;
  }

  if (au > EDGE_THRESHOLD || av > EDGE_THRESHOLD) {
    // Edge: combine the face normal with the edge direction
    const { uDir, up } = FACE_DIRS[faceIndex]!;
    const edge = normal.clone();
    if (au > av) {
      edge.add(uDir.clone().multiplyScalar(Math.sign(fu)));
    } else {
      edge.add(up.clone().multiplyScalar(Math.sign(fv)));
    }
    edge.normalize();
    const idx = findOrientation(edge);
    return idx != null ? { type: 'edge', orientationIndex: idx } : null;
  }

  // Plain face
  const idx = ORIENTATIONS.findIndex((o) => o.position.distanceTo(normal) < 0.01);
  return idx >= 0 ? { type: 'face', orientationIndex: idx } : null;
}

/** Find the closest orientation to a given direction vector. */
export function findOrientation(dir: THREE.Vector3): number | null {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < ORIENTATIONS.length; i++) {
    const d = ORIENTATIONS[i]!.position.distanceTo(dir);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return bestDist < 0.1 ? best : null;
}
