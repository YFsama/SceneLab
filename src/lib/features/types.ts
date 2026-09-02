import type { SolidBody, ExtrudeParams, Vec3 } from '../geometry/types';
import type { Sketch } from '../sketch/types';

export type FeatureType =
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'sweep'
  | 'loft'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'scale'
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

/** Sweep the parent sketch's profile along an explicit 3D path. */
export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  params: {
    path: Vec3[];
    /** Cumulative twist in radians from the first to the last path point. */
    twist: number;
    /** Fallback profile (2D sketch coordinates) when the feature has no parent sketch. */
    profile?: { x: number; y: number }[];
  };
}

/** Loft (skin) between the profiles of two or more parent sketches, in order. */
export interface LoftFeature extends FeatureBase {
  type: 'loft';
  params: {
    /** Fallback sections when no parent sketches provide profiles. */
    sections?: { x: number; y: number; z: number }[][];
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

/**
 * Dimension-driven resize: scales one world axis so the body's extent along it
 * equals `target` mm (a driving dimension — upstream changes are re-fitted to
 * the same target on every recompute, like editing a drawing dimension).
 */
export interface ScaleFeature extends FeatureBase {
  type: 'scale';
  params: {
    axis: 'x' | 'y' | 'z';
    target: number;
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
  | SweepFeature
  | LoftFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | ScaleFeature
  | LinearArrayFeature
  | CircularArrayFeature
  | MirrorFeature;

export interface FeatureResult {
  bodies: SolidBody[];
  error?: string;
}
