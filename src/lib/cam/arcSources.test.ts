import { describe, it, expect } from 'vitest';
import { planCirclesFromBodies, matchArcRuns, type PlanCircle } from './arcSources';
import type { Point2 } from './silhouette';
import type { SolidBody, Face, FaceSource, Vec3 } from '../geometry/types';

let nextId = 1;
const genId = (prefix: string): string => `${prefix}_${nextId++}`;

/**
 * Hand-built n-gon prism whose WALL faces carry the analytic cylinder tag
 * the exact boolean kernel would set (brep primitives never do — that is the
 * production split this module exists for). Vertices sit ON the circle, the
 * same inscribed convention createCylinder uses, so the silhouette is an
 * n-gon approximating the tagged analytic circle. `innerRadius` builds a
 * tube: the hole wall gets its own tag (a second, smaller circle).
 */
export function taggedCylinderBody(
  radius: number,
  height: number,
  segments: number,
  opts: { cu?: number; cv?: number; innerRadius?: number; tagWalls?: boolean } = {},
): SolidBody {
  const cu = opts.cu ?? 0;
  const cv = opts.cv ?? 0;
  const tagWalls = opts.tagWalls ?? true;
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const seen = new Set<string>();
  const push = (v: Vec3): number => {
    const k = `${v.x.toFixed(9)},${v.y.toFixed(9)},${v.z.toFixed(9)}`;
    if (seen.has(k)) return vertices.findIndex((w) => w.x === v.x && w.y === v.y && w.z === v.z);
    seen.add(k);
    vertices.push(v);
    return vertices.length - 1;
  };
  const ring = (y: number, r: number): number[] =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * 2 * Math.PI;
      return push({ x: cu + Math.cos(a) * r, y, z: cv + Math.sin(a) * r });
    });
  const cylinderTag = (r: number): FaceSource => ({
    kind: 'cylinder',
    origin: { x: cu, y: height / 2, z: cv },
    axis: { x: 0, y: 1, z: 0 },
    radius: r,
  });

  const outerWall = (r: number, outwardSign: 1 | -1): void => {
    const b = ring(0, r);
    const t = ring(height, r);
    const tag = tagWalls ? cylinderTag(r) : undefined;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const a = (i / segments) * 2 * Math.PI;
      const radial = { x: Math.cos(a) * outwardSign, y: 0, z: Math.sin(a) * outwardSign };
      faces.push({
        id: genId('face'),
        vertices: [vertices[b[i]!]!, vertices[b[j]!]!, vertices[t[j]!]!, vertices[t[i]!]!],
        normal: radial,
        source: tag,
      });
    }
  };
  const cap = (y: number, up: boolean): void => {
    const c = push({ x: cu, y, z: cv });
    const r = ring(y, radius);
    const inner = opts.innerRadius !== undefined ? ring(y, opts.innerRadius) : null;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const loop = inner
        ? [vertices[r[i]!]!, vertices[r[j]!]!, vertices[inner[j]!]!, vertices[inner[i]!]!]
        : [vertices[c]!, vertices[r[i]!]!, vertices[r[j]!]!];
      faces.push({
        id: genId('face'),
        vertices: up ? loop : [...loop].reverse(),
        normal: { x: 0, y: up ? 1 : -1, z: 0 },
      });
    }
  };

  outerWall(radius, 1);
  if (opts.innerRadius !== undefined) outerWall(opts.innerRadius, -1);
  cap(height, true);
  cap(0, false);

  return { id: genId('body'), name: 'TaggedCylinder', vertices, faces, edges: [] };
}

/** Circle polyline (inscribed n-gon) as Point2 loop. */
function circleLoop(n: number, r: number, cu = 0, cv = 0, startDeg = 0): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    return { u: cu + Math.cos(a) * r, v: cv + Math.sin(a) * r };
  });
}

describe('planCirclesFromBodies', () => {
  it('extracts and dedupes the tagged wall circles', () => {
    const body = taggedCylinderBody(10, 20, 55);
    const circles = planCirclesFromBodies([body, body]);
    expect(circles).toHaveLength(1);
    expect(circles[0]!.cu).toBeCloseTo(0, 12);
    expect(circles[0]!.cv).toBeCloseTo(0, 12);
    expect(circles[0]!.r).toBeCloseTo(10, 12);
  });

  it('keeps the tube hole wall as its own smaller circle', () => {
    const body = taggedCylinderBody(15, 20, 64, { innerRadius: 6 });
    const rs = planCirclesFromBodies([body]).map((c) => c.r).sort((a, b) => a - b);
    expect(rs).toEqual([6, 15]);
  });

  it('honours an off-origin centre', () => {
    const body = taggedCylinderBody(5, 8, 32, { cu: 12.5, cv: -7.25 });
    const c = planCirclesFromBodies([body])[0]!;
    expect(c.cu).toBeCloseTo(12.5, 12);
    expect(c.cv).toBeCloseTo(-7.25, 12);
  });

  it('ignores tilted cylinders, untagged walls and degenerate tags', () => {
    const tilted = taggedCylinderBody(10, 20, 32);
    for (const f of tilted.faces) {
      if (f.source?.kind === 'cylinder') f.source = { ...f.source, axis: { x: 0.7, y: 0.7, z: 0 } };
    }
    expect(planCirclesFromBodies([tilted])).toHaveLength(0);

    const untagged = taggedCylinderBody(10, 20, 32, { tagWalls: false });
    expect(planCirclesFromBodies([untagged])).toHaveLength(0);

    const zero = taggedCylinderBody(10, 20, 32);
    for (const f of zero.faces) {
      if (f.source?.kind === 'cylinder') f.source = { ...f.source, radius: 0 };
    }
    expect(planCirclesFromBodies([zero])).toHaveLength(0);
  });
});

describe('matchArcRuns', () => {
  const C: PlanCircle = { cu: 0, cv: 0, r: 13 };
  const TOL = 0.05;

  it('matches a full ring (rotated start) with the loop travel direction', () => {
    const loop = circleLoop(55, 13, 0, 0, 137); // arbitrary start angle
    const runs = matchArcRuns(loop, [C], TOL);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.from).toBe(0);
    expect(runs[0]!.to).toBe(loop.length - 1);
    expect(runs[0]!.ccw).toBe(true); // CCW loop
    expect(runs[0]!.circle).toBe(C);

    const cw = [...loop].reverse();
    expect(matchArcRuns(cw, [C], TOL)[0]!.ccw).toBe(false);
  });

  it('matches a partial arc run and leaves the straight legs out', () => {
    // A "D" profile: 120° of the circle between two off-circle legs.
    const arc = Array.from({ length: 21 }, (_, i) => {
      const a = ((i / 20) * 120) * (Math.PI / 180);
      return { u: 13 * Math.cos(a), v: 13 * Math.sin(a) };
    });
    const loop: Point2[] = [{ u: 26, v: -8 }, ...arc, { u: -6.5, v: 30 }, { u: 0, v: 33 }];
    const runs = matchArcRuns(loop, [C], TOL);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.from).toBe(1);
    expect(runs[0]!.to).toBe(21);
    expect(runs[0]!.ccw).toBe(true);
  });

  it('does not match a rectangle whose corners graze the circle', () => {
    // Four corners exactly ON the circle, edges stepping 90° apart.
    const loop = circleLoop(4, 13);
    expect(matchArcRuns(loop, [C], TOL)).toHaveLength(0);
  });

  it('tolerates sub-tol radial noise, rejects supra-tol', () => {
    const loop = circleLoop(48, 13);
    for (const p of loop) {
      p.u *= 1 + 0.002; // +0.026 radial — inside 0.05
    }
    expect(matchArcRuns(loop, [C], TOL)).toHaveLength(1);

    // Uniform radial push-out by 0.5 mm — no vertex stays within 0.05.
    for (const p of loop) {
      const d = Math.hypot(p.u, p.v);
      p.u *= (d + 0.5) / d;
      p.v *= (d + 0.5) / d;
    }
    expect(matchArcRuns(loop, [C], TOL)).toHaveLength(0);
  });

  it('rejects coverage below 30°', () => {
    const short = [
      { u: 13, v: 0 },
      { u: 13 * Math.cos(0.17), v: 13 * Math.sin(0.17) },
      { u: 13 * Math.cos(0.34), v: 13 * Math.sin(0.34) }, // 19.5° span
      { u: 40, v: 40 },
      { u: -40, v: 40 },
    ];
    expect(matchArcRuns(short, [C], TOL)).toHaveLength(0);
  });

  it('rejects a run that backtracks around the circle', () => {
    // Points on the circle but visiting angles out of order — the whole
    // maximal run fails validation and falls back to polyline (the safe
    // side: a real offset circle never backtracks).
    const angs = [0, 0.1, 0.2, 0.3, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
    const loop = angs.map((a) => ({ u: 13 * Math.cos(a), v: 13 * Math.sin(a) }));
    expect(matchArcRuns(loop, [C], TOL)).toHaveLength(0);
  });

  it('empty inputs and empty circles produce no runs', () => {
    expect(matchArcRuns([], [C], TOL)).toEqual([]);
    expect(matchArcRuns(circleLoop(8, 13), [], TOL)).toEqual([]);
  });
});
