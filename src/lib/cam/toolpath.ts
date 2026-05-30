import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import type { SolidBody, Vec3 } from '../geometry/types';
import { convexHull2D } from '../geometry/convexHull';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/**
 * Ordered move recorder. Toolpaths interleave rapids and cuts (rapid → plunge →
 * cut → retract → …); keeping a single ordered list preserves that sequence so
 * the emitted G-code matches the real tool motion. rapidMoves/cuttingMoves are
 * derived by filtering, for any consumer that wants them split.
 */
class MoveList {
  readonly points: ToolpathPoint[] = [];
  rapid(p: { x: number; y: number; z: number }): void {
    this.points.push({ ...p, rapid: true });
  }
  cut(p: { x: number; y: number; z: number; feedRate?: number }): void {
    this.points.push({ ...p, rapid: false });
  }
  get rapidMoves(): ToolpathPoint[] {
    return this.points.filter((m) => m.rapid);
  }
  get cuttingMoves(): ToolpathPoint[] {
    return this.points.filter((m) => !m.rapid);
  }
}

/** Generate a pocket toolpath for a rectangular area */
export function generatePocketToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList();

  const { min, max } = bounds;
  const stepover = Math.min(params.stepover, tool.diameter * 0.4);
  const safeZ = params.stockTop + 5;
  const doc = Math.max(params.depthOfCut, 0.01); // prevent infinite loop

  let currentZ = params.stockTop;

  while (currentZ > params.stockBottom) {
    currentZ = Math.max(currentZ - doc, params.stockBottom);

    // Zigzag pattern
    let y = min.y + tool.diameter / 2;
    let forward = true;

    while (y <= max.y - tool.diameter / 2) {
      if (forward) {
        // Rapid to start, plunge, cut across
        m.rapid({ x: min.x + tool.diameter / 2, y, z: safeZ });
        m.cut({ x: min.x + tool.diameter / 2, y, z: currentZ });
        m.cut({ x: max.x - tool.diameter / 2, y, z: currentZ });
      } else {
        m.rapid({ x: max.x - tool.diameter / 2, y, z: safeZ });
        m.cut({ x: max.x - tool.diameter / 2, y, z: currentZ });
        m.cut({ x: min.x + tool.diameter / 2, y, z: currentZ });
      }

      forward = !forward;
      y += stepover;
    }

    // Retract
    m.rapid({ x: min.x, y: min.y, z: safeZ });
  }

  return {
    id: genId('tp'),
    name: `Pocket ${bounds.min.x.toFixed(0)},${bounds.min.y.toFixed(0)}`,
    operation: 'pocket',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

/** Generate a contour toolpath around a body's outline */
export function generateContourToolpath(
  body: SolidBody,
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList();

  const safeZ = params.stockTop + 5;

  // Get outline from top view (XY plane)
  const outline = getOutlineXY(body);

  if (outline.length < 2) {
    return {
      id: genId('tp'),
      name: `Contour ${body.name}`,
      operation: 'contour',
      tool,
      params,
      points: [],
      rapidMoves: [],
      cuttingMoves: [],
    };
  }

  let currentZ = params.stockTop;
  const contourDoc = Math.max(params.depthOfCut, 0.01);

  while (currentZ > params.stockBottom) {
    currentZ = Math.max(currentZ - contourDoc, params.stockBottom);

    // Rapid to start, plunge
    const start = outline[0]!;
    m.rapid({ x: start.x, y: start.y, z: safeZ });
    m.cut({ x: start.x, y: start.y, z: currentZ });

    // Follow outline
    for (let i = 1; i < outline.length; i++) {
      const pt = outline[i]!;
      m.cut({ x: pt.x, y: pt.y, z: currentZ });
    }

    // Close loop
    m.cut({ x: start.x, y: start.y, z: currentZ });

    // Retract
    m.rapid({ x: start.x, y: start.y, z: safeZ });
  }

  return {
    id: genId('tp'),
    name: `Contour ${body.name}`,
    operation: 'contour',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

/** Generate drill toolpath for a list of hole positions */
export function generateDrillToolpath(
  holes: Array<{ x: number; y: number; depth: number }>,
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList();

  const safeZ = params.stockTop + 5;
  const retractZ = params.stockTop + 2;

  for (const hole of holes) {
    // Rapid to hole position
    m.rapid({ x: hole.x, y: hole.y, z: safeZ });
    // Plunge: depth is measured down from the stock surface, not absolute Z.
    m.cut({ x: hole.x, y: hole.y, z: params.stockTop - hole.depth });
    // Retract
    m.rapid({ x: hole.x, y: hole.y, z: retractZ });
  }

  // Final retract
  m.rapid({ x: 0, y: 0, z: safeZ });

  return {
    id: genId('tp'),
    name: `Drill ${holes.length} holes`,
    operation: 'drill',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

/** Generate face milling toolpath */
export function generateFaceToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const m = new MoveList();

  const { min, max } = bounds;
  const stepover = tool.diameter * 0.6;
  const safeZ = params.stockTop + 5;
  const faceZ = params.stockTop - params.depthOfCut;

  let y = min.y;
  let forward = true;

  while (y <= max.y) {
    if (forward) {
      m.rapid({ x: min.x - tool.diameter, y, z: safeZ });
      m.cut({ x: min.x - tool.diameter, y, z: faceZ });
      m.cut({ x: max.x + tool.diameter, y, z: faceZ });
    } else {
      m.rapid({ x: max.x + tool.diameter, y, z: safeZ });
      m.cut({ x: max.x + tool.diameter, y, z: faceZ });
      m.cut({ x: min.x - tool.diameter, y, z: faceZ });
    }

    forward = !forward;
    y += stepover;
  }

  m.rapid({ x: 0, y: 0, z: safeZ });

  return {
    id: genId('tp'),
    name: 'Face Mill',
    operation: 'face',
    tool,
    params,
    points: m.points,
    rapidMoves: m.rapidMoves,
    cuttingMoves: m.cuttingMoves,
  };
}

function getOutlineXY(body: SolidBody): Array<{ x: number; y: number }> {
  // Simple outline extraction: collect all unique XY points from edges
  const points: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();

  for (const edge of body.edges) {
    const key1 = `${edge.start.x.toFixed(4)},${edge.start.y.toFixed(4)}`;
    const key2 = `${edge.end.x.toFixed(4)},${edge.end.y.toFixed(4)}`;

    if (!seen.has(key1)) {
      seen.add(key1);
      points.push({ x: edge.start.x, y: edge.start.y });
    }
    if (!seen.has(key2)) {
      seen.add(key2);
      points.push({ x: edge.end.x, y: edge.end.y });
    }
  }

  // Order into the outer outline via a 2D convex hull. Sorting by angle from
  // the centroid (the old approach) self-intersects for non-convex point sets;
  // the hull is always a simple, non-crossing closed loop to cut around.
  return convexHull2D(points);
}
