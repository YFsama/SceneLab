import { describe, it, expect, beforeAll } from 'vitest';
import { warmUpBooleanEngine, booleanOpManifold } from './booleanManifold';
import { createBox, createCone, createCylinder, createSphere, createRevolve, computeVolume } from './brep';
import { translateBody, rotateBody } from './operations';
import type { Face, FaceSource, SolidBody } from './types';

// ---------------------------------------------------------------------------
// FaceSource classification gold tests — the analytic-surface provenance that
// fromManifold tags onto boolean output faces (P2a: cone, sphere; cylinder
// golds live in booleanManifold.test.ts). Every body below goes through a real
// Manifold boolean so the classifier runs on rebuilt output, never on the
// hand-built input mesh.
// ---------------------------------------------------------------------------

/** A box strictly containing the given y-extent and radius around the axis. */
function containingBox(yMin: number, yMax: number, radius: number): SolidBody {
  const m = radius + 2;
  return translateBody(
    createBox(2 * m, yMax - yMin + 2 * m, 2 * m),
    { x: 0, y: yMin - m, z: 0 },
  );
}

/** Faces of `body` whose source is `kind`, paired with the narrowed tag. */
function facesTagged(body: SolidBody, kind: FaceSource['kind']): Array<{ face: Face; src: FaceSource }> {
  return body.faces.flatMap((f) => (f.source?.kind === kind ? [{ face: f, src: f.source }] : []));
}

describe('cone classification (Face.source kind:"cone")', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  /** Frustum ⌀20→⌀10 over h 15 (half angle atan(1/3) ≈ 18.435°), rebuilt by
   *  an intersect with a strictly containing box — fromManifold classifies. */
  const frustum = () =>
    booleanOpManifold(createCone(10, 5, 15), containingBox(0, 15, 10), 'intersect')!;

  it('classifies first: the intersect returns the frustum intact', () => {
    const body = frustum();
    expect(body).not.toBeNull();
    // n-gon frustum volume with n = adaptiveSegments(20) = 100 facets.
    const n = 100;
    const area = (r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
    const expected = (15 / 3) * (area(10) + Math.sqrt(area(10) * area(5)) + area(5));
    expect(computeVolume(body)).toBeCloseTo(expected, 1);
  });

  it('the frustum wall carries a cone tag with the analytic apex/half angle (<1e-6)', () => {
    const body = frustum();
    const tagged = facesTagged(body, 'cone');
    // The whole wall (up to decimation re-merging coplanar strips) is tagged.
    expect(tagged.length).toBeGreaterThanOrEqual(24);
    const { src } = tagged[0]!;
    expect(src.kind).toBe('cone');
    if (src.kind !== 'cone') return;
    // Apex: r(y) = 10 − y/3 degenerates at y = 30.
    expect(src.apex.x).toBeCloseTo(0, 6);
    expect(src.apex.y).toBeCloseTo(30, 6);
    expect(src.apex.z).toBeCloseTo(0, 6);
    // Canonical axis: from the apex INTO the band (band spans y ∈ [0,15]).
    expect(src.axis.x).toBeCloseTo(0, 6);
    expect(src.axis.y).toBeCloseTo(-1, 6);
    expect(src.axis.z).toBeCloseTo(0, 6);
    expect(Math.hypot(src.axis.x, src.axis.y, src.axis.z)).toBeCloseTo(1, 9);
    expect(src.halfAngle).toBeCloseTo(Math.atan(1 / 3), 9);
    // Every tagged vertex sits on the analytic cone (r = t·tan θ from apex).
    const tanH = Math.tan(src.halfAngle);
    for (const { face } of tagged) {
      for (const v of face.vertices) {
        const d = { x: v.x - src.apex.x, y: v.y - src.apex.y, z: v.z - src.apex.z };
        const t = d.x * src.axis.x + d.y * src.axis.y + d.z * src.axis.z;
        const rx = d.x - src.axis.x * t, ry = d.y - src.axis.y * t, rz = d.z - src.axis.z * t;
        expect(Math.abs(Math.hypot(rx, ry, rz) - t * tanH)).toBeLessThan(1e-6);
      }
    }
    // All cone tags on the body are the SAME tag (one wall group).
    expect(new Set(tagged.map((t) => t.src)).size).toBe(1);
  });

  it('the frustum caps carry no source (planar, different smooth group)', () => {
    const body = frustum();
    const untagged = body.faces.filter((f) => !f.source);
    expect(untagged.length).toBeGreaterThanOrEqual(2); // bottom + top discs
    // Nothing but cone tags and untagged faces exist.
    const kinds = new Set(body.faces.flatMap((f) => (f.source ? [f.source.kind] : [])));
    expect([...kinds].sort()).toEqual(['cone']);
  });

  it('cylinder control does not drift: a straight wall still tags cylinder', () => {
    const body = booleanOpManifold(
      createCylinder(10, 15),
      containingBox(0, 15, 10),
      'intersect',
    )!;
    const cyl = facesTagged(body, 'cylinder');
    expect(cyl.length).toBeGreaterThanOrEqual(24);
    for (const { src } of cyl) {
      if (src.kind !== 'cylinder') continue;
      expect(src.radius).toBeCloseTo(10, 6);
      expect(Math.abs(Math.abs(src.axis.y) - 1)).toBeLessThan(1e-9);
    }
    expect(facesTagged(body, 'cone')).toHaveLength(0);
  });

  it('a near-cylindrical cone (1.5° half angle) stays untagged — the deliberate choice', () => {
    // Below the 2° gate the slope is noise, not geometry: the pooled cylinder
    // fit has already rejected it at 0.1 % radius tolerance, and writing a
    // cone whose half angle is under the tessellation's own angular quantum
    // would lie to consumers. Neither tag is set.
    const slope = Math.tan((1.5 * Math.PI) / 180);
    const body = booleanOpManifold(
      createCone(10, 10 - 15 * slope, 15),
      containingBox(0, 15, 10),
      'intersect',
    )!;
    expect(facesTagged(body, 'cone')).toHaveLength(0);
    expect(facesTagged(body, 'cylinder')).toHaveLength(0);
    expect(body.faces.some((f) => f.source)).toBe(false);
  });

  it('a pointed cone tags cone with the apex at the tip', () => {
    const body = booleanOpManifold(
      createCone(10, 0, 15),
      containingBox(0, 15, 10),
      'intersect',
    )!;
    const tagged = facesTagged(body, 'cone');
    expect(tagged.length).toBeGreaterThanOrEqual(24);
    const { src } = tagged[0]!;
    if (src.kind !== 'cone') throw new Error('expected cone');
    expect(src.apex.x).toBeCloseTo(0, 6);
    expect(src.apex.y).toBeCloseTo(15, 6); // the tip
    expect(src.axis.y).toBeCloseTo(-1, 6);
    // Manifold's float32 output quantizes vertices at ~1e-6 — the fitted half
    // angle lands within ~1e-9 of the analytic value.
    expect(src.halfAngle).toBeCloseTo(Math.atan(10 / 15), 8);
  });

  it('a steep 45° chamfer band (half angle 45° > 35.3°) still finds its axis', () => {
    // ⌀20→⌀2 over h 9: tan θ = 9/9 = 1. The normal scatter's largest
    // eigenvalue is the axis here, not the smallest — the classifier tries
    // both eigenvector candidates.
    const body = booleanOpManifold(
      createCone(10, 1, 9),
      containingBox(0, 9, 10),
      'intersect',
    )!;
    const tagged = facesTagged(body, 'cone');
    expect(tagged.length).toBeGreaterThanOrEqual(24);
    const { src } = tagged[0]!;
    if (src.kind !== 'cone') throw new Error('expected cone');
    expect(src.halfAngle).toBeCloseTo(Math.PI / 4, 8);
    expect(src.apex.y).toBeCloseTo(10, 5); // r(y) = 10 − y hits 0 at y = 10
  });
});

describe('sphere classification (Face.source kind:"sphere")', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('a full sphere wall tags sphere with the analytic center/radius (<1e-6)', () => {
    const sphere = createSphere(10, 32);
    const body = booleanOpManifold(sphere, containingBox(-10, 10, 10), 'intersect')!;
    const tagged = facesTagged(body, 'sphere');
    expect(tagged.length).toBeGreaterThanOrEqual(24);
    const { src } = tagged[0]!;
    if (src.kind !== 'sphere') throw new Error('expected sphere');
    expect(src.center.x).toBeCloseTo(0, 6);
    expect(src.center.y).toBeCloseTo(0, 6);
    expect(src.center.z).toBeCloseTo(0, 6);
    expect(src.radius).toBeCloseTo(10, 6);
    // Every tagged vertex on the fitted sphere.
    for (const { face } of tagged) {
      for (const v of face.vertices) {
        const d = Math.hypot(v.x - src.center.x, v.y - src.center.y, v.z - src.center.z);
        expect(Math.abs(d - src.radius)).toBeLessThan(1e-6);
      }
    }
    expect(facesTagged(body, 'cylinder')).toHaveLength(0);
    expect(facesTagged(body, 'cone')).toHaveLength(0);
  });

  it('a sphere-minus-box cavity wall also tags (the fit does not need a full sphere)', () => {
    const body = booleanOpManifold(createSphere(10, 32), createBox(6, 6, 6), 'difference')!;
    expect(facesTagged(body, 'sphere').length).toBeGreaterThanOrEqual(24);
  });
});

describe('revolve band tagging (brep.createRevolve)', () => {
  /** Full-turn revolve of a right-triangle profile around +Z:
   *  A(2.5,0) → B(5,0) radial edge (plane annulus, untagged),
   *  B(5,0) → C(2.5,15) slanted edge (cone: r 5→2.5 over 15, tan θ = 1/6,
   *    apex at z = 30 where r(z) = 5 − z/6 degenerates),
   *  C(2.5,15) → A(2.5,0) vertical edge (cylinder ⌀5, h 15). */
  function revolvedBands(): SolidBody {
    return createRevolve({
      profile: [
        { x: 2.5, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 2.5, y: 0, z: 15 },
      ],
      axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
      angle: Math.PI * 2,
    });
  }

  it('tags the swept cone and cylinder bands by construction', () => {
    const body = revolvedBands();
    const cones = facesTagged(body, 'cone');
    const cylinders = facesTagged(body, 'cylinder');
    // 32 revolve segments → one tagged quad per segment per analytic band.
    expect(cones.length).toBe(32);
    expect(cylinders.length).toBe(32);
    // The radial (annulus) band stays untagged: 'plane' has no producer.
    expect(body.faces.length).toBe(96);
    expect(body.faces.filter((f) => !f.source).length).toBe(32);

    const cone = cones[0]!.src;
    if (cone.kind !== 'cone') throw new Error('expected cone');
    expect(cone.apex.x).toBeCloseTo(0, 6);
    expect(cone.apex.y).toBeCloseTo(0, 6);
    expect(cone.apex.z).toBeCloseTo(30, 6);
    expect(cone.axis.z).toBeCloseTo(-1, 6); // apex (z=30) into band (z ∈ [0,15])
    expect(cone.halfAngle).toBeCloseTo(Math.atan(1 / 6), 9);

    const cyl = cylinders[0]!.src;
    if (cyl.kind !== 'cylinder') throw new Error('expected cylinder');
    expect(cyl.radius).toBeCloseTo(2.5, 6);
    expect(cyl.axis.z).toBeCloseTo(1, 6);
    expect(cyl.origin.z).toBeCloseTo(7.5, 6); // on-axis at the band's mid height

    // One shared tag per band (not per facet).
    expect(new Set(cones.map((t) => t.src)).size).toBe(1);
    expect(new Set(cylinders.map((t) => t.src)).size).toBe(1);
  });

  it('a pointed profile edge (endpoint on the axis) tags cone at the tip', () => {
    const body = createRevolve({
      profile: [
        { x: 0, y: 0, z: 15 }, // on-axis tip
        { x: 6, y: 0, z: 0 },  // base rim
        { x: 0, y: 0, z: 0 },  // on-axis base (degenerate band, untagged)
      ],
      axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
      angle: Math.PI * 2,
    });
    const cones = facesTagged(body, 'cone');
    expect(cones.length).toBe(32);
    const cone = cones[0]!.src;
    if (cone.kind !== 'cone') throw new Error('expected cone');
    expect(cone.apex.z).toBeCloseTo(15, 6);
    expect(cone.axis.z).toBeCloseTo(-1, 6);
    expect(cone.halfAngle).toBeCloseTo(Math.atan(6 / 15), 9);
  });
});

// ---------------------------------------------------------------------------
// Rigid transforms must carry analytic sources with the mesh (found during
// the P2a review-disposition probes: translateBody/rotateBody used to DROP
// face.source — and body colour/opacity/material — silently degrading STEP
// export and CAM arcs). End-to-end oblique CLASSIFICATION is a separate,
// still-open limitation: fromManifold's output decimation over-merges
// rotated walls into ~60° arcs whose adjacent dihedral exceeds the smooth
// group threshold, so oblique groups never form — see todo.md.
// ---------------------------------------------------------------------------

describe('rigid transforms carry analytic sources', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('rotateBody moves cylinder tags with the wall (axis, radius, vertices)', () => {
    // Classified axis-aligned first (the exact path's well-trodden case),
    // then rotated +Y onto (1,1,1)/√3 — Rodrigues about (1,0,−1)/√2 by
    // acos(1/√3) maps ŷ→n exactly. The tags must ride along: a rigidly
    // moved cylinder is still exactly a cylinder.
    const tube = booleanOpManifold(
      createCylinder(2.5, 12, 48),
      translateBody(createCylinder(1.2, 16, 48), { x: 0, y: -2, z: 0 }),
      'difference',
    );
    expect(tube).not.toBeNull();
    expect(facesTagged(tube!, 'cylinder').length).toBeGreaterThan(0);
    const n = { x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) };
    const rotated = rotateBody(
      tube!,
      { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1 / Math.SQRT2, y: 0, z: -1 / Math.SQRT2 } },
      Math.acos(1 / Math.sqrt(3)),
    );
    const tagged = facesTagged(rotated, 'cylinder');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    for (const { face, src } of tagged) {
      if (src.kind !== 'cylinder') continue;
      expect([2.5, 1.2]).toContain(Math.round(src.radius * 1e6) / 1e6);
      const par = Math.abs(src.axis.x * n.x + src.axis.y * n.y + src.axis.z * n.z);
      expect(par).toBeCloseTo(1, 6);
      for (const v of face.vertices) {
        const dx = v.x - src.origin.x;
        const dy = v.y - src.origin.y;
        const dz = v.z - src.origin.z;
        const t = dx * src.axis.x + dy * src.axis.y + dz * src.axis.z;
        const dist = Math.hypot(dx - src.axis.x * t, dy - src.axis.y * t, dz - src.axis.z * t);
        expect(Math.abs(dist - src.radius)).toBeLessThan(1e-6);
      }
    }
  });

  it('translateBody shifts tag anchors and keeps body colour', () => {
    const tube = booleanOpManifold(
      createCylinder(2.5, 12, 48),
      translateBody(createCylinder(1.2, 16, 48), { x: 0, y: -2, z: 0 }),
      'difference',
    )!;
    const before = facesTagged(tube, 'cylinder')[0]!;
    const offset = { x: 3, y: -1.5, z: 7 };
    const moved = translateBody(tube, offset);
    moved.color = 0x112233; // body props must survive transforms too
    const movedAgain = translateBody(moved, { x: 0, y: 0, z: 0 });
    const after = facesTagged(movedAgain, 'cylinder')[0]!;
    if (before.src.kind !== 'cylinder' || after.src.kind !== 'cylinder') throw new Error('expected cylinders');
    expect(after.src.axis).toEqual(before.src.axis); // axes unchanged
    expect(after.src.radius).toBeCloseTo(before.src.radius, 9);
    expect(after.src.origin.x).toBeCloseTo(before.src.origin.x + offset.x, 9);
    expect(after.src.origin.y).toBeCloseTo(before.src.origin.y + offset.y, 9);
    expect(after.src.origin.z).toBeCloseTo(before.src.origin.z + offset.z, 9);
    expect(movedAgain.color).toBe(0x112233);
  });
});

describe('negative guards (sphere disguise / short bands)', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('a spherical latitude zone is never tagged cone or cylinder', () => {
    // Two parallel coaxial rings always share a sphere, so a cone fit on a
    // sphere zone can only be rejected by the normal-consistency and
    // apex-in-band guards; pin that the disguise never leaks out as a
    // CONICAL/CYLINDRICAL_SURFACE candidate.
    const sphere = createSphere(10);
    const slab = translateBody(createBox(30, 3, 30), { x: -15, y: 2, z: -15 }); // y ∈ [2,5]
    const zone = booleanOpManifold(sphere, slab, 'intersect');
    expect(zone).not.toBeNull();
    const kinds = new Set(zone!.faces.flatMap((f) => (f.source ? [f.source.kind] : [])));
    expect(kinds.has('cone')).toBe(false);
    expect(kinds.has('cylinder')).toBe(false);
  });

  it('a short cylinder band (L = 0.5r) tags cylinder, never sphere', () => {
    // A short band's wall normals are near-radial enough to pass the sphere
    // normal gate (cos = r/√(r²+(L/2)²) ≈ 0.97 at L = 0.5r), so the only
    // thing keeping it honest is the cylinder fit winning first — pin that
    // it does on a clean mesh.
    const short = booleanOpManifold(createCylinder(10, 5), containingBox(0, 5, 10), 'intersect');
    expect(short).not.toBeNull();
    expect(facesTagged(short!, 'sphere').length).toBe(0);
    expect(facesTagged(short!, 'cylinder').length).toBeGreaterThanOrEqual(8);
  });
});
