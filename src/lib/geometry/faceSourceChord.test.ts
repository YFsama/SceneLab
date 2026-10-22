import { describe, it, expect, beforeAll } from 'vitest';
import { warmUpBooleanEngine, booleanOpManifold } from './booleanManifold';
import { createBox, createCone, createCylinder, createSphere } from './brep';
import { translateBody, rotateBody } from './operations';
import type { Face, FaceSource, SolidBody } from './types';

// ---------------------------------------------------------------------------
// Chord-tolerance classification for cones and spheres — the same known edge
// the cylinder path already recovered from (see the oblique-drilled cylinder
// tests in faceSource.test.ts): a boolean that crosses the wall obliquely
// leaves NEW rim vertices ON the tessellated surface's facet chords, strictly
// inside the analytic surface by up to one chord sagitta, and the "every
// vertex ON the surface at 0.1%" gates rejected them. The cone and sphere
// classifiers now accept those chord-interior vertices within the local
// sagitta implied by the surface's own vertex spacing.
// ---------------------------------------------------------------------------

/** Faces of `body` whose source is `kind`, paired with the narrowed tag. */
function facesTagged(body: SolidBody, kind: FaceSource['kind']): Array<{ face: Face; src: FaceSource }> {
  return body.faces.flatMap((f) => (f.source?.kind === kind ? [{ face: f, src: f.source }] : []));
}

describe('oblique cone wall classification (drilled after rotation)', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  /** Frustum ⌀20→⌀10 over h 15 rotated so +Y → (1,1,1)/√3 (same Rodrigues
   *  frame as the oblique cylinder tests), then drilled through the wall by a
   *  ⌀1 cutter along the WALL NORMAL at the wall point (r 7.5, y 7.5,
   *  azimuth 0) — oblique to every world axis, but steep against the wall so
   *  the cone group and the drill group stay separate smooth groups (a
   *  shallower crossing would join them under the 45° step gate and leave
   *  NEITHER classifiable). The drill rim crosses the wall facet interiors,
   *  so the output mixes exact ring-row vertices with chord-interior rim
   *  vertices BETWEEN the rows. */
  const obliqueDrilledFrustum = () => {
    const theta = Math.atan(1 / 3); // half angle of r(y) = 10 − y/3
    const wallPoint = { x: 7.5, y: 7.5, z: 0 };
    const nrm = { x: Math.cos(theta), y: Math.sin(theta), z: 0 }; // wall outward normal at azimuth 0
    // ⌀1 drill: +Y cylinder rotated onto nrm (about ŷ×nrm = (0,0,−1)), then
    // centred on the wall point.
    const drillLocal = translateBody(
      rotateBody(
        createCylinder(0.5, 40, 48),
        { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } },
        Math.acos(nrm.y),
      ),
      { x: wallPoint.x - 20 * nrm.x, y: wallPoint.y - 20 * nrm.y, z: wallPoint.z - 20 * nrm.z },
    );
    const rot = (b: SolidBody) =>
      rotateBody(
        b,
        { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1 / Math.SQRT2, y: 0, z: -1 / Math.SQRT2 } },
        Math.acos(1 / Math.sqrt(3)),
      );
    return booleanOpManifold(rot(createCone(10, 5, 15)), rot(drillLocal), 'difference');
  };

  it('the obliquely drilled frustum wall still carries a cone tag: apex/halfAngle within 1e-4', () => {
    const out = obliqueDrilledFrustum();
    expect(out).not.toBeNull();
    const tagged = facesTagged(out!, 'cone');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'cone') throw new Error('expected cone');
    // Analytic: r(y) = 10 − y/3 ⇒ half angle atan(1/3), apex at y = 30 along
    // the rotated axis: 30·(1,1,1)/√3.
    expect(src.halfAngle).toBeCloseTo(Math.atan(1 / 3), 4);
    expect(src.apex.x).toBeCloseTo(30 / Math.sqrt(3), 4);
    expect(src.apex.y).toBeCloseTo(30 / Math.sqrt(3), 4);
    expect(src.apex.z).toBeCloseTo(30 / Math.sqrt(3), 4);
    // Canonical axis points from the apex INTO the band.
    const n = 1 / Math.sqrt(3);
    expect(src.axis.x).toBeCloseTo(-n, 4);
    expect(src.axis.y).toBeCloseTo(-n, 4);
    expect(src.axis.z).toBeCloseTo(-n, 4);
    // One shared tag for the whole wall group.
    expect(new Set(tagged.map((t) => t.src)).size).toBe(1);
  });

  it('tagged vertices lie on the analytic cone within the circumferential chord sagitta', () => {
    const out = obliqueDrilledFrustum()!;
    const tagged = facesTagged(out, 'cone');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'cone') throw new Error('expected cone');
    const tanH = Math.tan(src.halfAngle);
    // 100 facets around ⇒ circumferential chord sagitta ≤ r·(1−cos(π/100)),
    // at most 10·4.95e-4 ≈ 0.005 on this frustum (plus float32 slack).
    const sag = 10 * (1 - Math.cos(Math.PI / 100)) + 1e-3;
    for (const { face } of tagged) {
      for (const v of face.vertices) {
        const d = { x: v.x - src.apex.x, y: v.y - src.apex.y, z: v.z - src.apex.z };
        const t = d.x * src.axis.x + d.y * src.axis.y + d.z * src.axis.z;
        const rd = Math.hypot(
          d.x - src.axis.x * t,
          d.y - src.axis.y * t,
          d.z - src.axis.z * t,
        );
        expect(rd - t * tanH).toBeLessThanOrEqual(1e-3); // never outside the cone
        expect(t * tanH - rd).toBeLessThanOrEqual(sag); // at most a chord depth inside
      }
    }
  });

  it('axis-aligned control: the untouched frustum still tags exactly (zero drift)', () => {
    // Same construction without the rotation: the world-Y drill is parallel
    // to the cone axis at radius √(0.9² + 0.9²) = 1.27 from it, cutting only
    // the caps — the wall never sees the drill, and the strict fit path
    // (which runs first) keeps its bit-exact behaviour.
    const drill = translateBody(createCylinder(0.5, 40, 48), { x: 0.9, y: -12.5, z: 0.9 });
    const out = booleanOpManifold(createCone(10, 5, 15), drill, 'difference');
    expect(out).not.toBeNull();
    const tagged = facesTagged(out!, 'cone');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'cone') throw new Error('expected cone');
    expect(src.halfAngle).toBeCloseTo(Math.atan(1 / 3), 8);
    expect(src.apex.y).toBeCloseTo(30, 6);
  });
});

describe('box-cut sphere band classification (rim chord vertices)', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  /** R10 sphere (32 segments) ∩ slab keeping y ∈ [3, 11]: the band keeps the
   *  tessellation rows ON the sphere but its boundary rims lie where the box
   *  planes cut the facet CHORDS — strictly inside the true sphere by up to
   *  the facet sagitta, which the strict 0.1% equidistance gate rejected. */
  const sphereBand = () => {
    const sphere = createSphere(10, 32);
    const slab = translateBody(createBox(40, 8, 40), { x: 0, y: 3, z: 0 }); // y ∈ [3, 11]
    return booleanOpManifold(sphere, slab, 'intersect');
  };

  it('the band still tags sphere: radius/center recover the analytic values', () => {
    const out = sphereBand();
    expect(out).not.toBeNull();
    const tagged = facesTagged(out!, 'sphere');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'sphere') throw new Error('expected sphere');
    // The tagged radius is pinned by the on-sphere ring vertices (immune to
    // the chord-interior rims), so it stays within the fit/quantisation slack
    // of 10 — NOT biased by the rim fraction the way a plain Kåsa fit is.
    expect(src.radius).toBeCloseTo(10, 1);
    expect(Math.hypot(src.center.x, src.center.y, src.center.z)).toBeLessThan(0.1);
    expect(new Set(tagged.map((t) => t.src)).size).toBe(1);
  });

  it('tagged vertices never sit outside the fitted sphere, and inside by at most a facet chord', () => {
    const out = sphereBand()!;
    const tagged = facesTagged(out, 'sphere');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'sphere') throw new Error('expected sphere');
    // 32-segment UV sphere: facet vertices sit up to ~23° apart about the
    // centre ⇒ one chord sagitta 10·(1−cos(11.5°)) ≈ 0.20 plus slack.
    const sag = 10 * (1 - Math.cos((23 * Math.PI) / 180 / 2)) + 0.03;
    for (const { face } of tagged) {
      for (const v of face.vertices) {
        const d = Math.hypot(v.x - src.center.x, v.y - src.center.y, v.z - src.center.z);
        expect(d - src.radius).toBeLessThanOrEqual(1e-3); // never outside
        expect(src.radius - d).toBeLessThanOrEqual(sag); // at most a facet chord inside
      }
    }
  });

  it('full-sphere control: a clean sphere tags with the strict exact fit (zero drift)', () => {
    const box = translateBody(createBox(40, 40, 40), { x: -20, y: -20, z: -20 });
    const out = booleanOpManifold(createSphere(10, 32), box, 'intersect');
    expect(out).not.toBeNull();
    const tagged = facesTagged(out!, 'sphere');
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const src = tagged[0]!.src;
    if (src.kind !== 'sphere') throw new Error('expected sphere');
    expect(src.radius).toBeCloseTo(10, 6);
    expect(src.center.x).toBeCloseTo(0, 6);
    expect(src.center.y).toBeCloseTo(0, 6);
    expect(src.center.z).toBeCloseTo(0, 6);
  });
});
