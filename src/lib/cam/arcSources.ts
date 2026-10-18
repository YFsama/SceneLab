import type { SolidBody } from '../geometry/types';
import type { Point2 } from './silhouette';

/**
 * True-arc sources for the CAM generators: recovery of EXACT circular
 * geometry from analytic face tags instead of re-fitting the discretized
 * silhouette. `Face.source.kind === 'cylinder'` is set by the exact (Manifold)
 * boolean output conversion (see geometry/booleanManifold.ts) for wall groups
 * whose vertices all lie on one circle swept along a common axis — the tag's
 * origin/axis/radius are the ground truth the discretized polyline can only
 * approximate. This module turns those tags into planning-plane circles and
 * matches offset-toolpath loops against them, so the contour generator can
 * emit G2/G3 arcs straight from the analytic source (bypassing the
 * "discretize → fitArcs re-fit" round trip and its tolerance budget).
 */

/** A circle in the CAM planning plane (u, v) = (body x, body z). */
export interface PlanCircle {
  cu: number;
  cv: number;
  r: number;
}

/** Minimum angular coverage (rad) for a matched run to count as an arc —
 * 30°. Below this a "circular" stretch is chamfer noise, not a feature. */
const MIN_RUN_SWEEP = Math.PI / 6;
/** Maximum angular step (rad) between consecutive loop vertices of one run —
 * 60°. Real cylinder faceting steps are ≤ 2π/8 (the brep adaptive-segment
 * floor), while sparse concyclic touches (e.g. a rectangle whose four corners
 * land on one circle) step ~90°; the cap rejects those exactly like the
 * sagitta guard does for fitArcs' greedy spans. */
const MAX_RUN_STEP = Math.PI / 3;

/**
 * All vertical-cylinder wall tags of the bodies, projected to planning-plane
 * circles: origin (x, z) with the tag radius. Only axes ∥ body-Y qualify —
 * anything tilted projects to an ellipse, which a G17 arc cannot represent.
 * Duplicate circles (the same wall tagged on many facets) collapse to one.
 */
export function planCirclesFromBodies(bodies: SolidBody[]): PlanCircle[] {
  const out: PlanCircle[] = [];
  for (const body of bodies) {
    for (const face of body.faces) {
      const src = face.source;
      if (!src || src.kind !== 'cylinder') continue;
      const len = Math.hypot(src.axis.x, src.axis.y, src.axis.z);
      if (!(len > 1e-12)) continue;
      // Within ~0.1° of ±Y (the eigenvector axis is unit, so compare |ay|/|a|).
      if (Math.abs(src.axis.y) / len < 1 - 1e-6) continue;
      if (!(src.radius > 1e-9)) continue;
      const c: PlanCircle = { cu: src.origin.x, cv: src.origin.z, r: src.radius };
      if (!out.some((o) => Math.abs(o.cu - c.cu) < 1e-9 && Math.abs(o.cv - c.cv) < 1e-9 && Math.abs(o.r - c.r) < 1e-9)) {
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * A maximal run of consecutive `loop` vertices that lie on one plan circle.
 * Indices address the loop array with wrap-around: the run covers
 * loop[from], loop[from + 1], …, loop[to mod loop.length], so a FULL-ring
 * match (the whole loop is the circle) has to − from === loop.length − 1.
 * The caller owns the circle's radius semantics — it passes circles already
 * adjusted for the cutter offset (wall r ± offset), so a matched run can be
 * replaced by an arc on exactly that circle.
 */
export interface ArcRun {
  from: number;
  to: number;
  circle: PlanCircle;
  /** Travel direction around the circle (CCW in the (u, v) plane), derived
   *  from the loop's own winding — the arc must run the way the loop runs. */
  ccw: boolean;
}

/**
 * Match a closed polyline loop against candidate circles: every vertex of a
 * run must sit within `tol` of its circle radially, consecutive vertices
 * must advance around the circle in ONE direction with steps ≤ 60°, and the
 * run must cover ≥ 30° of the circle. Runs are maximal and non-overlapping
 * per circle; two distinct circles cannot both match the same vertices in
 * practice (tol is far below the circle separation), so no cross-circle
 * dedupe is performed. Returns runs ordered by `from` for determinism.
 *
 * `tol` is a VERTEX radial tolerance — the polyline's own discretization
 * error (chord sagitta at edge midpoints) is irrelevant because a match
 * REPLACES the polyline with the analytic circle, which is strictly more
 * exact than the polyline it came from.
 */
export function matchArcRuns(loop: Point2[], circles: PlanCircle[], tol: number): ArcRun[] {
  const n = loop.length;
  const runs: ArcRun[] = [];
  if (n < 2 || circles.length === 0) return runs;

  for (const circle of circles) {
    if (!(circle.r > 1e-9)) continue;
    const angle: number[] = new Array(n);
    const on: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = loop[i]!;
      const du = p.u - circle.cu;
      const dv = p.v - circle.cv;
      angle[i] = Math.atan2(dv, du);
      on[i] = Math.abs(Math.hypot(du, dv) - circle.r) < tol;
    }

    // Walk maximal circular runs of consecutive on-vertices. A loop where
    // every vertex is on is one FULL-ring run (from 0 to n); otherwise each
    // run starts right after an off-vertex and stops at the next one.
    let allOn = true;
    for (let i = 0; i < n; i++) {
      if (!on[i]) {
        allOn = false;
        break;
      }
    }
    const starts: number[] = [];
    if (allOn) {
      starts.push(0);
    } else {
      for (let i = 0; i < n; i++) {
        if (on[i] && !on[(i - 1 + n) % n]) starts.push(i);
      }
    }

    for (const from of starts) {
      let to = from;
      while (to - from < n && on[to % n]) to += 1;
      // to is the first off index (or from + n for the full ring); the run's
      // last vertex is to − 1, but arcs replace the polyline up to that
      // vertex, so `to` names the END vertex index directly.
      const end = to - 1;
      if (end === from && !allOn) continue; // single stray vertex — no segment

      // Angular walk: monotone direction, bounded steps, ≥ 30° total.
      let dir = 0;
      let sweep = 0;
      let ok = true;
      for (let k = from; k < end; k++) {
        let d = angle[(k + 1) % n]! - angle[k % n]!;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(d) > MAX_RUN_STEP) {
          ok = false;
          break;
        }
        if (Math.abs(d) > 1e-12) {
          const s = d > 0 ? 1 : -1;
          if (dir === 0) dir = s;
          else if (s !== dir) {
            ok = false;
            break;
          }
        }
        sweep += Math.abs(d);
      }
      if (!ok || dir === 0 || sweep < MIN_RUN_SWEEP) continue;
      runs.push({ from, to: end, circle, ccw: dir > 0 });
    }
  }

  runs.sort((a, b) => a.from - b.from || a.to - b.to);
  return runs;
}
