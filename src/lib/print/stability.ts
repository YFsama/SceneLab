import type { SolidBody, Vec3 } from '../geometry/types';
import { computeVolumetricCentroid } from '../geometry';
import { convexHull2D } from '../geometry/convexHull';

export interface StabilityOptions {
  /** Build / "up" axis. Defaults to +Y (model up). */
  up?: Vec3;
  /**
   * Vertices within this height of the lowest point count as the base.
   * Defaults to 1% of the part height (min 1e-6).
   */
  baseTolerance?: number;
}

export interface StabilityReport {
  /** Center of mass (volume-weighted, uniform density). */
  centerOfMass: Vec3;
  /** Area of the base support polygon (mm²). */
  footprintArea: number;
  /** Whether the center of mass projects inside the base footprint. */
  comInsideBase: boolean;
  /**
   * Signed distance (mm) from the projected CoM to the nearest base edge:
   * positive inside, negative outside. Larger = more tip-over resistance.
   */
  marginMm: number;
  /** Convenience flag: comInsideBase with a usable (≥3-point) base. */
  stable: boolean;
  /** Height of the center of mass above the base plane (mm). */
  comHeightMm: number;
  /**
   * Critical tilt angle (degrees): how far the base can be tilted before the
   * part topples about its nearest base edge, `atan(marginMm / comHeightMm)`.
   * 90° for a part whose CoM sits directly over the base with no height; 0 if
   * the part is already unstable (CoM outside the base).
   */
  tippingAngleDeg: number;
}

interface Vec2 {
  x: number;
  y: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Build an orthonormal (u, v) basis spanning the plane perpendicular to `up`. */
function planeBasis(up: Vec3): { u: Vec3; v: Vec3 } {
  const n = norm(up);
  // Pick a reference axis not parallel to n.
  const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = norm(cross(ref, n));
  const v = cross(n, u);
  return { u, v };
}

function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Min distance from a point to a convex polygon boundary. */
function distToBoundary(p: Vec2, poly: Vec2[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 < 1e-12 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + t * abx);
    const dy = p.y - (a.y + t * aby);
    min = Math.min(min, Math.hypot(dx, dy));
  }
  return min;
}

/** Point in CCW convex polygon (inclusive). */
function pointInConvex(p: Vec2, poly: Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const crossZ = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (crossZ < -1e-9) return false; // right of an edge → outside
  }
  return true;
}

/**
 * Estimate whether a printed part is statically stable on its base: does its
 * center of mass project inside the base support polygon, and with how much
 * margin before it would tip?
 */
export function analyzeStability(body: SolidBody, options: StabilityOptions = {}): StabilityReport {
  const up = norm(options.up ?? { x: 0, y: 1, z: 0 });
  const com = computeVolumetricCentroid(body);

  const empty: StabilityReport = {
    centerOfMass: com,
    footprintArea: 0,
    comInsideBase: false,
    marginMm: 0,
    stable: false,
    comHeightMm: 0,
    tippingAngleDeg: 0,
  };
  if (body.vertices.length === 0) return empty;

  // Heights along the build axis.
  const heights = body.vertices.map((v) => dot(v, up));
  const minH = Math.min(...heights);
  const maxH = Math.max(...heights);
  const tol = options.baseTolerance ?? Math.max(1e-6, (maxH - minH) * 0.01);

  const { u, v } = planeBasis(up);
  const project = (p: Vec3): Vec2 => ({ x: dot(p, u), y: dot(p, v) });

  const base2d: Vec2[] = [];
  for (const vert of body.vertices) {
    if (dot(vert, up) <= minH + tol) base2d.push(project(vert));
  }

  const hull = convexHull2D(base2d);
  if (hull.length < 3) return empty;

  const comUV = project(com);
  const inside = pointInConvex(comUV, hull);
  const dist = distToBoundary(comUV, hull);
  const marginMm = inside ? dist : -dist;

  const comHeightMm = Math.max(0, dot(com, up) - minH);
  // Tip-over about the nearest base edge: tan(θ) = horizontal margin / CoM
  // height. Already-unstable parts (CoM outside the base) report 0.
  const tippingAngleDeg = !inside
    ? 0
    : comHeightMm < 1e-9
      ? 90
      : (Math.atan2(marginMm, comHeightMm) * 180) / Math.PI;

  return {
    centerOfMass: com,
    footprintArea: polygonArea(hull),
    comInsideBase: inside,
    marginMm,
    stable: inside,
    comHeightMm,
    tippingAngleDeg,
  };
}
