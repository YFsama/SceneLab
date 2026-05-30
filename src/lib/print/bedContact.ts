import type { SolidBody, Vec3 } from '../geometry/types';
import { computeFaceAreas } from '../geometry';

export interface BedContactOptions {
  /** Build / "up" axis. Defaults to +Y. */
  buildDirection?: Vec3;
  /** Height band (mm) from the lowest point that counts as "on the bed". */
  baseTolerance?: number;
}

export interface BedContactReport {
  /** Total area of faces resting on the build plate (first-layer area, mm²). */
  contactArea: number;
  contactFaces: number;
  /** Combined perimeter of the contact faces (mm) — a skirt/brim length guide. */
  perimeterMm: number;
  /** Part height along the build axis (mm). */
  height: number;
  /**
   * Dimensionless tallness = height / sqrt(contactArea). Larger values mean a
   * tall part on a small base — higher tip/detach/warp risk. 0 if no contact.
   */
  tallness: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}
function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * Analyse the part's first-layer contact with the build plate: how much area
 * touches the bed, its perimeter, and a tallness ratio indicating warp/detach
 * risk for tall parts on small footprints.
 */
export function analyzeBedContact(body: SolidBody, options: BedContactOptions = {}): BedContactReport {
  const buildDirection = normalize(options.buildDirection ?? { x: 0, y: 1, z: 0 });

  const heights = body.vertices.map((v) => dot(v, buildDirection));
  const minH = heights.length ? Math.min(...heights) : 0;
  const maxH = heights.length ? Math.max(...heights) : 0;
  const height = maxH - minH;
  const baseTol = options.baseTolerance ?? Math.max(1e-6, height * 0.01);

  const areaById = new Map<string, number>();
  for (const { faceId, area } of computeFaceAreas(body)) areaById.set(faceId, area);

  let contactArea = 0;
  let contactFaces = 0;
  // Tally each contact-face edge by an orientation-independent key; only edges
  // used an odd number of times lie on the outer boundary. Edges shared between
  // adjacent contact faces (e.g. a triangulated base) cancel, so the perimeter
  // is the true brim outline rather than the sum of every face's perimeter.
  const edgeUse = new Map<string, { count: number; len: number }>();
  const vkey = (v: Vec3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;

  for (const face of body.faces) {
    if (face.vertices.length === 0) continue;
    const n = normalize(face.normal);
    const d = dot(n, buildDirection);
    const centroidH = face.vertices.reduce((s, v) => s + dot(v, buildDirection), 0) / face.vertices.length;
    // A contact face faces down and sits at the lowest level.
    if (d < 0 && centroidH <= minH + baseTol) {
      contactArea += areaById.get(face.id) ?? 0;
      contactFaces += 1;
      for (let i = 0; i < face.vertices.length; i++) {
        const a = face.vertices[i]!;
        const b = face.vertices[(i + 1) % face.vertices.length]!;
        const ka = vkey(a);
        const kb = vkey(b);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const entry = edgeUse.get(key);
        if (entry) entry.count += 1;
        else edgeUse.set(key, { count: 1, len: dist(a, b) });
      }
    }
  }

  let perimeterMm = 0;
  for (const { count, len } of edgeUse.values()) {
    if (count % 2 === 1) perimeterMm += len; // boundary edge
  }

  const tallness = contactArea > 1e-9 ? height / Math.sqrt(contactArea) : 0;
  return { contactArea, contactFaces, perimeterMm, height, tallness };
}
