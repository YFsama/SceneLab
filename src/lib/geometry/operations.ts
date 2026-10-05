import type { Vec3, SolidBody, Face, Edge } from './types';
import { computeConvexHull } from './convexHull';
import { localToWorld, type CoordinateSystemDefinition } from './referenceGeometry';
import { filletManifold, chamferManifold, shellManifold } from './booleanManifold';
import { erodedInteriorVoxel } from './booleanVoxel';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/** Occupancy resolution for applyShell's non-convex (voxel-eroded) interior. */
const SHELL_VOXEL_RESOLUTION = 40;

/** Largest voxel cell edge applyShell's interior sampling would produce —
 *  the slack the opening prisms need to break through a blocky inner wall. */
function shellVoxelCellSize(body: SolidBody): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of body.vertices) {
    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return extent / SHELL_VOXEL_RESOLUTION;
}

/**
 * Fillet: round convex edges.
 *
 * EXACT PATH (engine warm, manifold-convertible body, only convex selected
 * edges): body − ⋃(analytic cylinder of `radius` along each selected edge),
 * computed by the Manifold engine (see filletManifold). This is the true
 * subtractive fillet: watertight, corner-correct within ~0.6% (at 3-edge
 * corners the prismatic union keeps slightly more than the true rolling
 * ball's ball-octant — see filletManifold's doc), and every downstream
 * boolean stays on the fast exact path. The cylinder facets land within
 * ~0.15% of the true arc (96-gon).
 *
 * OVERLAY FALLBACK (engine cold, non-manifold body, reflex/concave selected
 * edges, or the exact op fails): the pass-30 stopgap below — round convex
 * edges by overlaying a closed subtractive "sliver" shell per edge (arc
 * facets + wall quads + end-cap fans).
 *
 * Geometry (per filleted edge, ARC_SEGMENTS = 8 facets):
 * - The arc center sits INSIDE the corner, at `radius / cos(halfAngle)` from
 *   the edge along the interior bisector `-(n1+n2)/|n1+n2)|` (halfAngle =
 *   half the angle between the adjacent face normals). The previous
 *   implementation put the center on the +bisector — outside the solid — so
 *   every strip floated r·√2 off the part and swept a full π, ending buried
 *   inside the material: +volume instead of −, 6.93 mm protrusion past the
 *   bbox at r=4.9, 49.6° normal kinks, 216 non-manifold boundary edges.
 * - The arc sweeps α ∈ [−halfAngle, +halfAngle] around that center, so it
 *   runs tangent-to-face → tangent-to-face EXACTLY: the tangent lines land
 *   in-plane at `radius·cot(halfAngle)` (= radius for a 90° corner) along
 *   each adjacent face. 8 facets over the 90° quarter of a box edge means
 *   11.25° steps (the old 180° sweep over 8 segments kinked 49.6°).
 *
 * Overlay semantics (deliberate stopgap, kept as the fallback/preview):
 * - The original faces are kept, NOT trimmed — the viewport still shows the
 *   flat faces under the fillet. What is added per edge is a *closed,
 *   inward-wound shell* covering exactly the material a true fillet removes
 *   (the cross-section square-minus-quarter-disk sliver, swept along the
 *   edge). Consequences:
 *   • computeVolume decreases by the exact per-edge sliver volume
 *     ((1 − π/4)·r²·edgeLength per 90° edge) — the shells of edges meeting
 *     at a corner overlap, so a full-box fillet over-counts removal by
 *     8·r³·D with D ≈ 0.23 (≈5% at r=1 and ≈20% at r = half the narrow
 *     face; see the golden tests for the analytic corner formula). The
 *     exact path nails this union instead of over-counting it.
 *   • parity/raycast point-in-mesh tests (voxel fallback) now see the
 *     sliver regions as removed rather than gaining arbitrary
 *     double-crossings — the voxel result is blocky but corner-correct.
 * - The overlay body remains deliberately NON-manifold: each filleted spine
 *   edge carries 4 faces (the two kept originals + the two shell walls), so
 *   checkManifold/isBodyManifoldCompatible report it and the boolean
 *   guardrails in boolean.ts surface every post-fillet voxel fallback
 *   instead of silently eating the 15–19 s voxel cliff. The exact path
 *   removes this wart entirely.
 * - Convex edges only (both paths): a concave (reflex) edge would need
 *   material ADDed outside the body; the exact path refuses it (overlay
 *   fallback) and the overlay applies its convex-symmetric sliver.
 *
 * `edgeIds` semantics: an empty list means EVERY edge (whole-body fillet);
 * ids that do not exist match nothing. Edges with fewer than two adjacent
 * faces or a degenerate tangent (same skips as maxFilletRadius) pass through
 * untouched.
 */
export function applyFillet(body: SolidBody, edgeIds: string[], radius: number): SolidBody {
  if (radius <= 0) return body;
  const exact = filletManifold(body, edgeIds, radius);
  if (exact) return exact;
  const edgeSet = new Set(edgeIds.length > 0 ? edgeIds : body.edges.map((e) => e.id));
  const ARC_SEGMENTS = 8; // arc facets per fillet — 11.25° steps over a 90° corner

  const newFaces: Face[] = [...body.faces]; // keep original faces (overlay)
  const newEdges: Edge[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    // Find faces sharing this edge.
    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) { newEdges.push(edge); continue; }

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) { newEdges.push(edge); continue; }

    const edgeDir = normalize({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    const n1 = normalize(face1.normal);
    const n2 = normalize(face2.normal);

    // Coplanar adjacent faces (same-direction normals): a flat seam, not a
    // corner. Empirically this fires on VOXEL-UNION flat seams (thousands per
    // merged body) — the overlay wall quads are antiparallel (dot ≈ −1) and
    // are caught by the bisLen check below instead. Filleting a flat seam is
    // meaningless either way; skipped identically in edgeFeatureLimit.
    if (n1.x * n2.x + n1.y * n2.y + n1.z * n2.z > 1 - 1e-6) { newEdges.push(edge); continue; }

    // Degenerate tangency — skip exactly like edgeFeatureLimit/maxFilletRadius.
    if (vecLen(cross(n1, edgeDir)) < 1e-9) { newEdges.push(edge); continue; }

    // Outward bisector m (from the arc center back toward the edge). The
    // center lies at −m·centerOffset, i.e. INSIDE the material.
    const bisSum = { x: n1.x + n2.x, y: n1.y + n2.y, z: n1.z + n2.z };
    const bisLen = vecLen(bisSum);
    if (bisLen < 1e-9) { newEdges.push(edge); continue; } // faces fold back flat-to-flat
    const m = { x: bisSum.x / bisLen, y: bisSum.y / bisLen, z: bisSum.z / bisLen };

    const dotNN = Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y + n1.z * n2.z));
    const halfAngle = Math.acos(dotNN) / 2;
    const cosHalf = Math.cos(halfAngle);
    if (cosHalf < 1e-6) { newEdges.push(edge); continue; } // knife-edge dihedral
    const centerOffset = radius / cosHalf;

    // Second in-plane axis of the arc: w = edgeDir × m (unit, ⟂ m).
    const w = normalize(cross(edgeDir, m));

    // Radial direction of the arc at angle α (from the center toward the edge).
    const radial = (a: number): Vec3 => ({
      x: m.x * Math.cos(a) + w.x * Math.sin(a),
      y: m.y * Math.cos(a) + w.y * Math.sin(a),
      z: m.z * Math.cos(a) + w.z * Math.sin(a),
    });
    // Point on the arc at angle α, swept over an edge endpoint.
    const arcPoint = (a: number, base: Vec3): Vec3 => ({
      x: base.x + m.x * (radius * Math.cos(a) - centerOffset) + w.x * radius * Math.sin(a),
      y: base.y + m.y * (radius * Math.cos(a) - centerOffset) + w.y * radius * Math.sin(a),
      z: base.z + m.z * (radius * Math.cos(a) - centerOffset) + w.z * radius * Math.sin(a),
    });

    // Sample the arc from face to face at both edge endpoints.
    const startLine: Vec3[] = [];
    const endLine: Vec3[] = [];
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const a = -halfAngle + (2 * halfAngle * i) / ARC_SEGMENTS;
      startLine.push(arcPoint(a, edge.start));
      endLine.push(arcPoint(a, edge.end));
    }

    // Arc facets. Desired normal: radial at the facet midpoint (toward the
    // edge = outward from the remaining material, like a true fillet face).
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      const aMid = -halfAngle + (2 * halfAngle * (i + 0.5)) / ARC_SEGMENTS;
      pushShellFace(newFaces, [startLine[i]!, startLine[i + 1]!, endLine[i + 1]!, endLine[i]!], radial(aMid));
    }

    // Wall quads from the edge to each tangent line. The tangent line at
    // angle a lies on one adjacent face's plane; that face's normal has
    // dot 1 with radial(a) (the other only dot(n1,n2)).
    const faceNormalAtEnd = (a: number): Vec3 => {
      const r = radial(a);
      return dot(n1, r) >= dot(n2, r) ? n1 : n2;
    };
    pushShellFace(newFaces, [edge.start, edge.end, endLine[0]!, startLine[0]!], neg(faceNormalAtEnd(-halfAngle)));
    pushShellFace(newFaces, [edge.start, edge.end, endLine[ARC_SEGMENTS]!, startLine[ARC_SEGMENTS]!], neg(faceNormalAtEnd(halfAngle)));

    // End caps: triangle fans from each edge endpoint across the arc
    // polyline, closing the shell (every shared edge keeps exactly two faces).
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      pushShellFace(newFaces, [edge.start, startLine[i]!, startLine[i + 1]!], edgeDir);
      pushShellFace(newFaces, [edge.end, endLine[i]!, endLine[i + 1]!], neg(edgeDir));
    }

    // Edges: keep the original edge (the walls still meet along it), plus
    // the two tangent lines and the cap outline polylines.
    newEdges.push(edge);
    newEdges.push(
      { id: genId('edge'), start: startLine[0]!, end: endLine[0]! },
      { id: genId('edge'), start: startLine[ARC_SEGMENTS]!, end: endLine[ARC_SEGMENTS]! },
    );
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      newEdges.push({ id: genId('edge'), start: startLine[i]!, end: startLine[i + 1]! });
      newEdges.push({ id: genId('edge'), start: endLine[i]!, end: endLine[i + 1]! });
    }
  }

  const newVertices = dedupVertices(newFaces);
  return { id: body.id, name: body.name, vertices: newVertices, faces: newFaces, edges: newEdges };
}

/**
 * Chamfer: bevel convex edges with an equal-leg `distance` cut.
 *
 * EXACT PATH (engine warm, manifold-convertible body, only convex selected
 * edges): body − ⋃(per-edge wedge cutters) via the Manifold engine (see
 * chamferManifold). Each wedge is the intersection of half-spaces that carves
 * exactly the equal-leg chamfer region, and the cutters' union is EXACTLY the
 * true chamfer removal — including at corners where chamfered edges meet (the
 * overlay over-counts those by 8·D_w·d³).
 *
 * OVERLAY FALLBACK (engine cold / non-manifold body / the exact op fails):
 * the pass-30 stopgap — bevel convex edges by overlaying a closed
 * subtractive wedge shell per edge.
 *
 * Geometry: on each adjacent face, the chamfer leg runs in-plane, `distance`
 * away from the edge (directions u1/u2 point from the edge INTO each face,
 * found via cross(edgeDir, normal) oriented toward the face's vertices). The
 * chamfer face is the plane through both leg lines — the diamond's outer
 * corner sits exactly `distance` from the edge along each face, at 45° to
 * both faces on a 90° corner. The previous implementation offset the quad
 * corners by −normal·distance, burying the whole face INSIDE the solid.
 *
 * Overlay semantics (same deliberate stopgap as applyFillet): the original
 * faces are kept, and each chamfer is emitted as a closed, inward-wound
 * shell (chamfer quad + two wall quads lying on the adjacent faces + two
 * triangular caps) covering exactly the wedge a true chamfer removes
 * (cross-section right triangle d×d, i.e. d²/2 per unit of edge length).
 * computeVolume therefore decreases by exactly d²·edgeLength/2 per 90° edge;
 * wedges of edges meeting at a corner overlap, over-counting removal by
 * 8·d³·D_w with D_w ≈ 0.75 (≈5% at d=1, ≈25% at d = half the narrow face;
 * see the golden tests). Like applyFillet the overlay body stays
 * non-manifold (each chamfered spine edge carries 4 faces) so boolean
 * guardrails fire. Convex edges only, same as applyFillet.
 */
export function applyChamfer(body: SolidBody, edgeIds: string[], distance: number): SolidBody {
  if (distance <= 0) return body;
  const exact = chamferManifold(body, edgeIds, distance);
  if (exact) return exact;
  // Empty selection means every edge (see applyFillet).
  const edgeSet = new Set(edgeIds.length > 0 ? edgeIds : body.edges.map((e) => e.id));

  const newFaces: Face[] = [...body.faces]; // keep original faces (overlay)
  const newEdges: Edge[] = [];

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) {
      newEdges.push(edge);
      continue;
    }

    // Find the two adjacent faces.
    const adjacentFaces = body.faces.filter((f) => faceContainsEdge(f, edge));
    if (adjacentFaces.length < 2) { newEdges.push(edge); continue; }

    const [face1, face2] = adjacentFaces;
    if (!face1 || !face2) { newEdges.push(edge); continue; }

    const edgeDir = normalize({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
    const n1 = normalize(face1.normal);
    const n2 = normalize(face2.normal);

    // Coplanar adjacent faces: flat seam, not a corner (see applyFillet).
    if (n1.x * n2.x + n1.y * n2.y + n1.z * n2.z > 1 - 1e-6) { newEdges.push(edge); continue; }

    // In-plane unit direction on each face pointing AWAY from the edge (into
    // the face), oriented by the face's own vertices.
    const inPlaneAway = (face: Face, n: Vec3): Vec3 | null => {
      const t = cross(edgeDir, n);
      const len = vecLen(t);
      if (len < 1e-9) return null; // edge parallel to the face normal — degenerate
      const cand = { x: t.x / len, y: t.y / len, z: t.z / len };
      let side = 0;
      for (const v of face.vertices) {
        side += (v.x - edge.start.x) * cand.x + (v.y - edge.start.y) * cand.y + (v.z - edge.start.z) * cand.z;
      }
      return side >= 0 ? cand : neg(cand);
    };
    const u1 = inPlaneAway(face1, n1);
    const u2 = inPlaneAway(face2, n2);
    if (!u1 || !u2) { newEdges.push(edge); continue; }

    // Chamfer leg lines: distance d in-plane along each face.
    const p1s = addScaled(edge.start, u1, distance);
    const p1e = addScaled(edge.end, u1, distance);
    const p2s = addScaled(edge.start, u2, distance);
    const p2e = addScaled(edge.end, u2, distance);

    // Chamfer face (desired normal toward the corner = outward from the
    // remaining material, 45° to both faces on a 90° edge).
    const bisOut = normalize({ x: u1.x + u2.x, y: u1.y + u2.y, z: u1.z + u2.z });
    pushShellFace(newFaces, [p1s, p2s, p2e, p1e], neg(bisOut));

    // Walls on the adjacent faces + end caps: the closed wedge shell.
    pushShellFace(newFaces, [edge.start, edge.end, p1e, p1s], neg(n1));
    pushShellFace(newFaces, [edge.start, edge.end, p2e, p2s], neg(n2));
    pushShellFace(newFaces, [edge.start, p1s, p2s], edgeDir);
    pushShellFace(newFaces, [edge.end, p1e, p2e], neg(edgeDir));

    newEdges.push(edge);
    newEdges.push(
      { id: genId('edge'), start: p1s, end: p1e },
      { id: genId('edge'), start: p2s, end: p2e },
    );
  }

  const newVertices = dedupVertices(newFaces);
  return { id: body.id, name: body.name, vertices: newVertices, faces: newFaces, edges: newEdges };
}

/** Result of a fillet/chamfer size-limit query (maxFilletRadius / maxChamferDistance). */
export interface EdgeFeatureLimit {
  /**
   * Largest radius/distance (mm) that keeps every fillet arc / chamfer face
   * inside the selected edges' adjacent faces' extents — the min over every
   * applicable edge. Null when EVERY selected edge would be skipped by
   * applyFillet/applyChamfer (nothing can be applied at any size).
   */
  max: number | null;
  /** Selected edges that applyFillet/applyChamfer silently skip (fewer than
   * two adjacent faces, or a degenerate fillet tangent). They contribute no
   * limit but are surfaced here instead of vanishing. */
  skippedEdges: number;
}

/**
 * Largest fillet radius that keeps every fillet arc inside the adjacent faces'
 * extents, derived from how applyFillet builds its geometry.
 *
 * The arc cross-section is tangent to both faces: its tangent lines land
 * in-plane at radius·cot(halfAngle) from the edge (exactly `radius` on a 90°
 * corner), and the arc bulges no farther. Constraining radius to half the
 * face's in-plane depth from the edge therefore guarantees the arc stays
 * inside the face on 90° corners (the box/extrude/voxel bodies this app
 * builds) while leaving the far half of the face for opposite-edge
 * treatments.
 *
 * Caveat (unchanged bound, documented): on shallow dihedrals — e.g. a
 * cylinder's side-seam edges, where halfAngle ≈ 5.6° — cot(halfAngle) ≈ 10,
 * so the tangent lines reach ~10×radius in-plane and can overshoot the
 * face's extent even below this bound. Tightening per-dihedral would change
 * the pass-28 limits (e.g. the cylinder seam bound); deferred.
 *
 * `edgeIds` follows applyFillet semantics: an empty list means EVERY edge;
 * ids that do not exist on the body match nothing (and are ignored), exactly
 * like the applier. Pure function — no mutation.
 */
export function maxFilletRadius(body: SolidBody, edgeIds: string[]): EdgeFeatureLimit {
  return edgeFeatureLimit(body, edgeIds, 'fillet');
}

/**
 * Largest chamfer distance that keeps the chamfer face inside the adjacent
 * faces' extents, derived from how applyChamfer builds its geometry.
 *
 * applyChamfer runs each chamfer leg in-plane, exactly `distance` away from
 * the edge along each adjacent face (u1/u2 directions), so every generated
 * point departs at most `distance` from the edge — the true chamfer leg.
 * Capping `distance` at half of each adjacent face's in-plane depth from the
 * edge keeps the chamfer inside the near half of the face — it can never
 * reach past the face's medial line or poke out of the opposite side.
 *
 * Same `edgeIds` semantics as applyChamfer (empty = every edge). Pure.
 */
export function maxChamferDistance(body: SolidBody, edgeIds: string[]): EdgeFeatureLimit {
  return edgeFeatureLimit(body, edgeIds, 'chamfer');
}

function edgeFeatureLimit(
  body: SolidBody,
  edgeIds: string[],
  kind: 'fillet' | 'chamfer',
): EdgeFeatureLimit {
  const edgeSet = new Set(edgeIds.length > 0 ? edgeIds : body.edges.map((e) => e.id));
  let max: number | null = null;
  let skipped = 0;

  for (const edge of body.edges) {
    if (!edgeSet.has(edge.id)) continue;

    // Mirror applyFillet/applyChamfer's skip conditions exactly: fewer than
    // two adjacent faces, and (fillet only) a degenerate in-plane tangent.
    const adjacent = body.faces.filter((f) => faceContainsEdge(f, edge));
    const [face1, face2] = adjacent;
    if (adjacent.length < 2 || !face1 || !face2) { skipped++; continue; }

    // Coplanar adjacent faces: flat seam, not a corner — skipped by the
    // appliers, so skipped here too (the closed-shell overlays create these
    // on the original faces).
    {
      const a = normalize(face1.normal);
      const b = normalize(face2.normal);
      if (a.x * b.x + a.y * b.y + a.z * b.z > 1 - 1e-6) { skipped++; continue; }
    }

    if (kind === 'fillet') {
      const edgeDir = normalize({ x: edge.end.x - edge.start.x, y: edge.end.y - edge.start.y, z: edge.end.z - edge.start.z });
      const tangent = cross(normalize(face1.normal), edgeDir);
      if (vecLen(tangent) < 1e-9) { skipped++; continue; }
    }

    const bound = Math.min(
      faceDepthFromEdge(face1, edge),
      faceDepthFromEdge(face2, edge),
    ) / 2;
    max = max === null ? bound : Math.min(max, bound);
  }

  return { max, skippedEdges: skipped };
}

/**
 * How deep a face extends from an edge lying on its boundary, measured
 * in-plane: the largest perpendicular distance from the edge's line to any of
 * the face's vertices. For the planar faces the appliers build, this is the
 * width of face material available on the far side of the edge.
 */
function faceDepthFromEdge(face: Face, edge: Edge): number {
  const dx = edge.end.x - edge.start.x;
  const dy = edge.end.y - edge.start.y;
  const dz = edge.end.z - edge.start.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-10) return 0;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  let depth = 0;
  for (const v of face.vertices) {
    const rx = v.x - edge.start.x;
    const ry = v.y - edge.start.y;
    const rz = v.z - edge.start.z;
    const along = rx * ux + ry * uy + rz * uz;
    const px = rx - ux * along, py = ry - uy * along, pz = rz - uz * along;
    depth = Math.max(depth, Math.sqrt(px * px + py * py + pz * pz));
  }
  return depth;
}

/**
 * Shell: hollow out a body, optionally removing (opening) selected faces.
 *
 * EXACT PATH (engine warm, manifold-convertible body): body − eroded-body,
 * the audit's spec for a real shell. The erosion inward by `thickness` is
 * EXACT for convex bodies (intersection of the inward-shifted face
 * half-spaces) and voxel-approximated for the rest (booleanVoxel's
 * Euclidean-distance erosion of the occupancy grid, meshed and subtracted
 * through Manifold: outer surfaces exact, inner cavity walls quantized to
 * the grid, wall thickness within ±1 cell). Selected faces are opened by
 * subtracting the prism of each face's own footprint extruded inward past
 * the inner wall. The result is a watertight thin-wall solid — a SHELL, not
 * the pocket below. Synchronous and instantaneous on the convex path; the
 * voxel path costs one occupancy pass (~the same as hollowBody).
 *
 * POCKET FALLBACK (engine cold / non-convertible body / exact op fails):
 * the pass-30 placeholder — selected faces are dropped and replaced by
 * faces offset inward by `thickness`, with side faces stitched around them.
 * This is NOT a hollow shell: the body stays solid everywhere else (a
 * surface pocket), which is why the audit scheduled this rework.
 */
export function applyShell(body: SolidBody, faceIds: string[], thickness: number): SolidBody {
  if (thickness <= 0) return body;
  const faceSet = new Set(faceIds);

  const exact = shellManifold(
    body,
    faceIds,
    thickness,
    // Non-convex interiors: the voxel EDT erosion, as its own mesh body.
    () => erodedInteriorVoxel(body, thickness, SHELL_VOXEL_RESOLUTION),
    // The blocky inner wall can sit up to a cell outside the nominal depth —
    // open 2 cells past it so the prism always breaks through.
    thickness + 2 * shellVoxelCellSize(body),
  );
  if (exact) return exact;

  const newFaces: Face[] = [];
  const shellFaces: Face[] = [];

  for (const face of body.faces) {
    if (faceSet.has(face.id)) {
      // Create offset (inner) face
      const innerVerts = face.vertices.map((v) => ({
        x: v.x - face.normal.x * thickness,
        y: v.y - face.normal.y * thickness,
        z: v.z - face.normal.z * thickness,
      }));

      shellFaces.push({
        id: genId('face'),
        vertices: innerVerts,
        normal: { x: -face.normal.x, y: -face.normal.y, z: -face.normal.z },
      });
    } else {
      newFaces.push(face);
    }
  }

  // Create side faces connecting outer edges to inner edges
  for (const removedFace of body.faces.filter((f) => faceSet.has(f.id))) {
    for (let i = 0; i < removedFace.vertices.length; i++) {
      const next = (i + 1) % removedFace.vertices.length;
      const outer1 = removedFace.vertices[i]!;
      const outer2 = removedFace.vertices[next]!;
      const inner1: Vec3 = {
        x: outer1.x - removedFace.normal.x * thickness,
        y: outer1.y - removedFace.normal.y * thickness,
        z: outer1.z - removedFace.normal.z * thickness,
      };
      const inner2: Vec3 = {
        x: outer2.x - removedFace.normal.x * thickness,
        y: outer2.y - removedFace.normal.y * thickness,
        z: outer2.z - removedFace.normal.z * thickness,
      };

      const sideNormal = computeFaceNormal(outer1, outer2, inner2);
      shellFaces.push({
        id: genId('face'),
        vertices: [outer1, outer2, inner2, inner1],
        normal: sideNormal,
      });
    }
  }

  newFaces.push(...shellFaces);

  const newVertices = dedupVertices(newFaces);

  return {
    id: body.id,
    name: body.name,
    vertices: newVertices,
    faces: newFaces,
    edges: body.edges,
  };
}

/** Linear array: duplicate body along a direction */
export function applyLinearArray(
  body: SolidBody,
  direction: Vec3,
  count: number,
  spacing: number,
): SolidBody[] {
  if (count <= 0) throw new Error('Array count must be positive');
  if (spacing <= 0) throw new Error('Array spacing must be positive');
  // Normalize the direction so `spacing` is honored as a true mm gap regardless
  // of the direction vector's magnitude.
  const dirLen = Math.hypot(direction.x, direction.y, direction.z);
  if (dirLen < 1e-12) throw new Error('Array direction cannot be zero');
  const dir = { x: direction.x / dirLen, y: direction.y / dirLen, z: direction.z / dirLen };
  const results: SolidBody[] = [];
  for (let i = 0; i < count; i++) {
    const offset = {
      x: dir.x * spacing * i,
      y: dir.y * spacing * i,
      z: dir.z * spacing * i,
    };
    results.push(translateBody(body, offset, `${body.name} [${i}]`));
  }
  return results;
}

/**
 * Grid (2-direction linear) pattern, like SolidWorks' linear pattern with a
 * second direction. Produces count1 × count2 copies offset along the two
 * (normalized) directions; spacings are true mm gaps. The (0,0) copy is the
 * original position.
 */
export function applyGridArray(
  body: SolidBody,
  dir1: Vec3,
  count1: number,
  spacing1: number,
  dir2: Vec3,
  count2: number,
  spacing2: number,
): SolidBody[] {
  if (count1 <= 0 || count2 <= 0) throw new Error('Array counts must be positive');
  if (spacing1 <= 0 || spacing2 <= 0) throw new Error('Array spacings must be positive');
  const n = (d: Vec3): Vec3 => {
    const l = Math.hypot(d.x, d.y, d.z);
    if (l < 1e-12) throw new Error('Array direction cannot be zero');
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const u = n(dir1);
  const v = n(dir2);
  const results: SolidBody[] = [];
  for (let i = 0; i < count1; i++) {
    for (let j = 0; j < count2; j++) {
      const offset = {
        x: u.x * spacing1 * i + v.x * spacing2 * j,
        y: u.y * spacing1 * i + v.y * spacing2 * j,
        z: u.z * spacing1 * i + v.z * spacing2 * j,
      };
      results.push(translateBody(body, offset, `${body.name} [${i},${j}]`));
    }
  }
  return results;
}

/** Circular array: duplicate body around an axis */
export function applyCircularArray(
  body: SolidBody,
  axis: { origin: Vec3; direction: Vec3 },
  count: number,
): SolidBody[] {
  if (count <= 0) throw new Error('Array count must be positive');
  const results: SolidBody[] = [];
  const angleStep = (Math.PI * 2) / count;

  for (let i = 0; i < count; i++) {
    const angle = angleStep * i;
    results.push(rotateBody(body, axis, angle, `${body.name} [${i}]`));
  }
  return results;
}

/**
 * Combine several bodies into one mesh by concatenation (fresh face/edge ids).
 * For disjoint bodies this is a valid union; overlapping bodies are simply
 * merged as-is (no boolean). Useful to export an array/pattern as a single mesh.
 */
export function mergeBodies(bodies: SolidBody[], name = 'Merged'): SolidBody {
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  for (const b of bodies) {
    vertices.push(...b.vertices);
    for (const f of b.faces) {
      faces.push({ id: genId('face'), vertices: f.vertices, normal: f.normal });
    }
    for (const e of b.edges) {
      edges.push({ id: genId('edge'), start: e.start, end: e.end });
    }
  }
  return { id: genId('body'), name, vertices, faces, edges };
}

/**
 * Uniformly scale a body so its extent along `axis` equals `target` mm,
 * scaled about its bounding-box center (preserves aspect ratio).
 */
export function scaleBodyToTarget(body: SolidBody, axis: 'x' | 'y' | 'z', target: number): SolidBody {
  if (!Number.isFinite(target) || target <= 0) throw new Error('Target size must be positive');
  let min = Infinity;
  let max = -Infinity;
  for (const v of body.vertices) {
    min = Math.min(min, v[axis]);
    max = Math.max(max, v[axis]);
  }
  const extent = max - min;
  if (!(extent > 1e-9)) throw new Error('Body has zero extent along the axis');
  const bb = computeBoundingBoxLocal(body);
  return scaleBody(body, target / extent, {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  });
}

function computeBoundingBoxLocal(body: SolidBody): { min: Vec3; max: Vec3 } {
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

/**
 * Scale a single world axis so the body's extent along it equals `target` mm,
 * keeping the other two axes (and the bounding-box center) fixed — a
 * dimension-driven resize that leaves every other drawing dimension unchanged.
 */
export function resizeBodyAxis(body: SolidBody, axis: 'x' | 'y' | 'z', target: number): SolidBody {
  if (!Number.isFinite(target) || target <= 0) throw new Error('Target size must be positive');
  const bb = computeBoundingBoxLocal(body);
  const extent = bb.max[axis] - bb.min[axis];
  if (!(extent > 1e-9)) throw new Error('Body has zero extent along the axis');
  const f = { x: 1, y: 1, z: 1 };
  f[axis] = target / extent;
  return scaleBodyXYZ(
    body,
    f.x,
    f.y,
    f.z,
    {
      x: (bb.min.x + bb.max.x) / 2,
      y: (bb.min.y + bb.max.y) / 2,
      z: (bb.min.z + bb.max.z) / 2,
    },
  );
}

/**
 * Resize a body to exact per-axis dimensions (mm), scaling each axis
 * independently about the bounding-box center. Unlike uniform scaleBody this
 * changes the aspect ratio, so normals are transformed by the inverse-transpose
 * of the (diagonal) scale — n → (nx/sx, ny/sy, nz/sz) normalized — to stay
 * perpendicular to the deformed faces.
 */
export function resizeBody(body: SolidBody, target: Vec3): SolidBody {
  if (![target.x, target.y, target.z].every((d) => Number.isFinite(d) && d > 0)) {
    throw new Error('Target dimensions must be positive');
  }
  const bb = computeBoundingBoxLocal(body);
  const ext = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  // A zero-extent axis (flat part) can't be resized along that axis; keep it.
  const sx = ext.x > 1e-9 ? target.x / ext.x : 1;
  const sy = ext.y > 1e-9 ? target.y / ext.y : 1;
  const sz = ext.z > 1e-9 ? target.z / ext.z : 1;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;

  const p = (v: Vec3): Vec3 => ({
    x: cx + (v.x - cx) * sx,
    y: cy + (v.y - cy) * sy,
    z: cz + (v.z - cz) * sz,
  });
  const transformNormal = (n: Vec3): Vec3 => normalize({ x: n.x / sx, y: n.y / sy, z: n.z / sz });

  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(p),
    faces: body.faces.map((f) => ({ id: genId('face'), vertices: f.vertices.map(p), normal: transformNormal(f.normal) })),
    edges: body.edges.map((e) => ({ id: genId('edge'), start: p(e.start), end: p(e.end) })),
  };
}

/** Uniform scale of a body about an origin point (default world origin). */
export function scaleBody(body: SolidBody, factor: number, origin: Vec3 = { x: 0, y: 0, z: 0 }): SolidBody {
  if (factor <= 0) throw new Error('Scale factor must be positive');
  const s = (v: Vec3): Vec3 => ({
    x: origin.x + (v.x - origin.x) * factor,
    y: origin.y + (v.y - origin.y) * factor,
    z: origin.z + (v.z - origin.z) * factor,
  });
  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(s),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(s),
      // Uniform scaling preserves normal directions.
      normal: { ...f.normal },
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: s(e.start),
      end: s(e.end),
    })),
  };
}

/** Non-uniform scale: per-axis factors about an origin. Normals are re-normalized. */
export function scaleBodyXYZ(body: SolidBody, fx: number, fy: number, fz: number, origin: Vec3 = { x: 0, y: 0, z: 0 }): SolidBody {
  if (fx <= 0 || fy <= 0 || fz <= 0) throw new Error('Scale factors must be positive');
  const s = (v: Vec3): Vec3 => ({
    x: origin.x + (v.x - origin.x) * fx,
    y: origin.y + (v.y - origin.y) * fy,
    z: origin.z + (v.z - origin.z) * fz,
  });
  // Normal transform: inverse-transpose of the diagonal scale matrix = diag(1/fx, 1/fy, 1/fz), normalized.
  const n = (v: Vec3): Vec3 => {
    const nx = v.x / fx, ny = v.y / fy, nz = v.z / fz;
    const len = Math.hypot(nx, ny, nz);
    return len > 1e-12 ? { x: nx / len, y: ny / len, z: nz / len } : { ...v };
  };
  return {
    id: genId('body'),
    name: body.name,
    vertices: body.vertices.map(s),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(s),
      normal: n(f.normal),
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: s(e.start),
      end: s(e.end),
    })),
  };
}

/** Mirror: reflect body across a plane */
export function applyMirror(
  body: SolidBody,
  plane: { origin: Vec3; normal: Vec3 },
): SolidBody {
  const n = normalize(plane.normal);
  const d = -(n.x * plane.origin.x + n.y * plane.origin.y + n.z * plane.origin.z);

  const mirrorVert = (v: Vec3): Vec3 => {
    const dist = 2 * (n.x * v.x + n.y * v.y + n.z * v.z + d);
    return {
      x: v.x - n.x * dist,
      y: v.y - n.y * dist,
      z: v.z - n.z * dist,
    };
  };

  // A reflection is orientation-reversing: it flips each face's winding. To
  // keep the mirrored solid right-side-out, reverse each face's vertex order
  // (restoring CCW-outward winding) and reflect the normal *across the plane*
  // (linear part of the reflection) — not merely negate it, which is only
  // correct when the plane normal happens to align with the face normal.
  const reflectDir = (v: Vec3): Vec3 => {
    const k = 2 * (n.x * v.x + n.y * v.y + n.z * v.z);
    return { x: v.x - n.x * k, y: v.y - n.y * k, z: v.z - n.z * k };
  };

  const newVertices = body.vertices.map(mirrorVert);
  const newFaces = body.faces.map((f) => ({
    id: genId('face'),
    vertices: f.vertices.map(mirrorVert).reverse(),
    normal: reflectDir(f.normal),
  }));
  const newEdges = body.edges.map((e) => ({
    id: genId('edge'),
    start: mirrorVert(e.start),
    end: mirrorVert(e.end),
  }));

  return {
    id: genId('body'),
    name: `${body.name} (mirror)`,
    vertices: newVertices,
    faces: newFaces,
    edges: newEdges,
  };
}

/**
 * Flip every face's orientation (reverse winding + negate normal) in place,
 * turning a body inside-out — the fix for an imported mesh that renders
 * inverted. Keeps id/name/vertices/edges so it's an in-place edit.
 */
export function flipBodyNormals(body: SolidBody): SolidBody {
  return {
    ...body,
    faces: body.faces.map((f) => ({
      ...f,
      vertices: [...f.vertices].reverse(),
      normal: { x: -f.normal.x, y: -f.normal.y, z: -f.normal.z },
    })),
  };
}

/**
 * Place a body into a coordinate system's frame: the body's current coordinates
 * are taken as local (CSYS-frame) coordinates and mapped to world space — the
 * rigid transform SolidWorks applies when inserting a part at a coordinate
 * system. The frame is orthonormal, so this is a pure rotation + translation:
 * lengths, volume and winding are preserved. Normals rotate with the frame (no
 * translation).
 */
export function placeBodyInFrame(body: SolidBody, cs: CoordinateSystemDefinition): SolidBody {
  const mapV = (v: Vec3): Vec3 => localToWorld(cs, v);
  // Rotate a direction by the frame basis only (no origin offset).
  const rotD = (d: Vec3): Vec3 => ({
    x: cs.xAxis.x * d.x + cs.yAxis.x * d.y + cs.zAxis.x * d.z,
    y: cs.xAxis.y * d.x + cs.yAxis.y * d.y + cs.zAxis.y * d.z,
    z: cs.xAxis.z * d.x + cs.yAxis.z * d.y + cs.zAxis.z * d.z,
  });
  return {
    id: genId('body'),
    name: `${body.name} (placed)`,
    vertices: body.vertices.map(mapV),
    faces: body.faces.map((f) => ({ id: genId('face'), vertices: f.vertices.map(mapV), normal: rotD(f.normal) })),
    edges: body.edges.map((e) => ({ id: genId('edge'), start: mapV(e.start), end: mapV(e.end) })),
  };
}

// --- Helpers ---

/**
 * Append a shell face wound so its stored normal matches `desired` — the
 * winding is flipped if the natural vertex order opposes it, which makes the
 * divergence-theorem volume of a closed shell exact regardless of which
 * order the caller listed its vertices in.
 */
function pushShellFace(out: Face[], verts: Vec3[], desired: Vec3): void {
  const a = verts[0]!;
  const e1 = { x: verts[1]!.x - a.x, y: verts[1]!.y - a.y, z: verts[1]!.z - a.z };
  // Use the last vertex (adjacent to the first in a ring) for planar quads;
  // falls back to the third for triangles where they coincide.
  const b = verts[verts.length - 1]!;
  const e2 = verts.length >= 4
    ? { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    : { x: verts[2]!.x - a.x, y: verts[2]!.y - a.y, z: verts[2]!.z - a.z };
  const wn = cross(e1, e2);
  const ordered = wn.x * desired.x + wn.y * desired.y + wn.z * desired.z >= 0 ? verts : [...verts].reverse();
  out.push({ id: genId('face'), vertices: ordered, normal: normalize(desired) });
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function neg(v: Vec3): Vec3 {
  return { x: -v.x, y: -v.y, z: -v.z };
}

function addScaled(v: Vec3, dir: Vec3, s: number): Vec3 {
  return { x: v.x + dir.x * s, y: v.y + dir.y * s, z: v.z + dir.z * s };
}

/**
 * Replace a body with its 3D convex hull — the tightest convex solid that
 * encloses all its vertices. Useful for collision proxies, clamp/grip shapes
 * and simplifying messy or concave imported meshes. Returns the original body
 * unchanged if the points are degenerate (coplanar / too few for a hull).
 */
export function convexHullBody(body: SolidBody, name: string = `${body.name} (hull)`): SolidBody {
  const hull = computeConvexHull(body.vertices);
  if (!hull) return body;
  const vertices = hull.vertices.map((v) => ({ ...v }));
  const faces: Face[] = hull.faces.map(([a, b, c]) => {
    const va = vertices[a]!;
    const vb = vertices[b]!;
    const vc = vertices[c]!;
    const n = normalize({
      x: (vb.y - va.y) * (vc.z - va.z) - (vb.z - va.z) * (vc.y - va.y),
      y: (vb.z - va.z) * (vc.x - va.x) - (vb.x - va.x) * (vc.z - va.z),
      z: (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x),
    });
    return { id: genId('face'), vertices: [va, vb, vc], normal: n };
  });
  const edges: Edge[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      edges.push({ id: genId('edge'), start: f.vertices[i]!, end: f.vertices[(i + 1) % f.vertices.length]! });
    }
  }
  return { id: genId('body'), name, vertices, faces, edges };
}

/**
 * Center a body so its bounding-box center sits at the origin. Useful for
 * normalizing imported meshes (STL/OBJ often arrive far from the origin), which
 * makes orbiting and center-based transforms behave intuitively.
 */
export function centerBody(body: SolidBody): SolidBody {
  if (body.vertices.length === 0) return body;
  const bb = computeBoundingBoxLocal(body);
  const offset: Vec3 = {
    x: -(bb.min.x + bb.max.x) / 2,
    y: -(bb.min.y + bb.max.y) / 2,
    z: -(bb.min.z + bb.max.z) / 2,
  };
  if (Math.abs(offset.x) < 1e-9 && Math.abs(offset.y) < 1e-9 && Math.abs(offset.z) < 1e-9) return body;
  return translateBody(body, offset);
}

/** Translate a body by an offset vector. */
export function translateBody(body: SolidBody, offset: Vec3, name: string = body.name): SolidBody {
  const translate = (v: Vec3): Vec3 => ({
    x: v.x + offset.x,
    y: v.y + offset.y,
    z: v.z + offset.z,
  });

  return {
    id: genId('body'),
    name,
    vertices: body.vertices.map(translate),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(translate),
      normal: { ...f.normal },
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: translate(e.start),
      end: translate(e.end),
    })),
  };
}

/** Rotate a body by `angle` radians about an arbitrary axis (Rodrigues). */
export function rotateBody(
  body: SolidBody,
  axis: { origin: Vec3; direction: Vec3 },
  angle: number,
  name: string = body.name,
): SolidBody {
  const dir = normalize(axis.direction);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rotate a direction vector about the axis direction (no translation).
  const rotateDir = (p: Vec3): Vec3 => {
    const dot = dir.x * p.x + dir.y * p.y + dir.z * p.z;
    const cross = {
      x: dir.y * p.z - dir.z * p.y,
      y: dir.z * p.x - dir.x * p.z,
      z: dir.x * p.y - dir.y * p.x,
    };
    return {
      x: p.x * cos + cross.x * sin + dir.x * dot * (1 - cos),
      y: p.y * cos + cross.y * sin + dir.y * dot * (1 - cos),
      z: p.z * cos + cross.z * sin + dir.z * dot * (1 - cos),
    };
  };

  // Rotate a point: shift to the axis origin, rotate the offset, shift back.
  const rotate = (v: Vec3): Vec3 => {
    const r = rotateDir({ x: v.x - axis.origin.x, y: v.y - axis.origin.y, z: v.z - axis.origin.z });
    return { x: axis.origin.x + r.x, y: axis.origin.y + r.y, z: axis.origin.z + r.z };
  };

  return {
    id: genId('body'),
    name,
    vertices: body.vertices.map(rotate),
    faces: body.faces.map((f) => ({
      id: genId('face'),
      vertices: f.vertices.map(rotate),
      normal: rotateDir(f.normal),
    })),
    edges: body.edges.map((e) => ({
      id: genId('edge'),
      start: rotate(e.start),
      end: rotate(e.end),
    })),
  };
}

/**
 * Weld near-coincident vertices: snap to a tolerance grid and replace every
 * reference (in faces and edges) with a single representative. Collapses the
 * degenerate faces/edges that result, so an imported STL (per-triangle, float-
 * jittered vertices) becomes a shared-vertex, watertight-friendly mesh.
 */
export function weldVertices(body: SolidBody, tolerance = 1e-4): SolidBody {
  const inv = 1 / Math.max(tolerance, 1e-12);
  const key = (v: Vec3) => `${Math.round(v.x * inv)},${Math.round(v.y * inv)},${Math.round(v.z * inv)}`;
  const rep = new Map<string, Vec3>();
  const weld = (v: Vec3): Vec3 => {
    const k = key(v);
    let r = rep.get(k);
    if (!r) {
      r = v;
      rep.set(k, r);
    }
    return r;
  };

  const faces: Face[] = [];
  for (const f of body.faces) {
    const welded = f.vertices.map(weld);
    // Drop vertices equal to their predecessor (collapsed edges).
    const cleaned = welded.filter((v, i) => v !== welded[(i - 1 + welded.length) % welded.length]);
    if (cleaned.length >= 3) {
      faces.push({ id: f.id, vertices: cleaned, normal: f.normal });
    }
  }

  const edges: Edge[] = [];
  for (const e of body.edges) {
    const s = weld(e.start);
    const t = weld(e.end);
    if (s !== t) edges.push({ id: e.id, start: s, end: t });
  }

  return { id: body.id, name: body.name, vertices: Array.from(rep.values()), faces, edges };
}

/** Deduplicate vertices using spatial hashing (O(n) instead of O(n^2)) */
function dedupVertices(faces: Face[]): Vec3[] {
  const map = new Map<string, Vec3>();
  const precision = 6;
  for (const f of faces) {
    for (const v of f.vertices) {
      const key = `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
      if (!map.has(key)) map.set(key, v);
    }
  }
  return Array.from(map.values());
}

function faceContainsEdge(face: Face, edge: Edge): boolean {
  for (let i = 0; i < face.vertices.length; i++) {
    const next = (i + 1) % face.vertices.length;
    const v1 = face.vertices[i]!;
    const v2 = face.vertices[next]!;
    if (edgeMatchesPoints(edge, v1, v2)) return true;
  }
  return false;
}

function edgeMatchesPoints(edge: Edge, a: Vec3, b: Vec3): boolean {
  return (
    (vecEqual(edge.start, a) && vecEqual(edge.end, b)) ||
    (vecEqual(edge.start, b) && vecEqual(edge.end, a))
  );
}

function vecEqual(a: Vec3, b: Vec3): boolean {
  const eps = 1e-6;
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (l < 1e-10) return { x: 0, y: 1, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function vecLen(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function computeFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return normalize({
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  });
}

/**
 * Sweep: extrude a 2D profile along a 3D path. The profile is a loop of 2D
 * points (in the local XY plane) that gets oriented perpendicular to the path
 * tangent at each path sample. Returns a closed solid body.
 *
 * @param profile  2D profile points (closed loop, in XY plane, Z=0).
 * @param path     3D path points (at least 2).
 * @param twist    Total twist angle in radians (default 0).
 */
export function sweepBody(profile: { x: number; y: number }[], path: Vec3[], twist = 0): SolidBody {
  if (profile.length < 3 || path.length < 2) throw new Error('Profile needs ≥3 points, path needs ≥2 points');

  const faces: Face[] = [];
  const edges: Edge[] = [];
  const profileN = profile.length;
  const pathN = path.length;

  // Compute path tangents at each sample.
  const tangents: Vec3[] = [];
  for (let i = 0; i < pathN; i++) {
    let t: Vec3;
    if (i === 0) {
      t = normalize({ x: path[1]!.x - path[0]!.x, y: path[1]!.y - path[0]!.y, z: path[1]!.z - path[0]!.z });
    } else if (i === pathN - 1) {
      t = normalize({ x: path[i]!.x - path[i - 1]!.x, y: path[i]!.y - path[i - 1]!.y, z: path[i]!.z - path[i - 1]!.z });
    } else {
      t = normalize({ x: path[i + 1]!.x - path[i - 1]!.x, y: path[i + 1]!.y - path[i - 1]!.y, z: path[i + 1]!.z - path[i - 1]!.z });
    }
    tangents.push(t);
  }

  // Build a rotation frame (up, right) at each path point using a reference
  // vector that avoids gimbal lock.
  const ref = Math.abs(tangents[0]!.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const frames: { up: Vec3; right: Vec3 }[] = [];
  let prevUp = ref;
  for (let i = 0; i < pathN; i++) {
    const t = tangents[i]!;
    // Gram-Schmidt: project prevUp onto the plane perpendicular to t.
    const dot = prevUp.x * t.x + prevUp.y * t.y + prevUp.z * t.z;
    const up = normalize({ x: prevUp.x - dot * t.x, y: prevUp.y - dot * t.y, z: prevUp.z - dot * t.z });
    const right = cross(t, up);
    frames.push({ up, right });
    prevUp = up;
  }

  // Place the profile at each path point, oriented perpendicular to the tangent.
  const rings: Vec3[][] = [];
  for (let i = 0; i < pathN; i++) {
    const p = path[i]!;
    const { up, right } = frames[i]!;
    const angle = (twist * i) / (pathN - 1);
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const ring: Vec3[] = [];
    for (const pt of profile) {
      const lx = pt.x * cosA - pt.y * sinA;
      const ly = pt.x * sinA + pt.y * cosA;
      ring.push({
        x: p.x + right.x * lx + up.x * ly,
        y: p.y + right.y * lx + up.y * ly,
        z: p.z + right.z * lx + up.z * ly,
      });
    }
    rings.push(ring);
  }

  // Body centroid — used to orient every face normal outward.
  const center: Vec3 = { x: 0, y: 0, z: 0 };
  let vertCount = 0;
  for (const ring of rings) {
    for (const v of ring) {
      center.x += v.x;
      center.y += v.y;
      center.z += v.z;
      vertCount++;
    }
  }
  center.x /= vertCount;
  center.y /= vertCount;
  center.z /= vertCount;

  // Point `normal` outward and rewind `verts` to match it, so signed-volume
  // and raycast computations see a consistently wound solid.
  const orientFace = (verts: Vec3[], normal: Vec3): { verts: Vec3[]; normal: Vec3 } => {
    const sum = verts.reduce(
      (s, v) => ({ x: s.x + v.x, y: s.y + v.y, z: s.z + v.z }),
      { x: 0, y: 0, z: 0 },
    );
    const fc = {
      x: sum.x / verts.length - center.x,
      y: sum.y / verts.length - center.y,
      z: sum.z / verts.length - center.z,
    };
    let n = normal;
    if (n.x * fc.x + n.y * fc.y + n.z * fc.z < 0) {
      n = { x: -n.x, y: -n.y, z: -n.z };
    }
    const a = verts[0]!, b = verts[1]!, c = verts[2]!;
    const gx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const gy = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const gz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const out = [...verts];
    if (gx * n.x + gy * n.y + gz * n.z < 0) out.reverse();
    return { verts: out, normal: n };
  };

  // Side faces: connect adjacent rings.
  for (let i = 0; i < pathN - 1; i++) {
    const r0 = rings[i]!;
    const r1 = rings[i + 1]!;
    for (let j = 0; j < profileN; j++) {
      const j2 = (j + 1) % profileN;
      const v00 = r0[j]!, v01 = r0[j2]!;
      const v10 = r1[j]!, v11 = r1[j2]!;
      const oriented = orientFace([v00, v10, v11, v01], computeFaceNormal(v00, v10, v11));
      faces.push({ id: genId('face'), vertices: oriented.verts, normal: oriented.normal });
      edges.push(
        { id: genId('edge'), start: v00, end: v10 },
        { id: genId('edge'), start: v01, end: v11 },
      );
    }
  }

  // Cap faces: start and end (normal along the tangent, oriented outward).
  const capStart = rings[0]!;
  const capEnd = rings[pathN - 1]!;
  const startNormal = normalize({ x: -tangents[0]!.x, y: -tangents[0]!.y, z: -tangents[0]!.z });
  const endNormal = tangents[pathN - 1]!;
  const startFace = orientFace(capStart, startNormal);
  const endFace = orientFace(capEnd, endNormal);
  faces.push({ id: genId('face'), vertices: startFace.verts, normal: startFace.normal });
  faces.push({ id: genId('face'), vertices: endFace.verts, normal: endFace.normal });

  // Ring edges.
  for (const ring of rings) {
    for (let j = 0; j < profileN; j++) {
      edges.push({ id: genId('edge'), start: ring[j]!, end: ring[(j + 1) % profileN]! });
    }
  }

  const vertices: Vec3[] = [];
  for (const f of faces) vertices.push(...f.vertices);
  return { id: genId('body'), name: 'Sweep', vertices, faces, edges };
}
