export interface Vec2 {
  x: number;
  y: number;
}

export type SketchEntityType = 'point' | 'line' | 'circle' | 'arc' | 'rectangle';

export interface SketchPoint {
  id: string;
  type: 'point';
  x: number;
  y: number;
  /** Construction geometry: used for reference only, not included in extrude/revolve profiles. */
  construction?: boolean;
}

export interface SketchLine {
  id: string;
  type: 'line';
  p1Id: string;
  p2Id: string;
  construction?: boolean;
}

export interface SketchCircle {
  id: string;
  type: 'circle';
  centerId: string;
  radius: number;
  construction?: boolean;
}

export interface SketchArc {
  id: string;
  type: 'arc';
  centerId: string;
  startAngle: number;
  endAngle: number;
  radius: number;
  construction?: boolean;
}

export interface SketchRectangle {
  id: string;
  type: 'rectangle';
  p1Id: string;
  p2Id: string;
  p3Id: string;
  p4Id: string;
  construction?: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc | SketchRectangle;

export type ConstraintType =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'coincident'
  | 'fixed'
  | 'equal'
  | 'distance'
  | 'radius'
  | 'concentric';

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  value?: number; // for distance constraint
}

export interface SketchPlane {
  origin: Vec2;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Sketch {
  id: string;
  planeId: string; // which face/plane this sketch is on
  entities: Map<string, SketchEntity>;
  constraints: Map<string, SketchConstraint>;
}
