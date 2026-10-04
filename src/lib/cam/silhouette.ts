import type { SolidBody } from '../geometry/types';

/** A point in the CAM planning plane: u = body x, v = body z. */
export interface Point2 {
  u: number;
  v: number;
}

export interface SilhouetteLoop {
  points: Point2[];
  /** Signed area; positive after normalization (CCW in the u/v plane). */
  area: number;
}

/**
 * Top-view silhouette of a body: the outline of its projection onto the XZ
 * plane (looking down the −Y axis), as one outer loop plus interior loops
 * ("islands" — through-holes seen from above). Concavities are preserved: the
 * outline is threaded from the projected edge graph, never convex-hulled.
 */
export interface TopSilhouette {
  outer: SilhouetteLoop;
  islands: SilhouetteLoop[];
}

const Q = 1e-4; // vertex merge tolerance for the projected graph (0.1 µm)

function vkey(u: number, v: number): string {
  return `${Math.round(u / Q) * Q},${Math.round(v / Q) * Q}`;
}

/** Signed area of a closed u/v polygon (positive = CCW). */
export function polygonArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.u * q.v - q.u * p.v;
  }
  return a / 2;
}

/** Even-odd point-in-polygon test (boundary behaviour follows PNPOLY). */
export function pointInPolygon(p: Point2, poly: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.v > p.v !== b.v > p.v && p.u < ((b.u - a.u) * (p.v - a.v)) / (b.v - a.v) + a.u) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * True when a vertical ray cast upward from (u, v) touches the body, i.e. the
 * point sits over material. The ray starts below the body, so ANY face whose
 * (x, z) projection covers the point means the surface — and therefore the
 * closed solid — passes through that column. Faces are fan-triangulated and
 * tested with a consistent half-open PNPOLY rule so shared triangle borders
 * are never double-counted.
 */
function bodyCoversPoint(body: SolidBody, u: number, v: number): boolean {
  for (const face of body.faces) {
    const vs = face.vertices;
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[0]!;
      const b = vs[i]!;
      const c = vs[i + 1]!;
      let hit = false;
      const tri = [
        { u: a.x, v: a.z },
        { u: b.x, v: b.z },
        { u: c.x, v: c.z },
      ];
      for (let k = 0, m = 2; k < 3; m = k++) {
        const p1 = tri[k]!;
        const p2 = tri[m]!;
        if (p1.v > v !== p2.v > v && u < ((p2.u - p1.u) * (v - p1.v)) / (p2.v - p1.v) + p1.u) {
          hit = !hit;
        }
      }
      if (hit) return true;
    }
  }
  return false;
}

interface GraphVertex {
  u: number;
  v: number;
  /** Adjacent vertex indices, sorted CCW by outgoing edge angle. */
  adj: number[];
}

/**
 * Project every body edge to the u/v plane, merge coincident vertices, and
 * walk the planar subdivision face-by-face ("next edge clockwise from the
 * reverse bearing" traversal). Faces walked CCW are bounded; sampling each
 * against the 3D solid separates material faces from empty ones, and edges
 * used by exactly one material face chain into the silhouette loops.
 */
export function topSilhouette(body: SolidBody): TopSilhouette | null {
  // 1. Build the projected graph.
  const verts: GraphVertex[] = [];
  const vertIndex = new Map<string, number>();
  const edgeSet = new Set<string>();
  const getVertex = (u: number, v: number): number => {
    const k = vkey(u, v);
    let idx = vertIndex.get(k);
    if (idx === undefined) {
      idx = verts.length;
      verts.push({ u, v, adj: [] });
      vertIndex.set(k, idx);
    }
    return idx;
  };

  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    verts[a]!.adj.push(b);
    verts[b]!.adj.push(a);
  };

  for (const face of body.faces) {
    const vs = face.vertices;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      const du = b.x - a.x;
      const dv = b.z - a.z;
      if (Math.hypot(du, dv) < Q) continue; // vertical (Y-parallel) edge → point
      addEdge(getVertex(a.x, a.z), getVertex(b.x, b.z));
    }
  }
  if (verts.length === 0 || edgeSet.size === 0) return null;

  // Sort adjacency CCW by bearing so the face walk can pick neighbours.
  for (const vert of verts) {
    vert.adj.sort((a, b) => {
      const va = verts[a]!;
      const vb = verts[b]!;
      return Math.atan2(va.v - vert.v, va.u - vert.u) - Math.atan2(vb.v - vert.v, vb.u - vert.u);
    });
  }

  // 2. Walk every half-edge once, tracing faces.
  const used = new Set<string>(); // "from>to" half-edge keys
  const loops: Array<{ points: Point2[]; halfEdges: Array<[number, number]> }> = [];
  const totalHalfEdges = edgeSet.size * 2;
  let walked = 0;

  for (let s = 0; s < verts.length && walked < totalHalfEdges; s++) {
    for (const first of verts[s]!.adj) {
      if (used.has(`${s}>${first}`)) continue;
      const points: Point2[] = [];
      const halfEdges: Array<[number, number]> = [];
      let cur = s;
      let next = first;
      let guard = 0;
      while (!used.has(`${cur}>${next}`) && guard++ <= edgeSet.size + 1) {
        used.add(`${cur}>${next}`);
        walked++;
        points.push({ u: verts[cur]!.u, v: verts[cur]!.v });
        halfEdges.push([cur, next]);
        // Continue with the outgoing edge that is next clockwise from the
        // reverse bearing — this keeps the walked face on the left.
        const adj = verts[next]!.adj;
        let pick = -1;
        for (let i = 0; i < adj.length; i++) {
          if (adj[i] === cur) {
            pick = adj[(i - 1 + adj.length) % adj.length]!;
            break;
          }
        }
        if (pick === -1) break; // dangling vertex — should not happen
        cur = next;
        next = pick;
      }
      if (points.length >= 3) loops.push({ points, halfEdges });
    }
  }

  // 3. Keep bounded CCW faces that sit over material.
  const materialLoops = loops.filter((l) => {
    const area = polygonArea(l.points);
    if (area <= 1e-9) return false; // CW (unbounded side) or degenerate
    // Interior sample: midpoint of the longest edge nudged to the left (CCW ⇒ interior).
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < l.points.length; i++) {
      const a = l.points[i]!;
      const b = l.points[(i + 1) % l.points.length]!;
      const len = Math.hypot(b.u - a.u, b.v - a.v);
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    }
    const a = l.points[best]!;
    const b = l.points[(best + 1) % l.points.length]!;
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const len = Math.hypot(du, dv) || 1;
    // Left normal of the travel direction (CCW interior side).
    const sample = { u: (a.u + b.u) / 2 - (dv / len) * 1e-3, v: (a.v + b.v) / 2 + (du / len) * 1e-3 };
    return bodyCoversPoint(body, sample.u, sample.v);
  });
  if (materialLoops.length === 0) return null;

  // 4. Outline = half-edges used by exactly one material face.
  const useCount = new Map<string, number>();
  for (const l of materialLoops) {
    for (const [a, b] of l.halfEdges) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      useCount.set(k, (useCount.get(k) ?? 0) + 1);
    }
  }
  const outlineHalfEdges = new Map<number, number[]>(); // from-vertex → to-vertices
  for (const l of materialLoops) {
    for (const [a, b] of l.halfEdges) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (useCount.get(k) !== 1) continue;
      const list = outlineHalfEdges.get(a);
      if (list) list.push(b);
      else outlineHalfEdges.set(a, [b]);
    }
  }

  // 5. Thread the outline half-edges into closed loops.
  const consumed = new Set<string>();
  const closed: Point2[][] = [];
  for (const [start, targets] of outlineHalfEdges) {
    for (const firstTarget of targets) {
      if (consumed.has(`${start}>${firstTarget}`)) continue;
      const pts: Point2[] = [];
      let cur = start;
      let next = firstTarget;
      let guard = 0;
      while (!consumed.has(`${cur}>${next}`) && guard++ <= outlineHalfEdges.size + 1) {
        consumed.add(`${cur}>${next}`);
        pts.push({ u: verts[cur]!.u, v: verts[cur]!.v });
        const nexts = outlineHalfEdges.get(next);
        if (!nexts || nexts.length === 0) break;
        const step = nexts.find((n) => !consumed.has(`${next}>${n}`));
        if (step === undefined) break;
        cur = next;
        next = step;
      }
      if (pts.length >= 3) closed.push(pts);
    }
  }
  if (closed.length === 0) return null;

  // 6. Normalize CCW, classify by containment parity (even-odd nesting).
  const loopsOut: SilhouetteLoop[] = [];
  for (const pts of closed) {
    const area = polygonArea(pts);
    const norm = area < 0 ? [...pts].reverse() : pts;
    const a = Math.abs(area);
    if (a < 1e-9) continue;
    loopsOut.push({ points: norm, area: a });
  }
  if (loopsOut.length === 0) return null;

  const depthOf = (loop: SilhouetteLoop): number => {
    let depth = 0;
    const probe = loop.points[0]!;
    for (const other of loopsOut) {
      if (other === loop) continue;
      if (pointInPolygon(probe, other.points)) depth++;
    }
    return depth;
  };

  const outerCandidates = loopsOut.filter((l) => depthOf(l) === 0);
  if (outerCandidates.length === 0) return null;
  const outer = outerCandidates.reduce((a, b) => (b.area > a.area ? b : a));
  const islands = loopsOut.filter((l) => l !== outer && depthOf(l) % 2 === 1);
  return { outer, islands };
}

/**
 * Offset a closed CCW polygon by `distance` using per-vertex normal averaging
 * (miter without length compensation). Positive distance grows the polygon
 * outward; negative shrinks it inward. Sharp concave corners can self-
 * intersect slightly — acceptable for polygon toolpath output. If a negative
 * offset flips the polygon (tool larger than the feature) null is returned.
 */
export function offsetPolygon(points: Point2[], distance: number): Point2[] | null {
  const n = points.length;
  if (n < 3 || Math.abs(distance) < 1e-12) return [...points];

  // An inward offset deeper than the polygon's inscribed depth is invalid:
  // the eroded region is empty and the vertex-offset output turns to garbage.
  // The centroid's minimum distance to the boundary is a conservative lower
  // bound on the inradius, which is enough to reject a too-big tool.
  if (distance < 0) {
    let cu = 0;
    let cv = 0;
    for (const p of points) {
      cu += p.u / n;
      cv += p.v / n;
    }
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      const du = b.u - a.u;
      const dv = b.v - a.v;
      const lenSq = du * du + dv * dv;
      const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((cu - a.u) * du + (cv - a.v) * dv) / lenSq));
      const pu = a.u + t * du;
      const pv = a.v + t * dv;
      minDist = Math.min(minDist, Math.hypot(cu - pu, cv - pv));
    }
    if (-distance > minDist) return null;
  }

  const normalOf = (a: Point2, b: Point2): Point2 => {
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const len = Math.hypot(du, dv);
    if (len < 1e-12) return { u: 0, v: 0 };
    // Outward normal of a CCW edge (travel direction rotated −90°).
    return { u: dv / len, v: -du / len };
  };

  const out: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const n1 = normalOf(prev, cur);
    const n2 = normalOf(cur, next);
    let mu = n1.u + n2.u;
    let mv = n1.v + n2.v;
    const mLen = Math.hypot(mu, mv);
    // Miter scale: moving `distance` along the NORMALIZED bisector leaves the
    // offset EDGES only distance·cos(φ/2) from the originals — a right angle
    // would sit 29% short and gouge the wall by that much. The correct miter
    // displacement is distance / cos(φ/2) along the normalized bisector,
    // with cos(φ/2) = |n1+n2|/2 = √((1+n1·n2)/2). Clamp near-reversals so a
    // spike can't explode (same clamp spirit as the sketch offset tool).
    let scale = 1;
    if (mLen < 1e-9) {
      // Collinear or degenerate — use whichever normal exists.
      const fb = n1.u !== 0 || n1.v !== 0 ? n1 : n2;
      mu = fb.u;
      mv = fb.v;
    } else {
      const cosHalfSq = Math.max((1 + (n1.u * n2.u + n1.v * n2.v)) / 2, 0.082); // cos²(φ/2), floored ≈ 73.6°
      scale = Math.min(1 / Math.sqrt(cosHalfSq), 3.5);
      mu /= mLen;
      mv /= mLen;
    }
    out.push({ u: cur.u + mu * distance * scale, v: cur.v + mv * distance * scale });
  }

  // A negative offset that exceeds the feature size inverts the polygon.
  if (distance < 0 && polygonArea(out) <= 0) return null;
  return out;
}

/**
 * Intersect a horizontal scanline v = const with a polygon, returning the
 * u-intervals where the line is inside (even-odd rule). Vertex-exact crossings
 * use half-open edges so shared vertices count once.
 */
export function scanlineIntervals(poly: Point2[], v: number): Array<[number, number]> {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    if (a.v > v !== b.v > v) {
      xs.push(a.u + ((v - a.v) / (b.v - a.v)) * (b.u - a.u));
    }
  }
  xs.sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}

/** Subtract `holes` intervals from `base` intervals (both sorted, disjoint). */
export function subtractIntervals(
  base: Array<[number, number]>,
  holes: Array<[number, number]>,
): Array<[number, number]> {
  let out = [...base];
  for (const [hs, he] of holes) {
    const next: Array<[number, number]> = [];
    for (const [bs, be] of out) {
      if (he <= bs || hs >= be) {
        next.push([bs, be]);
        continue;
      }
      if (hs > bs) next.push([bs, Math.min(hs, be)]);
      if (he < be) next.push([Math.max(he, bs), be]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 1e-9);
}
