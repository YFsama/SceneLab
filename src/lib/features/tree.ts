import type { Feature, FeatureResult, SketchFeature, ExtrudeFeature } from './types';
import type { SolidBody } from '../geometry/types';
import { createExtrude } from '../geometry/brep';
import { solveSketch } from '../sketch/engine';
import type { Sketch } from '../sketch/types';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export class FeatureTree {
  readonly features: Feature[] = [];
  private results = new Map<string, FeatureResult>();

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

  getResult(id: string): FeatureResult | undefined {
    return this.results.get(id);
  }

  recompute(): void {
    this.results.clear();

    for (const feature of this.features) {
      if (feature.suppressed) continue;

      try {
        const result = this.evaluateFeature(feature);
        this.results.set(feature.id, result);
      } catch (e) {
        this.results.set(feature.id, {
          bodies: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  getLatestBodies(): SolidBody[] {
    // Walk features in order, accumulating bodies
    const bodies: SolidBody[] = [];
    for (const feature of this.features) {
      if (feature.suppressed) continue;
      const result = this.results.get(feature.id);
      if (result && result.bodies.length > 0) {
        bodies.push(...result.bodies);
      }
    }
    return bodies;
  }

  private evaluateFeature(feature: Feature): FeatureResult {
    switch (feature.type) {
      case 'sketch':
        return this.evaluateSketch(feature);
      case 'extrude':
        return this.evaluateExtrude(feature);
      default:
        return { bodies: [] };
    }
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

function extractProfileFromSketch(
  sketch: Sketch,
  solved: Map<string, { x: number; y: number }>,
): { x: number; y: number }[] {
  // Collect all line endpoints in order to form a profile
  const points: { x: number; y: number }[] = [];

  for (const entity of sketch.entities.values()) {
    if (entity.type === 'line') {
      const p1 = solved.get(entity.p1Id);
      const p2 = solved.get(entity.p2Id);
      if (p1) points.push(p1);
      if (p2) points.push(p2);
    } else if (entity.type === 'rectangle') {
      const ids = [entity.p1Id, entity.p2Id, entity.p3Id, entity.p4Id];
      for (const pid of ids) {
        const p = solved.get(pid);
        if (p) points.push(p);
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique: { x: number; y: number }[] = [];
  for (const p of points) {
    const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    if (!seen.has(key)) {
      seen.add(key);
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
