import type { SolidBody, Vec3 } from './types';
import { computeFaceAreas } from './brep';

export interface FaceInfo {
  id: string;
  area: number;
  /** Unit outward normal. */
  normal: Vec3;
  /** Face centroid (average of its vertices). */
  centroid: Vec3;
  vertexCount: number;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Angle in degrees between two faces' planes (0–180), like SolidWorks' Measure
 * between two faces: the angle between their outward normals. Returns null if
 * either face id is missing. Adjacent box faces read 90°, opposite faces 180°.
 */
export function angleBetweenFaces(body: SolidBody, faceIdA: string, faceIdB: string): number | null {
  const a = body.faces.find((f) => f.id === faceIdA);
  const b = body.faces.find((f) => f.id === faceIdB);
  if (!a || !b) return null;
  const na = normalize(a.normal);
  const nb = normalize(b.normal);
  const d = Math.max(-1, Math.min(1, na.x * nb.x + na.y * nb.y + na.z * nb.z));
  return (Math.acos(d) * 180) / Math.PI;
}

/**
 * Inspect a body's faces — id, area, outward normal and centroid — so the UI
 * or AI can reference specific faces (e.g. to fillet, chamfer, or shell). The
 * face ids match those accepted by the face-based operations.
 */
export function listFaces(body: SolidBody): FaceInfo[] {
  const areaById = new Map<string, number>();
  for (const { faceId, area } of computeFaceAreas(body)) areaById.set(faceId, area);

  return body.faces.map((f) => {
    const c = { x: 0, y: 0, z: 0 };
    for (const v of f.vertices) {
      c.x += v.x / f.vertices.length;
      c.y += v.y / f.vertices.length;
      c.z += v.z / f.vertices.length;
    }
    return {
      id: f.id,
      area: areaById.get(f.id) ?? 0,
      normal: normalize(f.normal),
      centroid: c,
      vertexCount: f.vertices.length,
    };
  });
}

/** A circular hole whose axis runs along Y, as seen by CAM drilling. */
export interface CircularHole {
  /** Hole centre in the XZ planning plane. */
  centre: { x: number; z: number };
  diameter: number;
  /** Axial (Y) extent of the hole wall — full height for a through hole. */
  depth: number;
}

/**
 * Detect circular holes drilled along the Y axis in a (possibly watertight)
 * solid — something findBoundaryLoops cannot do, since a drilled body has no
 * open edges. Vertical wall faces are flood-grouped by shared edges; a group
 * qualifies when its vertices sit at a near-constant radius (±2%) from a
 * common axis, its face normals wind a full turn around that axis, and the
 * normals point toward the axis (a hole, not a boss). Returns holes sorted by
 * (x, z) for deterministic output.
 */
export function detectCircularHoles(body: SolidBody): CircularHole[] {
  const TOL = 1e-6;
  const q = (n: number) => Math.round(n / TOL) * TOL;
  const vkey = (v: Vec3) => `${q(v.x)},${q(v.y)},${q(v.z)}`;

  // Face adjacency via shared (undirected) edges.
  const edgeOwners = new Map<string, number[]>();
  body.faces.forEach((f, fi) => {
    const vs = f.vertices;
    for (let i = 0; i < vs.length; i++) {
      const ka = vkey(vs[i]!);
      const kb = vkey(vs[(i + 1) % vs.length]!);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const owners = edgeOwners.get(ek);
      if (owners) owners.push(fi);
      else edgeOwners.set(ek, [fi]);
    }
  });

  const isSideFace = (fi: number): boolean => {
    const n = normalize(body.faces[fi]!.normal);
    return Math.abs(n.y) < 0.05; // wall of a Y-axis hole is vertical
  };

  // Flood-fill groups of mutually adjacent vertical faces.
  const groupOf = new Map<number, number>();
  const groups: number[][] = [];
  for (let seed = 0; seed < body.faces.length; seed++) {
    if (groupOf.has(seed) || !isSideFace(seed)) continue;
    const groupId = groups.length;
    const group: number[] = [];
    const queue = [seed];
    groupOf.set(seed, groupId);
    while (queue.length > 0) {
      const fi = queue.pop()!;
      group.push(fi);
      const vs = body.faces[fi]!.vertices;
      for (let i = 0; i < vs.length; i++) {
        const ka = vkey(vs[i]!);
        const kb = vkey(vs[(i + 1) % vs.length]!);
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        for (const nf of edgeOwners.get(ek) ?? []) {
          if (!groupOf.has(nf) && isSideFace(nf)) {
            groupOf.set(nf, groupId);
            queue.push(nf);
          }
        }
      }
    }
    groups.push(group);
  }

  const holes: CircularHole[] = [];
  for (const group of groups) {
    // A polygonal circle needs enough flats to be distinguishable from
    // rectangular walls (whose four corner vertices are also concyclic).
    if (group.length < 8) continue;

    // Circle fit: the centroid of a full ring's vertices is its centre.
    const seen = new Set<string>();
    const pts: Array<{ x: number; z: number; y: number }> = [];
    for (const fi of group) {
      for (const v of body.faces[fi]!.vertices) {
        const k = vkey(v);
        if (seen.has(k)) continue;
        seen.add(k);
        pts.push({ x: v.x, z: v.z, y: v.y });
      }
    }
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;

    // Near-constant vertex radius (±2% of the mean).
    const radii = pts.map((p) => Math.hypot(p.x - cx, p.z - cz));
    const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
    if (meanR < 1e-9) continue;
    if (radii.some((r) => Math.abs(r - meanR) > 0.02 * meanR)) continue;

    // Normals must wind a full turn (no gap wider than 60°) and point INWARD —
    // toward the axis — so outer walls and bosses are rejected.
    const angles: number[] = [];
    let inward = true;
    for (const fi of group) {
      const f = body.faces[fi]!;
      const n = normalize(f.normal);
      const fcx = f.vertices.reduce((s, v) => s + v.x, 0) / f.vertices.length;
      const fcz = f.vertices.reduce((s, v) => s + v.z, 0) / f.vertices.length;
      if (n.x * (fcx - cx) + n.z * (fcz - cz) >= -1e-9 * meanR) {
        inward = false;
        break;
      }
      const len = Math.hypot(n.x, n.z);
      if (len > 1e-9) angles.push(Math.atan2(n.z, n.x));
    }
    if (!inward || angles.length < 8) continue;
    angles.sort((a, b) => a - b);
    let maxGap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
    for (let i = 1; i < angles.length; i++) {
      maxGap = Math.max(maxGap, angles[i]! - angles[i - 1]!);
    }
    if (maxGap > Math.PI / 3) continue;

    const yMin = Math.min(...pts.map((p) => p.y));
    const yMax = Math.max(...pts.map((p) => p.y));
    holes.push({
      centre: { x: cx, z: cz },
      diameter: 2 * meanR,
      depth: yMax - yMin,
    });
  }

  holes.sort((a, b) => a.centre.x - b.centre.x || a.centre.z - b.centre.z);
  return holes;
}
