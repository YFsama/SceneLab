import type {
  Feature,
  FeatureResult,
  SketchFeature,
  ExtrudeFeature,
  RevolveFeature,
  SweepFeature,
  LoftFeature,
  FilletFeature,
  ChamferFeature,
  ShellFeature,
  HoleFeature,
  HoleParams,
  ScaleFeature,
  LinearArrayFeature,
  CircularArrayFeature,
  MirrorFeature,
} from './types';
import type { SolidBody, Vec3, ExtrudeParams } from '../geometry/types';
import { createExtrude, createRevolve, createLoftSections, createCylinder, createCone, computeBoundingBox, computeBoundingBoxDiagonal } from '../geometry/brep';
import {
  applyFillet,
  applyChamfer,
  applyShell,
  applyLinearArray,
  applyCircularArray,
  applyMirror,
  resizeBodyAxis,
  rotateBody,
  sweepBody,
  translateBody,
} from '../geometry/operations';
import { solveSketch } from '../sketch/engine';
import { sketchFrame, sketchToWorld, planeNormal } from '../sketch/frames';
import type { Sketch } from '../sketch/types';
import { booleanOp, isManifoldEngineReady } from '../geometry/boolean';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/**
 * Whether the feature's evaluator consults the boolean engine, making its
 * result depend on engine readiness. The hole family does (evaluateHole →
 * drillHoleInBody and its counterbore/countersink cutters route through
 * booleanOp), and so does an extrude with op 'cut' (evaluateExtrude →
 * cutBodyWithCutter) — exact when the Manifold WASM engine is warm and a
 * blocky voxel approximation when it is not. Every other evaluator is pure
 * brep math, so their memo entries never need readiness invalidation.
 */
function featureTouchesBooleanEngine(feature: Feature): boolean {
  if (feature.type === 'hole') return true;
  return feature.type === 'extrude' && feature.params.op === 'cut';
}

export class FeatureTree {
  readonly features: Feature[] = [];
  private results = new Map<string, FeatureResult>();
  // Features whose body was consumed by a downstream operation (fillet, shell,
  // …) and should therefore not appear on its own in the final output.
  private consumed = new Set<string>();
  // Incremental DAG memo: per feature OBJECT, its last result, the parent
  // results it was computed from, which parent features that evaluation
  // consumed (fillet/shell/array replace their parent's output), and whether
  // the exact boolean engine was warm when it was evaluated. `updateFeature`
  // replaces the feature object, so an unchanged object with unchanged parent
  // results is reusable as-is — the downstream viewport diff keeps reusing
  // those body meshes instead of rebuilding every body on every recompute.
  // The readiness flag exists because a hole evaluated while the engine was
  // cold produces a blocky voxel approximation; without the check that result
  // would be pinned FOREVER, long after Manifold warmed up (see recompute).
  private memo = new Map<
    Feature,
    { result: FeatureResult; parents: FeatureResult[]; consumedParents: string[]; engineReady: boolean }
  >();

  addFeature(feature: Feature): void {
    this.features.push(feature);
  }

  removeFeature(featureId: string): void {
    const idx = this.features.findIndex((f) => f.id === featureId);
    if (idx !== -1) {
      this.features.splice(idx, 1);
      this.results.delete(featureId);
    }
  }

  getFeature(id: string): Feature | undefined {
    return this.features.find((f) => f.id === id);
  }

  /** Replace a feature in place via a pure mutator (no external state mutation). */
  updateFeature(id: string, mutator: (f: Feature) => Feature): void {
    const idx = this.features.findIndex((f) => f.id === id);
    if (idx !== -1) {
      this.features[idx] = mutator(this.features[idx]!);
    }
  }

  /**
   * Reorder a feature in the timeline (Fusion-style drag-reorder). Dependency
   * order is enforced: the moved feature must stay AFTER every parent and
   * BEFORE every dependent. Returns whether the order changed; an illegal
   * target leaves the timeline untouched.
   */
  moveFeature(id: string, toIndex: number): boolean {
    const from = this.features.findIndex((f) => f.id === id);
    if (from === -1) return false;
    const target = Math.max(0, Math.min(this.features.length - 1, toIndex));
    if (target === from) return false;
    if (!canReorderFeatures(this.features, id, target)) return false;
    const moved = this.features.splice(from, 1)[0]!;
    this.features.splice(target, 0, moved);
    return true;
  }

  getResult(id: string): FeatureResult | undefined {
    return this.results.get(id);
  }

  /**
   * The feature whose result produced the given body id. Lets modify features
   * (fillet, shell, arrays, …) attach parametrically to a body picked in the
   * viewport, the way Fusion 360 chains timeline features. Undefined for
   * direct bodies (created outside the tree).
   */
  findFeatureIdForBody(bodyId: string): string | undefined {
    for (const [featureId, result] of this.results) {
      if (result.bodies.some((b) => b.id === bodyId)) return featureId;
    }
    return undefined;
  }

  recompute(): void {
    this.consumed.clear();
    const prevMemo = this.memo;
    const nextMemo = new Map<
      Feature,
      { result: FeatureResult; parents: FeatureResult[]; consumedParents: string[]; engineReady: boolean }
    >();
    // Evaluators (firstParentBody, sketch lookups) read this.results while the
    // walk is in progress, so the fresh map must be live during the loop.
    const currentResults = new Map<string, FeatureResult>();
    this.results = currentResults;
    // Read once per walk: readiness only flips asynchronously (warmup), never
    // mid-loop, and reading it 80k times would be its own tax.
    const engineReady = isManifoldEngineReady();

    for (const feature of this.features) {
      if (feature.suppressed) continue;

      const parents = feature.parentIds
        .map((id) => currentResults.get(id))
        .filter((r): r is FeatureResult => r !== undefined);

      // Reuse the cached result when this exact feature object is unchanged,
      // every parent result is the same object it was computed from, and —
      // for features that consult the boolean engine — the engine's readiness
      // hasn't flipped since evaluation (a cold voxel result must not stay
      // pinned once the exact engine is live, and vice versa).
      const cached = prevMemo.get(feature);
      let result: FeatureResult;
      let consumedParents: string[];
      if (
        cached &&
        cached.parents.length === parents.length &&
        cached.parents.every((p, i) => p === parents[i]) &&
        (!featureTouchesBooleanEngine(feature) || cached.engineReady === engineReady)
      ) {
        result = cached.result;
        consumedParents = cached.consumedParents;
        // Replay the consumption this feature recorded last time — evaluators
        // did not run, so nothing else marks the parent as consumed.
        for (const id of consumedParents) this.consumed.add(id);
      } else {
        const consumedBefore = new Set(this.consumed);
        try {
          result = this.evaluateFeature(feature);
        } catch (e) {
          result = {
            bodies: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
        consumedParents = [...this.consumed].filter((id) => !consumedBefore.has(id));
      }

      nextMemo.set(feature, { result, parents, consumedParents, engineReady });
      currentResults.set(feature.id, result);
    }

    this.memo = nextMemo;
  }

  getLatestBodies(): SolidBody[] {
    // Walk features in order, accumulating bodies
    const bodies: SolidBody[] = [];
    for (const feature of this.features) {
      if (feature.suppressed) continue;
      if (this.consumed.has(feature.id)) continue;
      const result = this.results.get(feature.id);
      if (result && result.bodies.length > 0) {
        bodies.push(...result.bodies);
      }
    }
    return bodies;
  }

  /** First parent feature that produced a body, or undefined. */
  private firstParentBody(feature: Feature): { featureId: string; body: SolidBody } | undefined {
    for (const id of feature.parentIds) {
      const result = this.results.get(id);
      if (result && result.bodies[0]) {
        return { featureId: id, body: result.bodies[0] };
      }
    }
    return undefined;
  }

  private evaluateFeature(feature: Feature): FeatureResult {
    switch (feature.type) {
      case 'sketch':
        return this.evaluateSketch(feature);
      case 'extrude':
        return this.evaluateExtrude(feature);
      case 'revolve':
        return this.evaluateRevolve(feature);
      case 'sweep':
        return this.evaluateSweep(feature);
      case 'loft':
        return this.evaluateLoft(feature);
      case 'fillet':
        return this.evaluateFillet(feature);
      case 'chamfer':
        return this.evaluateChamfer(feature);
      case 'shell':
        return this.evaluateShell(feature);
      case 'hole':
        return this.evaluateHole(feature);
      case 'scale':
        return this.evaluateScale(feature);
      case 'linearArray':
        return this.evaluateLinearArray(feature);
      case 'circularArray':
        return this.evaluateCircularArray(feature);
      case 'mirror':
        return this.evaluateMirror(feature);
    }
  }

  private evaluateRevolve(feature: RevolveFeature): FeatureResult {
    const parentSketch = feature.parentIds
      .map((id) => this.getFeature(id))
      .find((f): f is SketchFeature => f?.type === 'sketch');
    if (!parentSketch) throw new Error('Revolve requires a parent sketch');

    const solved = solveSketch(parentSketch.sketch);
    const profilePoints = extractProfileFromSketch(parentSketch.sketch, solved);
    if (profilePoints.length < 3) {
      throw new Error('Sketch profile has fewer than 3 points');
    }

    // Plane-aware: the profile goes exactly where the viewport drew it, and
    // the axis of revolution is the frame's in-plane vertical (where the
    // sketch's +y points) — the same relationship the classic +Y-axis rule
    // had for a front-plane (xy) sketch.
    const planeId = parentSketch.sketch.planeId;
    const body = createRevolve({
      profile: profilePoints.map((p) => sketchToWorld(planeId, p.x, p.y)),
      axis: { origin: { x: 0, y: 0, z: 0 }, direction: sketchFrame(planeId).v },
      angle: feature.params.angle,
    });
    return { bodies: [body] };
  }

  private evaluateSweep(feature: SweepFeature): FeatureResult {
    // Profile: parent sketch if present, otherwise the explicit fallback.
    let profile: { x: number; y: number }[] | undefined = feature.params.profile;
    const parentSketch = feature.parentIds
      .map((id) => this.getFeature(id))
      .find((f): f is SketchFeature => f?.type === 'sketch');
    if (parentSketch) {
      const solved = solveSketch(parentSketch.sketch);
      const pts = extractProfileFromSketch(parentSketch.sketch, solved);
      if (pts.length >= 3) {
        // Plane-aware, like evaluateExtrude/evaluateRevolve: the profile is
        // expressed for the plane it was drawn on. The path stays world-space
        // BY DESIGN (performSweep builds it from the plane normal) and is
        // never transformed here.
        profile = mapSweepProfileToRing(parentSketch.sketch.planeId, pts, feature.params.path);
      }
    }
    if (!profile || profile.length < 3) {
      throw new Error('Sweep requires a profile of at least 3 points');
    }
    const body = sweepBody(profile, feature.params.path, feature.params.twist);
    return { bodies: [body] };
  }

  private evaluateLoft(feature: LoftFeature): FeatureResult {
    // Sections: one profile per parent sketch (in parent order, like Fusion's
    // loft section picking), falling back to explicit params.sections.
    const sections: { x: number; y: number; z: number }[][] = [];
    for (const id of feature.parentIds) {
      const f = this.getFeature(id);
      if (f?.type !== 'sketch') continue;
      const solved = solveSketch(f.sketch);
      const pts = extractProfileFromSketch(f.sketch, solved);
      if (pts.length >= 3) {
        // Plane-aware, like evaluateExtrude: each section maps onto the plane
        // its own sketch was drawn on (sketchToWorld('xz', …) ≡ the legacy
        // (x, 0, y) mapping bit-for-bit; a vertical 'xy' section now stands in
        // the world XY plane instead of lying flat on the ground).
        sections.push(pts.map((p) => sketchToWorld(f.sketch.planeId, p.x, p.y)));
      }
    }
    if (sections.length < 2 && feature.params.sections && feature.params.sections.length >= 2) {
      sections.push(...feature.params.sections);
    }
    if (sections.length < 2) {
      throw new Error('Loft requires at least two sections with 3+ points');
    }
    const body = createLoftSections(sections);
    return { bodies: [body] };
  }

  private evaluateFillet(feature: FilletFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Fillet requires a parent body');
    this.consumed.add(parent.featureId);
    return { bodies: [applyFillet(parent.body, feature.params.edgeIds, feature.params.radius)] };
  }

  private evaluateChamfer(feature: ChamferFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Chamfer requires a parent body');
    this.consumed.add(parent.featureId);
    return { bodies: [applyChamfer(parent.body, feature.params.edgeIds, feature.params.distance)] };
  }

  private evaluateShell(feature: ShellFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Shell requires a parent body');
    this.consumed.add(parent.featureId);
    return { bodies: [applyShell(parent.body, feature.params.faceIds, feature.params.thickness)] };
  }

  private evaluateHole(feature: HoleFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Hole requires a parent body');
    // Consumption only on SUCCESS (the cut rule): drillHoleInBody throws on a
    // miss ('hole does not reach the body'), and a failed hole must leave the
    // un-drilled parent visible (last-good-state) instead of consuming it
    // into nothing.
    const drilled = drillHoleInBody(parent.body, feature.params);
    this.consumed.add(parent.featureId);
    return { bodies: [drilled] };
  }

  private evaluateScale(feature: ScaleFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Scale requires a parent body');
    this.consumed.add(parent.featureId);
    return { bodies: [resizeBodyAxis(parent.body, feature.params.axis, feature.params.target)] };
  }

  private evaluateLinearArray(feature: LinearArrayFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Linear array requires a parent body');
    this.consumed.add(parent.featureId);
    const { direction, count, spacing } = feature.params;
    return { bodies: applyLinearArray(parent.body, direction, count, spacing) };
  }

  private evaluateCircularArray(feature: CircularArrayFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Circular array requires a parent body');
    this.consumed.add(parent.featureId);
    return { bodies: applyCircularArray(parent.body, feature.params.axis, feature.params.count) };
  }

  private evaluateMirror(feature: MirrorFeature): FeatureResult {
    const parent = this.firstParentBody(feature);
    if (!parent) throw new Error('Mirror requires a parent body');
    const mirrored = applyMirror(parent.body, feature.params.plane);
    if (feature.params.keepOriginal === false) {
      this.consumed.add(parent.featureId);
      return { bodies: [mirrored] };
    }
    // Keep the original (it stays as its own feature output) plus the reflection.
    return { bodies: [mirrored] };
  }

  private evaluateSketch(feature: SketchFeature): FeatureResult {
    solveSketch(feature.sketch);
    return { bodies: [] }; // Sketches don't produce bodies directly
  }

  private evaluateExtrude(feature: ExtrudeFeature): FeatureResult {
    // Find parent sketch feature
    const parentSketch = feature.parentIds
      .map((id) => this.getFeature(id))
      .find((f): f is SketchFeature => f?.type === 'sketch');

    // The extruded profile — the CUTTER when the operation is 'cut'.
    let body: SolidBody;
    if (!parentSketch) {
      // Use params profile directly
      body = createExtrude(feature.params);
    } else {
      body = extrudeSketchBody(parentSketch.sketch, feature.params);
    }

    // Join (and every op-less legacy feature): a new, standalone body.
    if (feature.params.op !== 'cut') return { bodies: [body] };

    // Cut (Fusion Extrude ▸ Operation: Cut): subtract the extruded profile
    // from the target — the first parent that produced a body (the sketch
    // parent has no result bodies, so firstParentBody resolves the target
    // regardless of parentId order). The target is CONSUMED like fillet/hole
    // consume theirs, leaving exactly one body. Consumption happens only on
    // SUCCESS — cutBodyWithCutter throws on a miss (e.g. the cutter sketch
    // was later edited off the target), and a failed cut must leave the
    // un-cut target visible (last-good-state) instead of consuming it into
    // nothing.
    const target = this.firstParentBody(feature);
    if (!target) throw new Error('Cut requires a target body');
    const cut = cutBodyWithCutter(target.body, body);
    this.consumed.add(target.featureId);
    return { bodies: [cut] };
  }
}

/**
 * Resolve a sketch into its world-space extruded solid: solve, extract the
 * profile, map it onto the plane it was drawn on and extrude along that
 * plane's normal. Shared by the extrude evaluator and the store's
 * direct-body cut path so both extrude the profile identically. Throws the
 * evaluator's profile errors (fewer than 3 points) for honest failure.
 */
export function extrudeSketchBody(sketch: Sketch, params: ExtrudeParams): SolidBody {
  const solved = solveSketch(sketch);
  const profilePoints = extractProfileFromSketch(sketch, solved);

  if (profilePoints.length < 3) {
    // The sketch did not yield a usable profile (e.g. it is empty). Fall back
    // to an explicit profile carried on the feature params, if present.
    if (params.profile.length >= 3) {
      return createExtrude(params);
    }
    throw new Error('Sketch profile has fewer than 3 points');
  }

  // Plane-aware: map the profile onto the plane the user drew it on and
  // extrude along that plane's normal. For the default 'xz' ground plane
  // this is bit-identical to the old hardcoded mapping (x, 0, y) + +Y; a
  // vertical ('xy') sketch now extrudes along world Z instead of lying flat.
  const planeId = sketch.planeId;
  return createExtrude({
    ...params,
    profile: profilePoints.map((p) => sketchToWorld(planeId, p.x, p.y)),
    direction: planeNormal(planeId),
  });
}

type Pt = { x: number; y: number };
const ptKey = (p: Pt) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;

/**
 * The ring basis sweepBody derives at the first path sample — the same
 * tangent / gimbal-free reference / Gram-Schmidt sequence as
 * operations.sweepBody — so the sweep profile mapping below and the sweep
 * itself share one frame convention. Null for a degenerate path (fewer than
 * two points or a zero-length first segment); sweepBody reports its own error
 * for those, so callers fall back to the legacy mapping.
 */
function sweepRingBasisAtStart(path: Vec3[]): { right: Vec3; up: Vec3 } | null {
  if (path.length < 2) return null;
  const t0 = path[0]!;
  const t1 = path[1]!;
  const tx = t1.x - t0.x, ty = t1.y - t0.y, tz = t1.z - t0.z;
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-12) return null;
  const t = { x: tx / tl, y: ty / tl, z: tz / tl };
  // Reference vector avoiding gimbal lock — the same choice sweepBody makes.
  const ref = Math.abs(t.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const dot = ref.x * t.x + ref.y * t.y + ref.z * t.z;
  const ux = ref.x - dot * t.x, uy = ref.y - dot * t.y, uz = ref.z - dot * t.z;
  const ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-12) return null;
  const up = { x: ux / ul, y: uy / ul, z: uz / ul };
  const right: Vec3 = {
    x: t.y * up.z - t.z * up.y,
    y: t.z * up.x - t.x * up.z,
    z: t.x * up.y - t.y * up.x,
  };
  return { right, up };
}

/**
 * Express a parent-sketch sweep profile for the plane it was drawn on
 * (plane-aware like evaluateExtrude — see the pass #26 sketch-frame work).
 *
 * sweepBody consumes a 2D profile and orients it in its own ring basis
 * (right = tangent × up), which is LEFT-handed relative to the path
 * direction. The default 'xz' ground frame is left-handed the same way, so
 * sketch coordinates passed through unchanged keep the profile's orientation
 * — that legacy mapping is preserved bit-for-bit. The right-handed 'xy'/'yz'
 * frames would come out MIRRORED by the same identity mapping, so there the
 * points are mapped through the plane frame into world space and re-expressed
 * in the ring basis: the swept start ring lands exactly where the viewport
 * drew the profile.
 */
function mapSweepProfileToRing(
  planeId: string,
  pts: Pt[],
  path: Vec3[],
): { x: number; y: number }[] {
  const frame = sketchFrame(planeId);
  // cross(u, v) · normal: −1 for the left-handed 'xz' ground frame (and any
  // unknown plane id, which falls back to it), +1 for 'xy'/'yz'.
  const handed =
    (frame.u.y * frame.v.z - frame.u.z * frame.v.y) * frame.normal.x +
    (frame.u.z * frame.v.x - frame.u.x * frame.v.z) * frame.normal.y +
    (frame.u.x * frame.v.y - frame.u.y * frame.v.x) * frame.normal.z;
  if (handed < 0) {
    // Legacy mapping for the ground frame — bit-identical to the old code.
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }
  const ring = sweepRingBasisAtStart(path);
  if (!ring) return pts.map((p) => ({ x: p.x, y: p.y }));
  return pts.map((p) => {
    const w = sketchToWorld(planeId, p.x, p.y);
    return {
      x: w.x * ring.right.x + w.y * ring.right.y + w.z * ring.right.z,
      y: w.x * ring.up.x + w.y * ring.up.y + w.z * ring.up.z,
    };
  });
}

/** Order a set of line segments into a connected loop by shared endpoints. */
function chainLineLoop(segments: [Pt, Pt][]): Pt[] {
  const adj = new Map<string, { seg: number; other: Pt }[]>();
  segments.forEach(([a, b], i) => {
    (adj.get(ptKey(a)) ?? adj.set(ptKey(a), []).get(ptKey(a))!).push({ seg: i, other: b });
    (adj.get(ptKey(b)) ?? adj.set(ptKey(b), []).get(ptKey(b))!).push({ seg: i, other: a });
  });

  const start = segments[0]![0];
  const ordered: Pt[] = [start];
  const used = new Set<number>();
  let cur = start;
  for (let guard = 0; guard <= segments.length; guard++) {
    const next = (adj.get(ptKey(cur)) ?? []).find((c) => !used.has(c.seg));
    if (!next) break;
    used.add(next.seg);
    cur = next.other;
    if (ptKey(cur) === ptKey(start)) break; // loop closed
    ordered.push(cur);
  }
  return ordered;
}

function extractProfileFromSketch(sketch: Sketch, solved: Map<string, Pt>): Pt[] {
  const lineSegments: [Pt, Pt][] = [];
  const other: Pt[] = [];

  for (const entity of sketch.entities.values()) {
    // Construction geometry is reference-only — excluded from extrude/revolve profiles.
    if (entity.construction) continue;
    if (entity.type === 'line') {
      const p1 = solved.get(entity.p1Id);
      const p2 = solved.get(entity.p2Id);
      if (p1 && p2) lineSegments.push([p1, p2]);
    } else if (entity.type === 'rectangle') {
      for (const pid of [entity.p1Id, entity.p2Id, entity.p3Id, entity.p4Id]) {
        const p = solved.get(pid);
        if (p) other.push(p);
      }
    } else if (entity.type === 'circle') {
      const c = solved.get(entity.centerId);
      if (c) {
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * Math.PI * 2;
          other.push({ x: c.x + entity.radius * Math.cos(a), y: c.y + entity.radius * Math.sin(a) });
        }
      }
    } else if (entity.type === 'arc') {
      const c = solved.get(entity.centerId);
      if (c) {
        const sweep = entity.endAngle - entity.startAngle;
        const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 32));
        for (let i = 0; i <= steps; i++) {
          const a = entity.startAngle + (sweep * i) / steps;
          other.push({ x: c.x + entity.radius * Math.cos(a), y: c.y + entity.radius * Math.sin(a) });
        }
      }
    }
  }

  // Lines form the profile: chain them into a proper ordered loop (robust to
  // the order they were drawn in, avoiding self-intersecting "bowtie" profiles).
  if (lineSegments.length > 0) {
    const loop = chainLineLoop(lineSegments);
    if (loop.length >= 3) return loop;
  }

  // Otherwise use the rectangle/circle/arc points, deduplicated.
  const seen = new Set<string>();
  const unique: Pt[] = [];
  for (const p of other) {
    const k = ptKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(p);
    }
  }
  return unique;
}

export function createSketchFeature(sketch: Sketch, parentIds: string[] = []): SketchFeature {
  return {
    id: genId('feat'),
    type: 'sketch',
    name: `Sketch ${sketch.id}`,
    suppressed: false,
    parentIds,
    sketch,
  };
}

export function createExtrudeFeature(
  params: ExtrudeFeature['params'],
  parentIds: string[],
): ExtrudeFeature {
  return {
    id: genId('feat'),
    type: 'extrude',
    name: 'Extrude',
    suppressed: false,
    parentIds,
    params,
  };
}

export function createRevolveFeature(angle: number, parentIds: string[]): RevolveFeature {
  return {
    id: genId('feat'),
    type: 'revolve',
    name: 'Revolve',
    suppressed: false,
    parentIds,
    params: { angle },
  };
}

export function createSweepFeature(
  params: SweepFeature['params'],
  parentIds: string[] = [],
): SweepFeature {
  return {
    id: genId('feat'),
    type: 'sweep',
    name: 'Sweep',
    suppressed: false,
    parentIds,
    params,
  };
}

export function createLoftFeature(
  params: LoftFeature['params'] = {},
  parentIds: string[] = [],
): LoftFeature {
  return {
    id: genId('feat'),
    type: 'loft',
    name: 'Loft',
    suppressed: false,
    parentIds,
    params,
  };
}

export function createFilletFeature(
  edgeIds: string[],
  radius: number,
  parentIds: string[],
): FilletFeature {
  return {
    id: genId('feat'),
    type: 'fillet',
    name: 'Fillet',
    suppressed: false,
    parentIds,
    params: { edgeIds, radius },
  };
}

export function createChamferFeature(
  edgeIds: string[],
  distance: number,
  parentIds: string[],
): ChamferFeature {
  return {
    id: genId('feat'),
    type: 'chamfer',
    name: 'Chamfer',
    suppressed: false,
    parentIds,
    params: { edgeIds, distance },
  };
}

export function createShellFeature(
  faceIds: string[],
  thickness: number,
  parentIds: string[],
): ShellFeature {
  return {
    id: genId('feat'),
    type: 'shell',
    name: 'Shell',
    suppressed: false,
    parentIds,
    params: { faceIds, thickness },
  };
}

export function createHoleFeature(
  params: HoleFeature['params'],
  parentIds: string[],
): HoleFeature {
  return {
    id: genId('feat'),
    type: 'hole',
    name: 'Hole',
    suppressed: false,
    parentIds,
    params,
  };
}

export function createScaleFeature(
  axis: 'x' | 'y' | 'z',
  target: number,
  parentIds: string[],
): ScaleFeature {
  return {
    id: genId('feat'),
    type: 'scale',
    name: `Scale ${axis.toUpperCase()}`,
    suppressed: false,
    parentIds,
    params: { axis, target },
  };
}

export function createLinearArrayFeature(
  direction: Vec3,
  count: number,
  spacing: number,
  parentIds: string[],
): LinearArrayFeature {
  return {
    id: genId('feat'),
    type: 'linearArray',
    name: 'Linear Array',
    suppressed: false,
    parentIds,
    params: { direction, count, spacing },
  };
}

export function createCircularArrayFeature(
  axis: { origin: Vec3; direction: Vec3 },
  count: number,
  parentIds: string[],
): CircularArrayFeature {
  return {
    id: genId('feat'),
    type: 'circularArray',
    name: 'Circular Array',
    suppressed: false,
    parentIds,
    params: { axis, count },
  };
}

export function createMirrorFeature(
  plane: { origin: Vec3; normal: Vec3 },
  parentIds: string[],
  keepOriginal = true,
): MirrorFeature {
  return {
    id: genId('feat'),
    type: 'mirror',
    name: 'Mirror',
    suppressed: false,
    parentIds,
    params: { plane, keepOriginal },
  };
}

/**
 * Boolean difference `target − cutter` along the SAME kernel path
 * drillHoleInBody uses (booleanOp: exact Manifold when warm, voxel fallback
 * otherwise — synchronous; the pass-26 AABB cache keeps the voxel path fast).
 * Failure honesty (pass-25/26 rules): a cutter that does not intersect the
 * target THROWS instead of silently returning the target unchanged, and so
 * does a cutter that removes the entire target. The cut depth is honest —
 * the user-specified extrude distance governs, so a partial (blind) cut is a
 * legitimate result; extend the sketch/distance for a through cut. Shared by
 * the extrude-cut evaluator (tree targets) and the store's direct-body cut.
 */
export function cutBodyWithCutter(target: SolidBody, cutter: SolidBody): SolidBody {
  // Probe with the intersection first: difference alone cannot tell a miss
  // from a hit (target − missed-cutter is just the target again).
  const overlap = booleanOp(target, cutter, 'intersect', 48);
  if (!overlap) throw new Error('cutter does not intersect the target body');
  const result = booleanOp(target, cutter, 'difference', 48);
  if (!result) throw new Error('cut removed the entire target body');
  return { ...result, name: target.name };
}

/**
 * Drill a hole in `body`: subtract a `diameter` cylinder that starts at
 * `center` and extends `depth` along `direction` (null depth = through-all,
 * a cutter twice the bounding-box diagonal centred on the start point so it
 * fully spans the parent along the drill axis). An optional counterbore
 * (second, wider cylinder from the same entry point) or countersink
 * (truncated cone whose included angle meets the hole diameter at its base)
 * widens the entry — the counterbore wins when both are present. Shared by
 * the hole feature evaluator and the store's direct-body edit path.
 *
 * Failure honesty (the cutBodyWithCutter rule): a cutter that does not reach
 * the body (e.g. an off-surface start with a blind depth) THROWS 'hole does
 * not reach the body' instead of silently returning the body unchanged —
 * difference alone cannot tell a miss from a hit. The intersect probe cannot
 * reject a legitimate entry: a through-all cutter spans twice the bounding-box
 * diagonal centred on the start point, and a blind cutter starts exactly on
 * the picked surface point, so every on-body entry intersects.
 */
export function drillHoleInBody(
  body: SolidBody,
  params: HoleParams,
): SolidBody {
  const { center, direction, diameter, depth, counterbore, countersink } = params;
  if (!Number.isFinite(diameter) || diameter <= 0) throw new Error('Hole diameter must be positive');
  if (depth !== null && (!Number.isFinite(depth) || depth <= 0)) {
    throw new Error('Hole depth must be positive (or null for through-all)');
  }
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (len < 1e-10) throw new Error('Hole direction cannot be zero');
  const d = { x: direction.x / len, y: direction.y / len, z: direction.z / len };

  // Through-all spans any chord of the bounding box: the diagonal is the
  // largest possible distance between two points in it.
  const height = depth ?? computeBoundingBoxDiagonal(body) * 2;
  // Blind holes start exactly at `center`; a through-all cutter is centred on
  // it (pulled back by half its length) so it out-runs the parent both ways.
  const backUp = depth === null ? height / 2 : 0;

  // createCylinder builds a 32-gon prism along +Y with its base centred on the
  // origin — rotate +Y onto the drill direction, then move the base into place.
  let cutter = createCylinder(diameter / 2, height);
  cutter = rotateUpToDirection(cutter, d);
  cutter = translateBody(
    cutter,
    { x: center.x - d.x * backUp, y: center.y - d.y * backUp, z: center.z - d.z * backUp },
    'Hole cutter',
  );

  // Probe with the intersection first (the cutBodyWithCutter pattern): an
  // empty overlap means the cutter never reached the body, and body − cutter
  // would just hand back the body unchanged as a fake success.
  const overlap = booleanOp(body, cutter, 'intersect', 48);
  if (!overlap) throw new Error('hole does not reach the body');

  let result = booleanOp(body, cutter, 'difference', 48);
  if (!result) throw new Error('Hole removed the entire parent body');

  if (counterbore) {
    result = drillCounterbore(result, center, d, diameter, counterbore, height);
  } else if (countersink) {
    result = drillCountersink(result, center, d, diameter, countersink, height);
  }
  return { ...result, name: body.name };
}

/** Counterbore: a second, wider cylinder from the same entry point. */
function drillCounterbore(
  body: SolidBody,
  center: Vec3,
  d: Vec3,
  holeDiameter: number,
  cb: { diameter: number; depth: number },
  throughHeight: number,
): SolidBody {
  if (!Number.isFinite(cb.diameter) || cb.diameter <= holeDiameter) {
    throw new Error('Counterbore diameter must exceed the hole diameter');
  }
  if (!Number.isFinite(cb.depth) || cb.depth <= 0) {
    throw new Error('Counterbore depth must be positive');
  }
  // Like a blind hole, the counterbore starts exactly at the entry point; its
  // depth is clamped to the through-all cutter length so it can never out-run
  // the parent geometry by an unbounded amount.
  const depth = Math.min(cb.depth, throughHeight);
  let cutter = createCylinder(cb.diameter / 2, depth);
  cutter = rotateUpToDirection(cutter, d);
  cutter = translateBody(cutter, center, 'Counterbore cutter');
  const result = booleanOp(body, cutter, 'difference', 48);
  if (!result) throw new Error('Counterbore removed the entire parent body');
  return result;
}

/**
 * Countersink: a truncated cone (frustum) whose top face is the countersink
 * diameter at the entry point, tapering with the full included angle until it
 * meets the hole diameter at depth (D − d)/2 / tan(angle/2).
 */
function drillCountersink(
  body: SolidBody,
  center: Vec3,
  d: Vec3,
  holeDiameter: number,
  cs: { diameter: number; angleDeg: number },
  throughHeight: number,
): SolidBody {
  if (!Number.isFinite(cs.diameter) || cs.diameter <= holeDiameter) {
    throw new Error('Countersink diameter must exceed the hole diameter');
  }
  // Clamp the included angle to a sane machining range (1°…179°) before
  // halving; the depth is then bounded by the through-all cutter length.
  const angleDeg = Math.min(179, Math.max(1, Number.isFinite(cs.angleDeg) ? cs.angleDeg : 90));
  const halfAngle = (angleDeg * Math.PI) / 180 / 2;
  const idealDepth = ((cs.diameter - holeDiameter) / 2) / Math.tan(halfAngle);
  const depth = Math.min(idealDepth, throughHeight);
  if (!(depth > 1e-9)) throw new Error('Countersink depth degenerated to zero');
  // If the depth was clamped, the frustum stops short of the hole diameter —
  // keep the angle exact and recompute the truncated top radius instead.
  const topRadius = Math.max(
    holeDiameter / 2,
    cs.diameter / 2 - depth * Math.tan(halfAngle),
  );
  // createCone tapers from radiusBottom at y = 0 up to radiusTop at y = height —
  // exactly the frustum needed with its wide face on the entry point.
  let cutter = createCone(cs.diameter / 2, topRadius, depth);
  cutter = rotateUpToDirection(cutter, d);
  cutter = translateBody(cutter, center, 'Countersink cutter');
  const result = booleanOp(body, cutter, 'difference', 48);
  if (!result) throw new Error('Countersink removed the entire parent body');
  return result;
}

/** Rotate a body built along +Y so +Y maps onto the (unit) direction. */
function rotateUpToDirection(body: SolidBody, d: Vec3): SolidBody {
  // Rotation axis = cross(+Y, d) = (d.z, 0, −d.x); angle from sin/cos parts.
  const sin = Math.hypot(d.z, d.x);
  if (sin < 1e-9) {
    if (d.y > 0) return body; // already along +Y
    // Straight down: flip 180° about X.
    return rotateBody(body, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, Math.PI);
  }
  const angle = Math.atan2(sin, d.y);
  return rotateBody(body, { origin: { x: 0, y: 0, z: 0 }, direction: { x: d.z / sin, y: 0, z: -d.x / sin } }, angle);
}

/**
 * Default hole placement for a body (Fusion's hole-on-face pick): the centroid
 * of the topmost up-facing face, drilling straight down (−Y).
 */
export function topFaceHolePlacement(body: SolidBody): { center: Vec3; direction: Vec3 } {
  let best: { y: number; center: Vec3 } | null = null;
  for (const f of body.faces) {
    if (f.normal.y <= 0.9) continue; // up-facing planar faces only
    const n = f.vertices.length;
    if (n === 0) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const v of f.vertices) { cx += v.x; cy += v.y; cz += v.z; }
    const c = { x: cx / n, y: cy / n, z: cz / n };
    if (!best || c.y > best.y) best = { y: c.y, center: c };
  }
  return {
    center: best ? best.center : computeBoundingBoxCenterOf(body),
    direction: { x: 0, y: -1, z: 0 },
  };
}

function computeBoundingBoxCenterOf(body: SolidBody): Vec3 {
  const bb = computeBoundingBox(body);
  return { x: (bb.min.x + bb.max.x) / 2, y: bb.max.y, z: (bb.min.z + bb.max.z) / 2 };
}

/**
 * Whether moving `featureId` to `toIndex` keeps the timeline a valid DAG:
 * every parent must stay before the feature, every dependent after it. Pure —
 * the timeline UI uses it to show a legal drop target / not-allowed cursor
 * before the drop, and FeatureTree.moveFeature re-checks it.
 */
export function canReorderFeatures(features: Feature[], featureId: string, toIndex: number): boolean {
  const from = features.findIndex((f) => f.id === featureId);
  if (from === -1) return false;
  const target = Math.max(0, Math.min(features.length - 1, toIndex));
  const next = [...features];
  const moved = next.splice(from, 1)[0]!;
  next.splice(target, 0, moved);
  const index = new Map(next.map((f, i) => [f.id, i] as const));
  for (const f of next) {
    const fi = index.get(f.id)!;
    for (const pid of f.parentIds) {
      const pi = index.get(pid);
      // Parents only exist in this tree (external ids are ignored, as in recompute).
      if (pi !== undefined && pi >= fi) return false;
    }
  }
  return true;
}
