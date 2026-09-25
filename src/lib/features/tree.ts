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
import type { SolidBody, Vec3 } from '../geometry/types';
import { createExtrude, createRevolve, createLoftSections, createCylinder, createCone, computeBoundingBox, computeBoundingBoxDiagonal } from '../geometry/brep';
import { booleanOp } from '../geometry/boolean';
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
import type { Sketch } from '../sketch/types';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export class FeatureTree {
  readonly features: Feature[] = [];
  private results = new Map<string, FeatureResult>();
  // Features whose body was consumed by a downstream operation (fillet, shell,
  // …) and should therefore not appear on its own in the final output.
  private consumed = new Set<string>();
  // Incremental DAG memo: per feature OBJECT, its last result, the parent
  // results it was computed from, and which parent features that evaluation
  // consumed (fillet/shell/array replace their parent's output). `updateFeature`
  // replaces the feature object, so an unchanged object with unchanged parent
  // results is reusable as-is — the downstream viewport diff keeps reusing
  // those body meshes instead of rebuilding every body on every recompute.
  private memo = new Map<Feature, { result: FeatureResult; parents: FeatureResult[]; consumedParents: string[] }>();

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
    const nextMemo = new Map<Feature, { result: FeatureResult; parents: FeatureResult[]; consumedParents: string[] }>();
    // Evaluators (firstParentBody, sketch lookups) read this.results while the
    // walk is in progress, so the fresh map must be live during the loop.
    const currentResults = new Map<string, FeatureResult>();
    this.results = currentResults;

    for (const feature of this.features) {
      if (feature.suppressed) continue;

      const parents = feature.parentIds
        .map((id) => currentResults.get(id))
        .filter((r): r is FeatureResult => r !== undefined);

      // Reuse the cached result when this exact feature object is unchanged
      // and every parent result is the same object it was computed from.
      const cached = prevMemo.get(feature);
      let result: FeatureResult;
      let consumedParents: string[];
      if (
        cached &&
        cached.parents.length === parents.length &&
        cached.parents.every((p, i) => p === parents[i])
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

      nextMemo.set(feature, { result, parents, consumedParents });
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

    const body = createRevolve({
      profile: profilePoints.map((p) => ({ x: p.x, y: p.y, z: 0 })),
      axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
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
        // Same sketch→world mapping as extrude: sketch (x,y) onto world (x,z).
        profile = pts.map((p) => ({ x: p.x, y: p.y }));
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
        sections.push(pts.map((p) => ({ x: p.x, y: 0, z: p.y })));
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
    this.consumed.add(parent.featureId);
    return { bodies: [drillHoleInBody(parent.body, feature.params)] };
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

    if (!parentSketch) {
      // Use params profile directly
      const body = createExtrude(feature.params);
      return { bodies: [body] };
    }

    // Get resolved points from sketch
    const solved = solveSketch(parentSketch.sketch);
    const profilePoints = extractProfileFromSketch(parentSketch.sketch, solved);

    if (profilePoints.length < 3) {
      // The sketch did not yield a usable profile (e.g. it is empty). Fall back
      // to an explicit profile carried on the feature params, if present.
      if (feature.params.profile.length >= 3) {
        return { bodies: [createExtrude(feature.params)] };
      }
      throw new Error('Sketch profile has fewer than 3 points');
    }

    const body = createExtrude({
      ...feature.params,
      profile: profilePoints.map((p) => ({ x: p.x, y: 0, z: p.y })),
    });

    return { bodies: [body] };
  }
}

type Pt = { x: number; y: number };
const ptKey = (p: Pt) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;

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
 * Drill a hole in `body`: subtract a `diameter` cylinder that starts at
 * `center` and extends `depth` along `direction` (null depth = through-all,
 * a cutter twice the bounding-box diagonal centred on the start point so it
 * fully spans the parent along the drill axis). An optional counterbore
 * (second, wider cylinder from the same entry point) or countersink
 * (truncated cone whose included angle meets the hole diameter at its base)
 * widens the entry — the counterbore wins when both are present. Shared by
 * the hole feature evaluator and the store's direct-body edit path.
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
