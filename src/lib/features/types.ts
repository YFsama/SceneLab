import type { SolidBody, ExtrudeParams, Vec3 } from '../geometry/types';
import type { Sketch } from '../sketch/types';

export type FeatureType =
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'linearArray'
  | 'circularArray'
  | 'mirror';

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

export interface LinearArrayFeature extends FeatureBase {
  type: 'linearArray';
  params: {
    direction: Vec3;
    count: number;
    spacing: number;
  };
}

export interface CircularArrayFeature extends FeatureBase {
  type: 'circularArray';
  params: {
    axis: { origin: Vec3; direction: Vec3 };
    count: number;
  };
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  params: {
    plane: { origin: Vec3; normal: Vec3 };
    /** Keep the original body alongside the reflected copy (default true). */
    keepOriginal?: boolean;
  };
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | LinearArrayFeature
  | CircularArrayFeature
  | MirrorFeature;

export interface FeatureResult {
  bodies: SolidBody[];
  error?: string;
}
