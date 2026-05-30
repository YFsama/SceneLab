export interface ToolDefinition {
  id: string;
  name: string;
  type: 'endmill' | 'ballmill' | 'vbit' | 'drill';
  diameter: number; // mm
  fluteLength: number; // mm
  overallLength: number; // mm
  flutes: number;
  material: 'carbide' | 'hss' | 'cobalt';
}

export interface CAMParameters {
  feedRate: number; // mm/min
  plungeRate: number; // mm/min
  spindleSpeed: number; // RPM
  depthOfCut: number; // mm
  stepover: number; // mm
  stockTop: number; // Z top of stock
  stockBottom: number; // Z bottom of stock
}

export interface ToolpathPoint {
  x: number;
  y: number;
  z: number;
  feedRate?: number;
  /** True for a G0 rapid positioning move, false/undefined for a G1 cut. */
  rapid?: boolean;
}

export interface Toolpath {
  id: string;
  name: string;
  operation: 'pocket' | 'contour' | 'drill' | 'face';
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
