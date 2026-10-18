export interface ToolDefinition {
  id: string;
  name: string;
  type: 'endmill' | 'ballmill' | 'vbit' | 'drill';
  diameter: number; // mm
  fluteLength: number; // mm
  overallLength: number; // mm
  flutes: number;
  material: 'carbide' | 'hss' | 'cobalt';
  /** Included tip angle for vbit tools (degrees). Undefined for non-tapered tools. */
  tipAngleDeg?: number;
  /** Flat tip diameter for vbit tools (mm); 0/undefined = sharp tip. */
  tipFlat?: number;
}

export interface CAMParameters {
  feedRate: number; // mm/min
  plungeRate: number; // mm/min
  spindleSpeed: number; // RPM
  depthOfCut: number; // mm
  stepover: number; // mm
  stockTop: number; // Z top of stock
  stockBottom: number; // Z bottom of stock
  /** Finish stock left on walls for pocket/contour (mm, default 0). */
  allowance?: number;
  /** Drill peck increment (mm). Default: max(0.5, tool.diameter / 2). */
  peckDepth?: number;
  /** Traverse height above the stock top (mm); seeded from
   * CAMSetup.safeZAboveStock when the panel adds an op. Default 5. */
  safeZAboveStock?: number;
  /** Contour cut direction (M3 spindle). Climb = outer loops CCW + islands CW; conventional reverses both. Default 'climb'. */
  direction?: 'climb' | 'conventional';
  /** Contour holding tabs, evenly spaced per closed loop by arc length. height is above the FINAL cut level; width is arc length along the path including ramps. */
  tabs?: { count: number; height: number; width: number };
  /** One extra full loop at the final depth after the last cutting pass (Fusion-style spring pass). Default false. */
  springPass?: boolean;
  /** First-level entry descends along the path instead of a vertical plunge. Default false (legacy behavior). */
  rampEntry?: boolean;
  /** Pocket clearing pattern: 'raster' zigzag (default, legacy) or 'offset' contour-parallel rings (concave outlines and islands included via region offsetting). */
  pocketStrategy?: 'raster' | 'offset';
  /** Pocket entry: descend along a validated helical loop instead of the linear ramp / vertical plunge. Default false (legacy). */
  helixEntry?: boolean;
  /** Pocket wall finish: one extra loop along the wall-side boundary at each level after clearing it. Default false. */
  wallFinishPass?: boolean;
  /** Drill cycle variant (post-processor reads this): 'peck' default, 'simple' single plunge, 'dwell' pause at depth. */
  drillCycle?: 'peck' | 'simple' | 'dwell';
  /** Dwell seconds for drillCycle 'dwell' (post clamps 0.01–5, default 0.5). */
  dwellSeconds?: number;
  /** Engrave target depth below stockTop (mm). Default: depthOfCut (single pass). Steps down by depthOfCut when deeper. */
  engraveDepth?: number;
}

/**
 * The cutting tool as seen by the setup/generation layer. An alias of
 * ToolDefinition so older code and the setup contracts can share one shape.
 */
export type CuttingTool = ToolDefinition;

/**
 * A toolpath point, stored in SCENE coordinates (Y-up):
 *   x = plan axis U (body x), y = height above the table (machine Z),
 *   z = plan axis V (body z).
 * Generators plan in the body's XZ plane and set y = stockTop − depth, so the
 * plunge axis is always `y`. The G-code post-processor emits machine
 * X = x, Y = z, Z = y; renderers use the points verbatim.
 */
export interface ToolpathPoint {
  x: number;
  y: number;
  z: number;
  feedRate?: number;
  /** True for a G0 rapid positioning move, false/undefined for a G1 cut. */
  rapid?: boolean;
  /**
   * The move from the PREVIOUS point to this one is a true circular arc
   * (ground truth recovered from an analytic cylinder face tag — see
   * cam/arcSources), not a discretized polyline. `center` is in scene
   * coordinates (y = the constant layer height, so the arc lives in the
   * (x, z) planning plane the post maps to machine XY/G17); `ccw` is the
   * direction in that (x, z) plane. Additive on purpose: consumers that
   * treat points as a polyline keep working verbatim (a chord understates
   * the arc but never inverts the motion), while the post-processor
   * (fitArcs passthrough → G2/G3), the preview sampler, the simulator and
   * the time estimate all upgrade to read it.
   */
  arcTo?: { center: { x: number; y: number; z: number }; ccw: boolean };
}

export interface Toolpath {
  id: string;
  name: string;
  operation: 'pocket' | 'contour' | 'drill' | 'face' | 'engrave';
  tool: ToolDefinition;
  params: CAMParameters;
  points: ToolpathPoint[];
  rapidMoves: ToolpathPoint[]; // G0 moves
  cuttingMoves: ToolpathPoint[]; // G1 moves
}

export interface GCodeLine {
  code: string;
  comment?: string;
}
