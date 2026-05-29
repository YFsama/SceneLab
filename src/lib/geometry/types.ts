export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Face {
  id: string;
  vertices: Vec3[];
  normal: Vec3;
}

export interface Edge {
  id: string;
  start: Vec3;
  end: Vec3;
}

export interface SolidBody {
  id: string;
  name: string;
  vertices: Vec3[];
  faces: Face[];
  edges: Edge[];
}

export interface ExtrudeParams {
  profile: Vec3[]; // 2D profile points (in sketch plane)
  direction: Vec3; // extrude direction
  distance: number;
  symmetric?: boolean;
}

export interface RevolveParams {
  profile: Vec3[];
  axis: { origin: Vec3; direction: Vec3 };
  angle: number; // radians
}

export interface PlaneDefinition {
  id: string;
  name: string;
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}
