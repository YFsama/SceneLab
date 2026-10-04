// Contract tests for the AI-takeover tool work: undo/redo, feature management,
// edge addressing, tree-aware modify routing, array count semantics, sketch
// read-back, workspace/body management, and the loop-mechanics guards.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerBuiltinTools } from './builtinTools';
import { getTool, clearTools } from './toolRegistry';
import { useStore } from '../../store/app';
import { createBox } from '../geometry/brep';
import { createSketch } from '../sketch/engine';
import { getPendingConfirm } from '../confirm';
import { SAMPLE_PROJECTS } from '../library/samples';
import type { SolidBody } from '../geometry/types';

/** Sketch a rectangle and extrude it — the canonical feature-tree body.
 * 'xz' = the ground plane (its extrude runs along world +Y). */
async function buildTreeBox(x1 = 0, y1 = 0, x2 = 10, y2 = 10, distance = 5): Promise<string> {
  const st = useStore.getState();
  st.setSketchActive(true);
  st.setCurrentSketch(createSketch('xz'));
  st.addSketchRect(x1, y1, x2, y2);
  const r = (await getTool('extrude')!.execute({ distance })) as { success: boolean };
  expect(r.success).toBe(true);
  const body = useStore.getState().bodies.at(-1);
  if (!body) throw new Error('extrude produced no body');
  return body.id;
}

const bboxCenter = (b: SolidBody) => {
  const xs = b.vertices.map((v) => v.x);
  const ys = b.vertices.map((v) => v.y);
  const zs = b.vertices.map((v) => v.z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
};

const centroids = () => useStore.getState().bodies.map((b) => bboxCenter(b));
const allDistinct = (pts: Array<{ x: number; y: number; z: number }>) => {
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6) {
        return false;
      }
    }
  }
  return true;
};

describe('undo/redo tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.setState({ projectDirty: false });
  });

  it('undo restores the state removed by the last tool', async () => {
    await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 });
    await getTool('create_box')!.execute({ width: 5, height: 5, depth: 5 });
    expect(useStore.getState().bodies).toHaveLength(2);
    await getTool('delete_body')!.execute({ bodyId: useStore.getState().bodies[0]!.id });
    expect(useStore.getState().bodies).toHaveLength(1);

    const r = (await getTool('undo')!.execute({})) as {
      success: boolean; canUndo: boolean; canRedo: boolean; restored: { bodyCount: number };
    };
    expect(r.success).toBe(true);
    expect(r.canRedo).toBe(true);
    expect(r.restored.bodyCount).toBe(2); // the deleted body is back
    expect(useStore.getState().bodies).toHaveLength(2);
  });

  it('redo re-applies the undone change', async () => {
    await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 });
    await getTool('undo')!.execute({});
    expect(useStore.getState().bodies).toHaveLength(0);
    const r = (await getTool('redo')!.execute({})) as { success: boolean; restored: { bodyCount: number } };
    expect(r.success).toBe(true);
    expect(r.restored.bodyCount).toBe(1);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('undo during an active sketch steps the SKETCH history, not the model stack', async () => {
    // A model-level entry exists below the sketch session — the undo tool must
    // NOT restore it (that would wipe currentSketch back to null).
    await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 });
    const st = useStore.getState();
    st.setSketchActive(true);
    st.setCurrentSketch(createSketch('xz'));
    await getTool('draw_line')!.execute({ x1: 0, y1: 0, x2: 10, y2: 0 });
    await getTool('draw_line')!.execute({ x1: 10, y1: 0, x2: 10, y2: 6 });
    const entitiesBefore = useStore.getState().currentSketch!.entities.size;
    expect(entitiesBefore).toBeGreaterThan(3);

    const r = (await getTool('undo')!.execute({})) as { success: boolean; scope?: string };
    expect(r.success).toBe(true);
    expect(r.scope).toBe('sketch');
    // One line (plus its points) went; the sketch session survived.
    expect(useStore.getState().currentSketch!.entities.size).toBeLessThan(entitiesBefore);
    expect(useStore.getState().currentSketch).not.toBeNull();
    expect(useStore.getState().sketchActive).toBe(true);
    // The model-level body is untouched by the sketch undo.
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('undo/redo with empty history return success:false instead of pretending', async () => {
    const u = (await getTool('undo')!.execute({})) as { success: boolean; reason?: string };
    expect(u.success).toBe(false);
    expect(u.reason).toMatch(/nothing to undo/i);
    const r = (await getTool('redo')!.execute({})) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/nothing to redo/i);
  });

  it('undo restores a removed feature and its body', async () => {
    await buildTreeBox();
    const listed = (await getTool('list_features')!.execute({})) as { count: number };
    expect(listed.count).toBe(2); // sketch + extrude
    const extrude = ((await getTool('list_features')!.execute({})) as {
      features: Array<{ id: string; type: string }>;
    }).features.find((f) => f.type === 'extrude')!;

    const rm = (await getTool('remove_feature')!.execute({ featureId: extrude.id })) as { success: boolean };
    expect(rm.success).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(0);

    await getTool('undo')!.execute({});
    expect(useStore.getState().featureTree.features).toHaveLength(2);
    expect(useStore.getState().bodies).toHaveLength(1);
  });
});

describe('feature management tools', () => {
  beforeEach(async () => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.setState({ projectDirty: false });
  });

  it('remove_feature reduces the tree and the scene', async () => {
    await buildTreeBox();
    await buildTreeBox(20, 20, 30, 30);
    expect(useStore.getState().featureTree.features).toHaveLength(4);
    const firstExtrude = ((await getTool('list_features')!.execute({})) as {
      features: Array<{ id: string; type: string }>;
    }).features.find((f) => f.type === 'extrude')!;

    const r = (await getTool('remove_feature')!.execute({ featureId: firstExtrude.id })) as {
      success: boolean; remainingFeatures: number; bodyCount: number;
    };
    expect(r.success).toBe(true);
    expect(r.remainingFeatures).toBe(3);
    expect(r.bodyCount).toBe(1);
  });

  it('remove_feature with an unknown id returns success:false', async () => {
    const r = (await getTool('remove_feature')!.execute({ featureId: 'feat_missing' })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('set_feature_suppressed toggles a feature off and back on', async () => {
    await buildTreeBox();
    const extrude = ((await getTool('list_features')!.execute({})) as {
      features: Array<{ id: string; type: string }>;
    }).features.find((f) => f.type === 'extrude')!;

    const off = (await getTool('set_feature_suppressed')!.execute({
      featureId: extrude.id, suppressed: true,
    })) as { success: boolean; suppressed: boolean };
    expect(off.success).toBe(true);
    // A suppressed extrude produces no body.
    expect(useStore.getState().bodies).toHaveLength(0);

    const on = (await getTool('set_feature_suppressed')!.execute({
      featureId: extrude.id, suppressed: false,
    })) as { success: boolean };
    expect(on.success).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('set_feature_suppressed with an unknown id returns success:false', async () => {
    const r = (await getTool('set_feature_suppressed')!.execute({ featureId: 'x', suppressed: true })) as { success: boolean };
    expect(r.success).toBe(false);
  });

  it('reorder_feature refuses illegal dependency moves (success:false, tree untouched)', async () => {
    await buildTreeBox();
    await buildTreeBox(20, 20, 30, 30);
    const features = ((await getTool('list_features')!.execute({})) as {
      features: Array<{ id: string; type: string }>;
    }).features;
    // [sketchA, extrudeA, sketchB, extrudeB] — extrudeA depends on sketchA, so
    // pushing sketchA past extrudeA must be refused.
    const sketchA = features.find((f) => f.type === 'sketch')!;
    const orderBefore = useStore.getState().featureTree.features.map((f) => f.id);

    const r = (await getTool('reorder_feature')!.execute({ featureId: sketchA.id, toIndex: 3 })) as {
      success: boolean; reason?: string;
    };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/illegal|dependency|order/i);
    expect(useStore.getState().featureTree.features.map((f) => f.id)).toEqual(orderBefore);
  });

  it('reorder_feature moves an independent feature and reports its new index', async () => {
    await buildTreeBox();
    await buildTreeBox(20, 20, 30, 30);
    const features = ((await getTool('list_features')!.execute({})) as {
      features: Array<{ id: string; type: string }>;
    }).features;
    const sketchB = features.filter((f) => f.type === 'sketch')[1]!;

    const r = (await getTool('reorder_feature')!.execute({ featureId: sketchB.id, toIndex: 0 })) as {
      success: boolean; toIndex: number; order: string[];
    };
    expect(r.success).toBe(true);
    expect(r.toIndex).toBe(0);
    expect(useStore.getState().featureTree.features[0]!.id).toBe(sketchB.id);
    // Both extrusions still evaluate.
    expect(useStore.getState().bodies).toHaveLength(2);
  });

  it('reorder_feature with unknown id / out-of-range index returns success:false', async () => {
    await buildTreeBox();
    const bad = (await getTool('reorder_feature')!.execute({ featureId: 'nope', toIndex: 0 })) as { success: boolean };
    expect(bad.success).toBe(false);
    const range = (await getTool('reorder_feature')!.execute({
      featureId: useStore.getState().featureTree.features[0]!.id, toIndex: 99,
    })) as { success: boolean; reason?: string };
    expect(range.success).toBe(false);
    expect(range.reason).toMatch(/toIndex/i);
  });
});

describe('list_edges tool', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
  });

  it('lists per-edge id, endpoints and length for a box', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const r = (await getTool('list_edges')!.execute({ bodyId: box.id })) as {
      edgeCount: number; truncated: boolean; edges: Array<{ id: string; start: { x: number }; end: { z: number }; length: number }>;
    };
    expect(r.edgeCount).toBe(box.edges.length); // 12 on a box
    expect(r.truncated).toBe(false);
    expect(r.edges).toHaveLength(12);
    expect(r.edges.every((e) => typeof e.id === 'string')).toBe(true);
    expect(r.edges.every((e) => e.length === 10)).toBe(true); // cube edge = 10 mm
    // The ids are exactly the fillet/chamfer addressing surface.
    expect(new Set(r.edges.map((e) => e.id))).toEqual(new Set(box.edges.map((e) => e.id)));
  });

  it('caps the output at 200 edges with truncated=true and the real total', async () => {
    const edges = Array.from({ length: 250 }, (_, i) => ({
      id: `edge_${i}`,
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
    }));
    const big: SolidBody = {
      id: 'big', name: 'Big', vertices: [], faces: [], edges,
    };
    useStore.setState({ bodies: [big], directBodies: [big] });
    const r = (await getTool('list_edges')!.execute({ bodyId: 'big' })) as {
      edgeCount: number; returned: number; truncated: boolean;
    };
    expect(r.edgeCount).toBe(250);
    expect(r.returned).toBe(200);
    expect(r.truncated).toBe(true);
    // A smaller limit is honored but never exceeds the hard cap.
    const small = (await getTool('list_edges')!.execute({ bodyId: 'big', limit: 5 })) as { returned: number };
    expect(small.returned).toBe(5);
    const over = (await getTool('list_edges')!.execute({ bodyId: 'big', limit: 5000 })) as { returned: number };
    expect(over.returned).toBe(200);
  });
});

describe('tree-aware modify routing (fillet/chamfer/shell/arrays/mirror)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.setState({ projectDirty: false });
  });

  it('fillet on a tree body routes to a feature: tree grows, no duplicate body', async () => {
    const bodyId = await buildTreeBox();
    const featuresBefore = useStore.getState().featureTree.features.length;

    const r = (await getTool('fillet')!.execute({ bodyId, radius: 1 })) as {
      success: boolean; mode?: string; featureId?: string; bodyId?: string;
    };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('feature');
    expect(r.featureId).toBeTruthy();
    // The fillet REPLACES the parent's output in the tree — one body, not two.
    expect(useStore.getState().featureTree.features).toHaveLength(featuresBefore + 1);
    expect(useStore.getState().bodies).toHaveLength(1);
    expect(useStore.getState().bodies.some((b) => b.id === r.bodyId)).toBe(true);
    // The new timeline feature is a real fillet and is editable parametrically.
    const listed = (await getTool('list_features')!.execute({})) as { features: Array<{ id: string; type: string; summary: string }> };
    const fillet = listed.features.find((f) => f.id === r.featureId)!;
    expect(fillet.type).toBe('fillet');
    const patched = (await getTool('update_feature')!.execute({ featureId: r.featureId!, params: { radius: 2 } })) as { success: boolean };
    expect(patched.success).toBe(true);

    // The gate: an oversize radius edit is REFUSED and the tool must say so
    // (the store's updateFeature returns false; the tool used to claim success).
    const refused = (await getTool('update_feature')!.execute({ featureId: r.featureId!, params: { radius: 999 } })) as {
      success: boolean; reason?: string;
    };
    expect(refused.success).toBe(false);
    expect(refused.reason).toMatch(/refused|limit/i);
    const feature = useStore.getState().featureTree.getFeature(r.featureId!);
    expect(feature?.type === 'fillet' && feature.params.radius).toBe(2); // unchanged
  });

  it('chamfer on a tree body routes to a feature too', async () => {
    const bodyId = await buildTreeBox();
    const r = (await getTool('chamfer')!.execute({ bodyId, distance: 1 })) as { success: boolean; mode?: string };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('feature');
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('shell on a tree body routes to a feature with the requested open faces', async () => {
    const bodyId = await buildTreeBox(0, 0, 20, 20, 10);
    const faceId = useStore.getState().bodies[0]!.faces[0]!.id;
    const r = (await getTool('shell')!.execute({ bodyId, thickness: 2, faceIds: [faceId] })) as {
      success: boolean; mode?: string; openFaces?: number;
    };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('feature');
    expect(r.openFaces).toBe(1);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('fillet on a direct body keeps the direct path (mode:"direct")', async () => {
    const box = createBox(10, 10, 10);
    useStore.setState({ bodies: [box], directBodies: [box] });
    const r = (await getTool('fillet')!.execute({ bodyId: box.id, radius: 1 })) as {
      success: boolean; mode?: string; bodyId?: string;
    };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('direct');
    expect(useStore.getState().bodies).toHaveLength(1); // replaced in place
    expect(useStore.getState().bodies[0]!.id).toBe(r.bodyId);
  });

  it('direct-edit transform tools refuse tree bodies honestly (replaceBody contract)', async () => {
    const bodyId = await buildTreeBox();
    const cases = [
      ['move_body', { bodyId, offset: { x: 5, y: 0, z: 0 } }],
      ['scale_body', { bodyId, factor: 2 }],
      ['rotate_body', { bodyId, axis: { x: 0, y: 1, z: 0 }, angleDeg: 90 }],
      ['lay_flat', { bodyId }],
      ['center_body', { bodyId }],
    ] as const;
    for (const [name, args] of cases) {
      const r = (await getTool(name)!.execute({ ...args })) as { success: boolean; reason?: string };
      expect(r.success, name).toBe(false);
      expect(r.reason, name).toMatch(/feature tree/i);
    }
    // Nothing was mutated and no duplicate body appeared.
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('linear_array on a tree body routes to the parametric array feature', async () => {
    const bodyId = await buildTreeBox();
    const r = (await getTool('linear_array')!.execute({
      bodyId, direction: { x: 1, y: 0, z: 0 }, count: 3, spacing: 30,
    })) as { success: boolean; mode?: string; count?: number };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('feature');
    // Parametric count semantics: count = TOTAL instances.
    expect(useStore.getState().bodies).toHaveLength(3);
    expect(allDistinct(centroids())).toBe(true);
  });

  it('linear_array on a tree body refuses non-axis directions honestly', async () => {
    const bodyId = await buildTreeBox();
    const bodiesBefore = useStore.getState().bodies.map((b) => b.id);
    const r = (await getTool('linear_array')!.execute({
      bodyId, direction: { x: 1, y: 1, z: 0 }, count: 3, spacing: 30,
    })) as { success: boolean; reason?: string; mode?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/feature tree/i);
    expect(useStore.getState().bodies.map((b) => b.id)).toEqual(bodiesBefore);
  });

  it('circular_array on a tree body routes to the feature only for the canonical axis', async () => {
    const bodyId = await buildTreeBox();
    const center = bboxCenter(useStore.getState().bodies[0]!);
    const ok = (await getTool('circular_array')!.execute({
      bodyId, axis: { origin: center, direction: { x: 0, y: 0, z: 1 } }, count: 3,
    })) as { success: boolean; mode?: string };
    expect(ok.success).toBe(true);
    expect(ok.mode).toBe('feature');
    expect(useStore.getState().bodies).toHaveLength(3);

    const refused = (await getTool('circular_array')!.execute({
      bodyId: useStore.getState().bodies[0]!.id, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, count: 3,
    })) as { success: boolean; reason?: string };
    expect(refused.success).toBe(false);
    expect(refused.reason).toMatch(/feature tree/i);
  });

  it('mirror on a tree body with a world plane through its centre routes to the feature', async () => {
    const bodyId = await buildTreeBox();
    const center = bboxCenter(useStore.getState().bodies[0]!);
    const r = (await getTool('mirror')!.execute({
      bodyId, plane: { origin: center, normal: { x: 0, y: 0, z: 1 } },
    })) as { success: boolean; mode?: string; keepOriginal?: boolean };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('feature');
    expect(r.keepOriginal).toBe(true);
    expect(useStore.getState().bodies).toHaveLength(2); // original + reflection
  });

  it('oversize fillet on a TREE body is refused before the feature is applied', async () => {
    const bodyId = await buildTreeBox(); // 10×10×5 prism → all-edges fillet max 2.5
    const featuresBefore = useStore.getState().featureTree.features.length;
    const bodiesBefore = useStore.getState().bodies.map((b) => b.id);
    const undoBefore = useStore.getState().undoStack.length;

    const r = (await getTool('fillet')!.execute({ bodyId, radius: 4 })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/too large/i);
    expect(r.reason).toMatch(/max 2\.5 mm/);
    // The guard runs BEFORE routing: no feature appended, no body change, no
    // selection side effects and no undo entry.
    expect(useStore.getState().featureTree.features).toHaveLength(featuresBefore);
    expect(useStore.getState().bodies.map((b) => b.id)).toEqual(bodiesBefore);
    expect(useStore.getState().selectedEdgeIds).toHaveLength(0);
    expect(useStore.getState().undoStack).toHaveLength(undoBefore);

    // A chamfer over the same limit is likewise refused on the tree path.
    const c = (await getTool('chamfer')!.execute({ bodyId, distance: 3 })) as { success: boolean; reason?: string };
    expect(c.success).toBe(false);
    expect(c.reason).toMatch(/max 2\.5 mm/);
    expect(useStore.getState().featureTree.features).toHaveLength(featuresBefore);
  });
});

describe('array count semantics (direct bodies)', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
  });

  it('linear_array count=4 ends with EXACTLY 4 bodies, all at distinct centroids (was 5)', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const r = (await getTool('linear_array')!.execute({
      bodyId: created.bodyId, direction: { x: 1, y: 0, z: 0 }, count: 4, spacing: 20,
    })) as { success: boolean; mode?: string; count?: number; added?: number };
    expect(r.success).toBe(true);
    expect(r.mode).toBe('direct');
    expect(useStore.getState().bodies).toHaveLength(4);
    expect(r.added).toBe(3); // the original + 3 copies
    expect(allDistinct(centroids())).toBe(true);
  });

  it('grid_array 3×2 ends with EXACTLY 6 bodies at distinct centroids', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const r = (await getTool('grid_array')!.execute({
      bodyId: created.bodyId,
      direction1: { x: 1, y: 0, z: 0 }, count1: 3, spacing1: 20,
      direction2: { x: 0, y: 0, z: 1 }, count2: 2, spacing2: 20,
    })) as { success: boolean; count?: number };
    expect(r.success).toBe(true);
    expect(r.count).toBe(6);
    expect(useStore.getState().bodies).toHaveLength(6);
    expect(allDistinct(centroids())).toBe(true);
  });

  it('circular_array count=3 ends with EXACTLY 3 bodies at distinct centroids', async () => {
    const created = (await getTool('create_box')!.execute({ width: 4, height: 4, depth: 10 })) as { bodyId: string };
    const r = (await getTool('circular_array')!.execute({
      bodyId: created.bodyId, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, count: 3,
    })) as { success: boolean; added?: number };
    expect(r.success).toBe(true);
    expect(r.added).toBe(2);
    expect(useStore.getState().bodies).toHaveLength(3);
    expect(allDistinct(centroids())).toBe(true);
  });

  it('linear_array count=1 is a no-op with exactly 1 body (the original)', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const r = (await getTool('linear_array')!.execute({
      bodyId: created.bodyId, direction: { x: 1, y: 0, z: 0 }, count: 1, spacing: 20,
    })) as { success: boolean; added?: number };
    expect(r.success).toBe(true);
    expect(r.added).toBe(0);
    expect(useStore.getState().bodies).toHaveLength(1);
  });

  it('rejects non-positive counts and spacings up front', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    for (const args of [
      { count: 0, spacing: 10 },
      { count: 2.5, spacing: 10 },
      { count: 2, spacing: 0 },
    ]) {
      const r = (await getTool('linear_array')!.execute({
        bodyId: created.bodyId, direction: { x: 1, y: 0, z: 0 }, ...args,
      })) as { success: boolean; reason?: string };
      expect(r.success, JSON.stringify(args)).toBe(false);
    }
    expect(useStore.getState().bodies).toHaveLength(1);
  });
});

describe('sketch read-back tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    const st = useStore.getState();
    st.setSketchActive(true);
    st.setCurrentSketch(createSketch('xy'));
  });

  it('list_sketch_entities shows drawn entities with their key parameters', async () => {
    const st = useStore.getState();
    const circle = st.addSketchCircle(2, 3, 5);
    const line = st.addSketchLine(0, 0, 10, 0);

    const r = (await getTool('list_sketch_entities')!.execute({})) as {
      entities: Array<{ id: string; type: string; center?: { x: number; y: number } | null; radius?: number; p1?: { x: number; y: number } | null; p2?: { x: number; y: number } | null }>;
      constraints: unknown[];
    };
    const c = r.entities.find((e) => e.id === circle);
    expect(c?.type).toBe('circle');
    expect(c?.center).toEqual({ x: 2, y: 3 });
    expect(c?.radius).toBe(5);
    const l = r.entities.find((e) => e.id === line);
    expect(l?.type).toBe('line');
    expect(l?.p1).toEqual({ x: 0, y: 0 });
    expect(l?.p2).toEqual({ x: 10, y: 0 });
    expect(r.constraints).toEqual([]);
  });

  it('list_sketch_entities includes constraints with ids, values and the editable flag', async () => {
    const st = useStore.getState();
    const circle = st.addSketchCircle(0, 0, 5);
    st.addSketchConstraint('radius', [circle], 5);
    st.addSketchConstraint('horizontal', [circle]);

    const r = (await getTool('list_sketch_entities')!.execute({})) as {
      constraints: Array<{ id: string; type: string; value?: number; editable: boolean }>;
    };
    const radius = r.constraints.find((c) => c.type === 'radius')!;
    expect(radius.value).toBe(5);
    expect(radius.editable).toBe(true);
    const horizontal = r.constraints.find((c) => c.type === 'horizontal')!;
    expect(horizontal.editable).toBe(false);
  });

  it('update_sketch_constraint changes a driving radius and the circle follows', async () => {
    const st = useStore.getState();
    const circle = st.addSketchCircle(0, 0, 5);
    st.addSketchConstraint('radius', [circle], 5);

    const listed = (await getTool('list_sketch_entities')!.execute({})) as {
      constraints: Array<{ id: string; type: string; editable: boolean }>;
    };
    const constraintId = listed.constraints.find((c) => c.type === 'radius' && c.editable)!.id;

    const r = (await getTool('update_sketch_constraint')!.execute({ constraintId, value: 8 })) as {
      success: boolean; previousValue?: number; value?: number;
    };
    expect(r.success).toBe(true);
    expect(r.previousValue).toBe(5);
    expect(r.value).toBe(8);
    // "resize the circle to R8" happened without redrawing.
    const entity = useStore.getState().currentSketch!.entities.get(circle);
    expect(entity?.type === 'circle' && entity.radius).toBeCloseTo(8, 9);
  });

  it('update_sketch_constraint refuses unknown ids and non-dimensional constraints', async () => {
    const st = useStore.getState();
    const line = st.addSketchLine(0, 0, 10, 0);
    st.addSketchConstraint('horizontal', [line]);
    const listed = (await getTool('list_sketch_entities')!.execute({})) as {
      constraints: Array<{ id: string; type: string }>;
    };
    const horizontal = listed.constraints.find((c) => c.type === 'horizontal')!;

    const unknown = (await getTool('update_sketch_constraint')!.execute({ constraintId: 'c_missing', value: 5 })) as { success: boolean; reason?: string };
    expect(unknown.success).toBe(false);
    expect(unknown.reason).toMatch(/not found/i);

    const notDim = (await getTool('update_sketch_constraint')!.execute({ constraintId: horizontal.id, value: 5 })) as { success: boolean; reason?: string };
    expect(notDim.success).toBe(false);
    expect(notDim.reason).toMatch(/distance\/radius/);
  });

  it('list_sketch_entities throws without an active sketch', async () => {
    useStore.getState().setCurrentSketch(null);
    await expect(getTool('list_sketch_entities')!.execute({})).rejects.toThrow(/No active sketch/);
  });
});

describe('workspace + body management tools', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
  });

  it('set_workspace switches between the four workspaces', async () => {
    for (const mode of ['sketch', 'drawing', 'cam', 'model'] as const) {
      const r = (await getTool('set_workspace')!.execute({ mode })) as { success: boolean; workspace: string };
      expect(r.success).toBe(true);
      expect(r.workspace).toBe(mode);
      expect(useStore.getState().workspace).toBe(mode);
    }
  });

  it('set_workspace rejects an unknown mode', async () => {
    await expect(getTool('set_workspace')!.execute({ mode: 'render' })).rejects.toThrow();
  });

  it('set_body_hidden hides and shows a body (round-trip, undoable)', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const hide = (await getTool('set_body_hidden')!.execute({ bodyId: created.bodyId, hidden: true })) as { success: boolean; changed: boolean };
    expect(hide.success).toBe(true);
    expect(hide.changed).toBe(true);
    expect(useStore.getState().hiddenIds).toContain(created.bodyId);

    const idempotent = (await getTool('set_body_hidden')!.execute({ bodyId: created.bodyId, hidden: true })) as { changed: boolean };
    expect(idempotent.changed).toBe(false);

    const show = (await getTool('set_body_hidden')!.execute({ bodyId: created.bodyId, hidden: false })) as { changed: boolean };
    expect(show.changed).toBe(true);
    expect(useStore.getState().hiddenIds).not.toContain(created.bodyId);
  });

  it('set_body_hidden with an unknown id returns success:false without touching history', async () => {
    useStore.setState({ undoStack: [] });
    const r = (await getTool('set_body_hidden')!.execute({ bodyId: 'ghost', hidden: true })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/not found/i);
    expect(useStore.getState().undoStack).toHaveLength(0); // no junk undo entry
  });

  it('rename_body round-trips a direct body and reports the change', async () => {
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const r = (await getTool('rename_body')!.execute({ bodyId: created.bodyId, name: 'Mounting Plate' })) as {
      success: boolean; name: string; changed: boolean;
    };
    expect(r.success).toBe(true);
    expect(r.changed).toBe(true);
    expect(useStore.getState().bodies[0]!.name).toBe('Mounting Plate');

    // Renaming to the same name is an idempotent success.
    const same = (await getTool('rename_body')!.execute({ bodyId: created.bodyId, name: 'Mounting Plate' })) as { changed: boolean };
    expect(same.changed).toBe(false);
  });

  it('rename_body refuses unknown ids, blank names, and tree-produced bodies', async () => {
    const missing = (await getTool('rename_body')!.execute({ bodyId: 'ghost', name: 'X' })) as { success: boolean };
    expect(missing.success).toBe(false);
    const created = (await getTool('create_box')!.execute({ width: 10, height: 10, depth: 10 })) as { bodyId: string };
    const blank = (await getTool('rename_body')!.execute({ bodyId: created.bodyId, name: '   ' })) as { success: boolean };
    expect(blank.success).toBe(false);

    const st = useStore.getState();
    st.setSketchActive(true);
    st.setCurrentSketch(createSketch('xz'));
    st.addSketchRect(0, 0, 10, 10);
    await getTool('extrude')!.execute({ distance: 5 });
    const treeBody = useStore.getState().bodies.find((b) => b.id !== created.bodyId)!;
    const tree = (await getTool('rename_body')!.execute({ bodyId: treeBody.id, name: 'Nope' })) as { success: boolean; reason?: string };
    expect(tree.success).toBe(false);
    expect(tree.reason).toMatch(/feature tree/i);
  });
});

describe('loop mechanics guards', () => {
  beforeEach(() => {
    clearTools();
    registerBuiltinTools();
    useStore.getState().clearScene();
    useStore.setState({ projectDirty: false });
  });

  it('export_body returns bytes + preview but NEVER inline content', async () => {
    const created = (await getTool('create_box')!.execute({ width: 20, height: 20, depth: 20 })) as { bodyId: string };
    for (const format of ['stl', 'obj', '3mf', 'step'] as const) {
      const r = (await getTool('export_body')!.execute({ bodyId: created.bodyId, format })) as {
        bytes: number; preview?: string; content?: string; note?: string;
      };
      expect(r.content).toBeUndefined();
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.preview!.length).toBeLessThanOrEqual(200);
      expect(r.note).toMatch(/not inlined/i);
    }
  });

  it('load_sample_project refuses while the project is dirty — without arming the confirm dialog', async () => {
    useStore.setState({ projectDirty: true });
    const bodiesBefore = useStore.getState().bodies.length;
    const r = (await getTool('load_sample_project')!.execute({
      sample_id: SAMPLE_PROJECTS[0]!.id,
    })) as { success: boolean; reason?: string };
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/unsaved/i);
    // The guard fired BEFORE loadSampleProject — no dialog is pending (had it
    // fired, the tool call would hang awaiting a user click).
    expect(getPendingConfirm()).toBeNull();
    expect(useStore.getState().bodies).toHaveLength(bodiesBefore);
  });

  it('load_sample_project loads a sample on a clean project', async () => {
    const r = (await getTool('load_sample_project')!.execute({
      sample_id: SAMPLE_PROJECTS[0]!.id,
    })) as { success: boolean; sampleId: string };
    expect(r.success).toBe(true);
    expect(useStore.getState().bodies.length).toBeGreaterThan(0);
  });

  it('the AI panel passes the raised iteration budget (32) to the tool loop', () => {
    // No component render harness exists for the panel — pin the call-site
    // contract at the source level instead (client.test.ts covers the loop
    // itself, including the raised default).
    const src = readFileSync(join(__dirname, '../../components/panels/AIPanel.tsx'), 'utf-8');
    expect(src).toMatch(/sendMessageWithTools\s*\(/);
    expect(src).toMatch(/maxIterations:\s*32/);
  });
});
