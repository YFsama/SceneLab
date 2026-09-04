// Section-analysis plane math (Fusion-style live clipping) — pure, so the
// normal/constant derivation is unit-testable without a renderer.
import * as THREE from 'three';

export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionState {
  active: boolean;
  axis: SectionAxis;
  offset: number;
  flip: boolean;
}

/**
 * The clip plane for a section state: normal along `axis` (negated when
 * flipped), passing `offset` mm from the origin. three.js keeps the half-space
 * the normal points into; flip selects the other half of the model.
 */
export function sectionPlane(s: SectionState): THREE.Plane {
  const axisVec = new THREE.Vector3(
    s.axis === 'x' ? 1 : 0,
    s.axis === 'y' ? 1 : 0,
    s.axis === 'z' ? 1 : 0,
  );
  // Offset is always measured along the +axis; flip only picks which half of
  // the model is kept (the side the normal points into).
  const n = s.flip ? axisVec.clone().negate() : axisVec.clone();
  const point = axisVec.clone().multiplyScalar(s.offset);
  // Plane: n · p + constant = 0, through `point`.
  return new THREE.Plane(n, -n.dot(point));
}
