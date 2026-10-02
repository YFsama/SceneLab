import { Box, Cylinder, Circle, Cone, Donut, Triangle, Hexagon, CircleDot, Spline } from 'lucide-react';
import type { PrimitiveKind } from '../../store/app';

/** Primitive insert table shared by PrimitiveBar (rendering) and its test. */
export const PRIMITIVES: { kind: PrimitiveKind; icon: typeof Box }[] = [
  { kind: 'box', icon: Box },
  { kind: 'cylinder', icon: Cylinder },
  { kind: 'sphere', icon: Circle },
  { kind: 'cone', icon: Cone },
  { kind: 'torus', icon: Donut },
  { kind: 'wedge', icon: Triangle },
  { kind: 'prism', icon: Hexagon },
  { kind: 'tube', icon: CircleDot },
  { kind: 'coil', icon: Spline },
];
