import type { Toolpath, ToolpathPoint, CAMParameters, ToolDefinition } from './types';
import type { SolidBody, Vec3 } from '../geometry/types';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/** Generate a pocket toolpath for a rectangular area */
export function generatePocketToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const rapidMoves: ToolpathPoint[] = [];
  const cuttingMoves: ToolpathPoint[] = [];

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
        // Rapid to start
        rapidMoves.push({ x: min.x + tool.diameter / 2, y, z: safeZ });
        // Plunge
        cuttingMoves.push({ x: min.x + tool.diameter / 2, y, z: currentZ });
        // Cut across
        cuttingMoves.push({ x: max.x - tool.diameter / 2, y, z: currentZ });
      } else {
        rapidMoves.push({ x: max.x - tool.diameter / 2, y, z: safeZ });
        cuttingMoves.push({ x: max.x - tool.diameter / 2, y, z: currentZ });
        cuttingMoves.push({ x: min.x + tool.diameter / 2, y, z: currentZ });
      }

      forward = !forward;
      y += stepover;
    }

    // Retract
    rapidMoves.push({ x: min.x, y: min.y, z: safeZ });
  }

  return {
    id: genId('tp'),
    name: `Pocket ${bounds.min.x.toFixed(0)},${bounds.min.y.toFixed(0)}`,
    operation: 'pocket',
    tool,
    params,
    points: [...rapidMoves, ...cuttingMoves],
    rapidMoves,
    cuttingMoves,
  };
}

/** Generate a contour toolpath around a body's outline */
export function generateContourToolpath(
  body: SolidBody,
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const rapidMoves: ToolpathPoint[] = [];
  const cuttingMoves: ToolpathPoint[] = [];

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

    // Rapid to start
    const start = outline[0]!;
    rapidMoves.push({ x: start.x, y: start.y, z: safeZ });
    cuttingMoves.push({ x: start.x, y: start.y, z: currentZ });

    // Follow outline
    for (let i = 1; i < outline.length; i++) {
      const pt = outline[i]!;
      cuttingMoves.push({ x: pt.x, y: pt.y, z: currentZ });
    }

    // Close loop
    cuttingMoves.push({ x: start.x, y: start.y, z: currentZ });

    // Retract
    rapidMoves.push({ x: start.x, y: start.y, z: safeZ });
  }

  return {
    id: genId('tp'),
    name: `Contour ${body.name}`,
    operation: 'contour',
    tool,
    params,
    points: [...rapidMoves, ...cuttingMoves],
    rapidMoves,
    cuttingMoves,
  };
}

/** Generate drill toolpath for a list of hole positions */
export function generateDrillToolpath(
  holes: Array<{ x: number; y: number; depth: number }>,
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const rapidMoves: ToolpathPoint[] = [];
  const cuttingMoves: ToolpathPoint[] = [];

  const safeZ = params.stockTop + 5;
  const retractZ = params.stockTop + 2;

  for (const hole of holes) {
    // Rapid to hole position
    rapidMoves.push({ x: hole.x, y: hole.y, z: safeZ });
    // Plunge
    cuttingMoves.push({ x: hole.x, y: hole.y, z: -hole.depth });
    // Retract
    rapidMoves.push({ x: hole.x, y: hole.y, z: retractZ });
  }

  // Final retract
  rapidMoves.push({ x: 0, y: 0, z: safeZ });

  return {
    id: genId('tp'),
    name: `Drill ${holes.length} holes`,
    operation: 'drill',
    tool,
    params,
    points: [...rapidMoves, ...cuttingMoves],
    rapidMoves,
    cuttingMoves,
  };
}

/** Generate face milling toolpath */
export function generateFaceToolpath(
  bounds: { min: Vec3; max: Vec3 },
  tool: ToolDefinition,
  params: CAMParameters,
): Toolpath {
  const rapidMoves: ToolpathPoint[] = [];
  const cuttingMoves: ToolpathPoint[] = [];

  const { min, max } = bounds;
  const stepover = tool.diameter * 0.6;
  const safeZ = params.stockTop + 5;
  const faceZ = params.stockTop - params.depthOfCut;

  let y = min.y;
  let forward = true;

  while (y <= max.y) {
    if (forward) {
      rapidMoves.push({ x: min.x - tool.diameter, y, z: safeZ });
      cuttingMoves.push({ x: min.x - tool.diameter, y, z: faceZ });
      cuttingMoves.push({ x: max.x + tool.diameter, y, z: faceZ });
    } else {
      rapidMoves.push({ x: max.x + tool.diameter, y, z: safeZ });
      cuttingMoves.push({ x: max.x + tool.diameter, y, z: faceZ });
      cuttingMoves.push({ x: min.x - tool.diameter, y, z: faceZ });
    }

    forward = !forward;
    y += stepover;
  }

  rapidMoves.push({ x: 0, y: 0, z: safeZ });

  return {
    id: genId('tp'),
    name: 'Face Mill',
    operation: 'face',
    tool,
    params,
    points: [...rapidMoves, ...cuttingMoves],
    rapidMoves,
    cuttingMoves,
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

  // Sort by angle from centroid for a reasonable outline order
  if (points.length < 3) return points;

  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  points.sort((a, b) => {
    const angleA = Math.atan2(a.y - cy, a.x - cx);
    const angleB = Math.atan2(b.y - cy, b.x - cx);
    return angleA - angleB;
  });

  return points;
}
