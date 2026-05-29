import type { SolidBody, ExtrudeParams } from '../geometry/types';
import type { Sketch } from '../sketch/types';

export type FeatureType = 'sketch' | 'extrude' | 'revolve' | 'fillet' | 'chamfer' | 'shell';

export interface FeatureBase {
  id: string;
  type: FeatureType;
  name: string;
  suppressed: boolean;
  parentIds: string[]; // features this depends on
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  sketch: Sketch;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  params: ExtrudeParams;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  params: {
    angle: number;
  };
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  params: {
    edgeIds: string[];
    radius: number;
  };
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  params: {
    edgeIds: string[];
    distance: number;
  };
}

export interface ShellFeature extends FeatureBase {
  type: 'shell';
  params: {
    faceIds: string[];
    thickness: number;
  };
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature;

export interface FeatureResult {
  bodies: SolidBody[];
  error?: string;
}
