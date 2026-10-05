import { describe, it, expect, beforeAll } from 'vitest';
import { exportSTEP } from './step';
import { importSTEP } from './stepImport';
import {
  createBox,
  createCylinder,
  createSphere,
  buildEdgesFromFaces,
  adaptiveSegments,
  computeVolume,
} from '../geometry/brep';
import { warmUpBooleanEngine, booleanOpManifold } from '../geometry/booleanManifold';
import type { Face, SolidBody, Vec3 } from '../geometry/types';
import { stepNeedsExactKernel } from './stepOCCT';

/** Parse the DATA section into id → { type, args } (single nesting level). */
function parseEntities(step: string): Map<number, { type: string; args: string[] }> {
  // Split an argument list at top-level commas (parens/quotes aware).
  const splitTop = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) out.push(cur.trim());
    return out;
  };
  const out = new Map<number, { type: string; args: string[] }>();
  const re = /#(\d+)=([A-Z0-9_]+)\s*\(([^;]*)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step)) !== null) {
    out.set(Number(m[1]!), { type: m[2]!, args: splitTop(m[3]!) });
  }
  return out;
}

describe('exportSTEP', () => {
  it('produces a valid STEP file header', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('HEADER');
    expect(step).toContain('FILE_DESCRIPTION');
    expect(step).toContain('FILE_SCHEMA');
    expect(step).toContain('ENDSEC');
    expect(step).toContain('END-ISO-10303-21');
  });

  it('contains CARTESIAN_POINT entities for vertices', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('CARTESIAN_POINT');
    expect(step).toContain('VERTEX_POINT');
  });

  it('contains ADVANCED_FACE entities for faces', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    expect(step).toContain('PLANE');
  });

  it('contains EDGE_CURVE and ORIENTED_EDGE', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('EDGE_CURVE');
    expect(step).toContain('ORIENTED_EDGE');
    expect(step).toContain('EDGE_LOOP');
  });

  it('includes the body name in the product', () => {
    const box = createBox(10, 10, 10);
    box.name = 'TestPart';
    const step = exportSTEP(box);
    expect(step).toContain('TestPart');
  });

  it('has correct entity count for a box (6 faces)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Count ADVANCED_FACE entities — should be 6 for a box.
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBe(6);
  });

  it('contains AXIS2_PLACEMENT_3D for each face plane', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const axisCount = (step.match(/AXIS2_PLACEMENT_3D/g) ?? []).length;
    expect(axisCount).toBe(6); // one per face
  });

  it('has the canonical OCCT shape chain (SDR → ABSR → MSB)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('SHAPE_DEFINITION_REPRESENTATION');
    expect(step).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
    expect(step).toContain('MANIFOLD_SOLID_BREP');
  });

  it('has the product chain APPLICATION_PROTOCOL_DEFINITION → PRODUCT → PDF → PD → PDS', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('APPLICATION_PROTOCOL_DEFINITION');
    expect(step).toContain('PRODUCT_DEFINITION_FORMATION');
    expect(step).toContain('PRODUCT_DEFINITION_SHAPE');
  });

  it('contains LINE entities for edges', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('LINE');
  });

  it('contains DIRECTION entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('DIRECTION');
  });

  it('contains VECTOR entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('VECTOR');
  });

  it('produces valid file structure with DATA section', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const lines = step.split('\n');
    expect(lines[0]).toBe('ISO-10303-21;');
    expect(step).toContain('HEADER;');
    expect(step).toContain('DATA;');
    expect(step).toContain('ENDSEC;');
    expect(step).toContain('END-ISO-10303-21;');
  });

  it('has valid entity references (no dangling #N)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Extract all entity definitions (#N=...).
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      defined.add(parseInt(match[1]!));
    }
    // Extract all entity references (#N).
    const refs = new Set<number>();
    const refUsePattern = /#(\d+)/g;
    while ((match = refUsePattern.exec(step)) !== null) {
      refs.add(parseInt(match[1]!));
    }
    // All referenced entities should be defined.
    for (const r of refs) {
      expect(defined.has(r)).toBe(true);
    }
  });

  it('has consistent entity count (no duplicates)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      const eid = parseInt(match[1]!);
      expect(defined.has(eid)).toBe(false); // no duplicate definitions
      defined.add(eid);
    }
    expect(defined.size).toBeGreaterThan(10); // reasonable entity count
  });

  it('exports a cylinder with valid structure', () => {
    const cyl = createCylinder(5, 10, 16);
    const step = exportSTEP(cyl);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6); // cylinder has more faces than box
  });

  it('exports a sphere with valid structure', () => {
    const sphere = createSphere(5, 16);
    const step = exportSTEP(sphere);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6);
  });

  it('all exported bodies have valid entity references', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const step = exportSTEP(make());
      const defined = new Set<number>();
      const defPattern = /#(\d+)=/g;
      let m;
      while ((m = defPattern.exec(step)) !== null) defined.add(parseInt(m[1]!));
      const refPattern = /#(\d+)/g;
      while ((m = refPattern.exec(step)) !== null) {
        expect(defined.has(parseInt(m[1]!))).toBe(true);
      }
    }
  });

  // ---- OCCT structural contract (the defects the kernel audit found) ------

  it('every DIRECTION is unit length (OCCT rejects non-unit directions)', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const step = exportSTEP(make());
      const dirRe = /DIRECTION\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = dirRe.exec(step)) !== null) {
        const len = Math.hypot(Number(m[1]), Number(m[2]), Number(m[3]));
        expect(len).toBeCloseTo(1, 5);
        count++;
      }
      expect(count).toBeGreaterThan(0);
    }
  });

  it('every ADVANCED_FACE bounds through a FACE_OUTER_BOUND → EDGE_LOOP', () => {
    const ents = parseEntities(exportSTEP(createBox(10, 10, 10)));
    const faces = [...ents.values()].filter((e) => e.type === 'ADVANCED_FACE');
    expect(faces).toHaveLength(6);
    for (const f of faces) {
      // bounds tuple arrives as one arg like (#12)
      const bounds = f.args[1]!.replace(/^\(|\)$/g, '').split(',').map((s) => Number(s.replace('#', '')));
      expect(bounds).toHaveLength(1);
      const bound = ents.get(bounds[0]!)!;
      expect(bound.type).toBe('FACE_OUTER_BOUND');
      const loop = ents.get(Number(bound.args[1]!.replace('#', '')))!;
      expect(loop.type).toBe('EDGE_LOOP');
    }
  });

  it('MANIFOLD_SOLID_BREP references the CLOSED_SHELL which lists every face', () => {
    const ents = parseEntities(exportSTEP(createBox(10, 10, 10)));
    const msb = [...ents.values()].find((e) => e.type === 'MANIFOLD_SOLID_BREP')!;
    expect(msb.args[0]).toBe(`'Box'`);
    const shell = ents.get(Number(msb.args[1]!.replace('#', '')))!;
    expect(shell.type).toBe('CLOSED_SHELL');
    const shellFaces = shell.args[1]!.replace(/^\(|\)$/g, '').split(',').map((s) => Number(s.replace('#', '')));
    const allFaces = [...ents.entries()].filter(([, e]) => e.type === 'ADVANCED_FACE').map(([i]) => i);
    expect(shellFaces.sort((a, b) => a - b)).toEqual(allFaces.sort((a, b) => a - b));
  });

  it('ADVANCED_BREP_SHAPE_REPRESENTATION carries the geometric unit context', () => {
    const step = exportSTEP(createBox(10, 10, 10));
    const ents = parseEntities(step);
    const absr = [...ents.values()].find((e) => e.type === 'ADVANCED_BREP_SHAPE_REPRESENTATION')!;
    // items (#N) and context (#M)
    const msbId = Number(absr.args[1]!.replace(/^\(|\)$/g, '').replace('#', ''));
    expect(ents.get(msbId)!.type).toBe('MANIFOLD_SOLID_BREP');
    const ctxId = absr.args[2]!.replace('#', '');
    // The context is the complex GEOMETRIC_REPRESENTATION_CONTEXT entity —
    // not captured by the simple parser, so assert on the raw text.
    const ctxRe = new RegExp(`#${ctxId}=\\(GEOMETRIC_REPRESENTATION_CONTEXT\\(3\\)`);
    expect(ctxRe.test(step)).toBe(true);
  });

  it('every AXIS2_PLACEMENT_3D has an explicit axis and ref direction', () => {
    const step = exportSTEP(createBox(10, 10, 10));
    const axisRe = /AXIS2_PLACEMENT_3D\('',#(\d+),#(\d+),#(\d+)\);/g;
    const count = [...step.matchAll(axisRe)].length;
    expect(count).toBe(6); // one per face, none with a $ ref direction
  });
});

// ---------------------------------------------------------------------------
// Analytic cylinder faces (the Face.source contract the boolean output
// classifier sets). Until `source` lands in geometry/types.ts, the doubles
// below widen Face structurally with the same field shape.
// ---------------------------------------------------------------------------

/** Local widening of Face carrying the documented `source` tag. */
type TaggedFace = Face & { source?: { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number } };

/** n-gon ring in the XZ plane at height y (matches createCylinder's profile). */
function ringPoints(radius: number, y: number, count: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
  }
  return pts;
}

const cylSource = (radius: number) => ({
  kind: 'cylinder' as const,
  origin: { x: 0, y: 0, z: 0 },
  axis: { x: 0, y: 1, z: 0 },
  radius,
});

const bodyOf = (name: string, faces: Face[]): SolidBody => ({
  id: `body_${name}`,
  name,
  vertices: faces.flatMap((f) => f.vertices),
  faces,
  edges: buildEdgesFromFaces(faces),
});

/**
 * An ISOLATED ⌀6 wall band (two 55-gon rims, adaptiveSegments(6) = 55) with
 * no other face touching its rims — the shape that earns the canonical tube
 * form (1 face + 2 CIRCLE edges + 1 seam LINE). `outward` picks the wall's
 * orientation: true = rod-style (normal away from the axis), false = hole
 * wall (normal toward the axis).
 */
function isolatedBand(radius = 3, height = 20, outward = true): SolidBody {
  const n = adaptiveSegments(radius * 2);
  const bottom = ringPoints(radius, 0, n);
  const top = ringPoints(radius, height, n);
  const wall: TaggedFace = {
    id: 'wall',
    vertices: [...bottom, ...top],
    normal: { x: outward ? 1 : -1, y: 0, z: 0 }, // radial at vertex 0 (angle 0)
    source: cylSource(radius),
  };
  return bodyOf(outward ? 'RodBand' : 'HoleBand', [wall]);
}

/** One quad facet of a cylinder wall, tagged like the classifier does. */
function wallFacet(
  radius: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  hole: boolean,
): TaggedFace {
  const p = (a: number, y: number): Vec3 => ({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
  const mid = (a0 + a1) / 2;
  const s = hole ? -1 : 1;
  return {
    id: `facet_${a0.toFixed(3)}`,
    vertices: [p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1)],
    normal: { x: s * Math.cos(mid), y: 0, z: s * Math.sin(mid) },
    source: cylSource(radius),
  };
}

/**
 * A drilled solid the way the landed classifier shapes it: the wall is 55
 * TAGGED quad facets (tagCylinderSources tags every facet of the group, and
 * its decimateCoplanar deliberately refuses annulus caps), the caps and
 * sides are plain planar faces. Rims are shared with the caps, so the writer
 * must keep the shared chord boundary — no CIRCLEs — on ONE shared
 * CYLINDRICAL_SURFACE.
 */
function facetedTube(radius = 3, height = 20): SolidBody {
  const n = adaptiveSegments(radius * 2);
  const wall: TaggedFace[] = [];
  for (let i = 0; i < n; i++) {
    wall.push(wallFacet(radius, (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2, 0, height, false));
  }
  const bottom = ringPoints(radius, 0, n);
  const top = ringPoints(radius, height, n);
  const capB: TaggedFace = { id: 'capB', vertices: [...bottom].reverse(), normal: { x: 0, y: -1, z: 0 } };
  const capT: TaggedFace = { id: 'capT', vertices: top, normal: { x: 0, y: 1, z: 0 } };
  return bodyOf('Tube', [...wall, capB, capT]);
}

/**
 * Drilled box (20³, ⌀6 through hole along +Y, box spans y∈[0,20] per
 * createExtrude): 4 side quads + 2 caps + 55 tagged wall facets. Caps are
 * square + rim concatenated into one vertex array — the single-array Face
 * model cannot express inner loops, so the loop jumps between the outer
 * square and the inner ring (a pre-existing writer limitation this test
 * inherits deliberately; the counts are what matter).
 */
function facetedHoledBox(size = 20, radius = 3): SolidBody {
  const n = adaptiveSegments(radius * 2);
  const wall: TaggedFace[] = [];
  for (let i = 0; i < n; i++) {
    wall.push(wallFacet(radius, (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2, 0, size, true));
  }
  const ringBottom = ringPoints(radius, 0, n);
  const ringTop = ringPoints(radius, size, n);
  const square = (y: number): Vec3[] => [
    { x: -size / 2, y, z: -size / 2 },
    { x: size / 2, y, z: -size / 2 },
    { x: size / 2, y, z: size / 2 },
    { x: -size / 2, y, z: size / 2 },
  ];
  const h = size / 2;
  return bodyOf('HoledBox', [
    // Caps reference the rim vertices (square + ring concatenated — the
    // single-array Face model cannot express inner loops, so the loop jumps
    // between them; a pre-existing writer limitation this test inherits).
    { id: 's1', vertices: [...square(size), ...ringTop], normal: { x: 0, y: 1, z: 0 } },
    { id: 's2', vertices: [...square(0), ...ringBottom], normal: { x: 0, y: -1, z: 0 } },
    { id: 's3', vertices: [{ x: h, y: 0, z: -h }, { x: h, y: size, z: -h }, { x: h, y: size, z: h }, { x: h, y: 0, z: h }], normal: { x: 1, y: 0, z: 0 } },
    { id: 's4', vertices: [{ x: -h, y: 0, z: -h }, { x: -h, y: size, z: -h }, { x: -h, y: size, z: h }, { x: -h, y: 0, z: h }], normal: { x: -1, y: 0, z: 0 } },
    { id: 's5', vertices: [{ x: -h, y: 0, z: h }, { x: h, y: 0, z: h }, { x: h, y: size, z: h }, { x: -h, y: size, z: h }], normal: { x: 0, y: 0, z: 1 } },
    { id: 's6', vertices: [{ x: -h, y: 0, z: -h }, { x: h, y: 0, z: -h }, { x: h, y: size, z: -h }, { x: -h, y: size, z: -h }], normal: { x: 0, y: 0, z: -1 } },
    ...wall,
  ]);
}

/** A HALF band (angles 0..π): tagged, but only a partial arc — polyline fallback. */
function halfBandBody(radius = 3, height = 20): SolidBody {
  const arc = (y: number): Vec3[] => {
    const pts: Vec3[] = [];
    const m = 12;
    for (let i = 0; i < m; i++) {
      const a = (i / (m - 1)) * Math.PI;
      pts.push({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
    }
    return pts;
  };
  const face: TaggedFace = {
    id: 'half',
    vertices: [...arc(0), ...arc(height)],
    normal: { x: 0, y: 0, z: 1 },
    source: cylSource(radius),
  };
  return bodyOf('HalfBand', [face]);
}

describe('exportSTEP: analytic cylinder faces (Face.source)', () => {
  const text = exportSTEP(isolatedBand());
  const ents = parseEntities(text);

  it('an isolated ⌀6 wall band becomes 1 face + 2 CIRCLE edges + 1 CYLINDRICAL_SURFACE', () => {
    expect((text.match(/ADVANCED_FACE/g) ?? []).length).toBe(1);
    expect((text.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((text.match(/CIRCLE\(/g) ?? []).length).toBe(2);
    expect((text.match(/PLANE\(/g) ?? []).length).toBe(0);
    // The whole band boundary: two circles + the seam line.
    expect([...ents.values()].filter((e) => e.type === 'EDGE_CURVE')).toHaveLength(3);
    // Two rim vertices only (each closed circle starts and ends on one).
    expect((text.match(/VERTEX_POINT/g) ?? []).length).toBe(2);
  });

  it('CIRCLE parameters match the source tag (radius, axis, rim centres)', () => {
    const circles = [...ents.values()].filter((e) => e.type === 'CIRCLE');
    expect(circles).toHaveLength(2);
    const centreYs: number[] = [];
    for (const c of circles) {
      expect(Number(c.args[2])).toBeCloseTo(3, 6); // radius
      const placement = ents.get(Number(c.args[1]!.replace('#', '')))!;
      const [, locRef, axisRef] = placement.args;
      const pt = ents.get(Number(locRef!.replace('#', '')))!;
      centreYs.push(Number(pt.args[1]!.replace(/^\(|\)$/g, '').split(',')[1]));
      const dir = ents.get(Number(axisRef!.replace('#', '')))!;
      const d = dir.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
      expect(Math.hypot(d[0]!, d[1]!, d[2]!)).toBeCloseTo(1, 5);
      expect(d[1]).toBeCloseTo(1, 5); // circle plane normal = the +Y hole axis
      expect(d[0]).toBeCloseTo(0, 5);
      expect(d[2]).toBeCloseTo(0, 5);
    }
    expect(centreYs.sort((a, b) => a - b)).toEqual([0, 20]); // rim planes
  });

  it('the band face loop is the canonical seam cycle and chains vertex-to-vertex', () => {
    const cylFace = [...ents.values()]
      .filter((e) => e.type === 'ADVANCED_FACE')
      .find((f) => ents.get(Number(f.args[2]!.replace('#', '')))?.type === 'CYLINDRICAL_SURFACE')!;
    expect(cylFace).toBeDefined();
    expect(cylFace.args[3]).toBe('.T.'); // outward normal → same_sense

    const boundId = Number(cylFace.args[1]!.replace(/^\(|\)$/g, '').replace('#', ''));
    const bound = ents.get(boundId)!;
    expect(bound.type).toBe('FACE_OUTER_BOUND');
    expect(bound.args[2]).toBe('.T.'); // sense and bound orientation agree
    const loop = ents.get(Number(bound.args[1]!.replace('#', '')))!;
    const oeIds = loop.args[1]!.replace(/^\(|\)$/g, '').split(',').map((s) => Number(s.replace('#', '')));
    expect(oeIds).toHaveLength(4); // circle, seam, circle, seam

    const edgeVerts = new Map<number, [number, number]>();
    for (const [eid, e] of ents) {
      if (e.type === 'EDGE_CURVE') {
        edgeVerts.set(eid, [Number(e.args[1]!.replace('#', '')), Number(e.args[2]!.replace('#', ''))]);
      }
    }
    let prevEnd: number | null = null;
    let firstStart = 0;
    for (const oeId of oeIds) {
      const oe = ents.get(oeId)!;
      const edgeId = Number(oe.args[3]!.replace('#', ''));
      const [a, b] = edgeVerts.get(edgeId)!;
      const forward = oe.args[4] !== '.F.';
      const start = forward ? a : b;
      const end = forward ? b : a;
      if (prevEnd !== null) expect(start).toBe(prevEnd);
      if (prevEnd === null) firstStart = start;
      prevEnd = end;
    }
    expect(prevEnd).toBe(firstStart); // closed cycle — even across the circles

    // Curve types around the loop: CIRCLE, LINE, CIRCLE, LINE (the seam
    // LINE is reused with opposite orientations; the circles wind
    // oppositely).
    const curveType = (oeId: number): string => {
      const oe = ents.get(oeId)!;
      const edge = ents.get(Number(oe.args[3]!.replace('#', '')))!;
      return ents.get(Number(edge.args[3]!.replace('#', '')))!.type;
    };
    expect(oeIds.map(curveType)).toEqual(['CIRCLE', 'LINE', 'CIRCLE', 'LINE']);
    const flags = oeIds.map((oeId) => ents.get(oeId)!.args[4]);
    expect(flags[0]).not.toBe(flags[2]); // the two circles wind oppositely
    expect(flags[1]).not.toBe(flags[3]); // seam up vs seam down
    // The closed circle edges reference the SAME vertex twice (start = end).
    const circleEdges = [...edgeVerts.values()].filter(([a, b]) => a === b);
    expect(circleEdges).toHaveLength(2);
  });

  it('a hole-side band (inward normal) flips same_sense and the bound orientation', () => {
    const hEnts = parseEntities(exportSTEP(isolatedBand(3, 20, false)));
    const cylFace = [...hEnts.values()]
      .filter((e) => e.type === 'ADVANCED_FACE')
      .find((f) => hEnts.get(Number(f.args[2]!.replace('#', '')))?.type === 'CYLINDRICAL_SURFACE')!;
    expect(cylFace.args[3]).toBe('.F.');
    const bound = hEnts.get(Number(cylFace.args[1]!.replace(/^\(|\)$/g, '').replace('#', '')))!;
    expect(bound.args[2]).toBe('.F.');
  });

  it('shared rims (drilled solid caps) keep the chord boundary on ONE shared analytic surface', () => {
    // The classifier tags every wall facet; the caps reference the rim
    // vertices, so CIRCLE rims would orphan the caps' chord edges and OCCT
    // would split the shell (measured +11.8% volume on 3 solids).
    const tube = exportSTEP(facetedTube());
    const tEnts = parseEntities(tube);
    expect((tube.match(/ADVANCED_FACE/g) ?? []).length).toBe(57); // 55 facets + 2 caps
    expect((tube.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1); // ONE shared surface
    expect((tube.match(/CIRCLE\(/g) ?? []).length).toBe(0);
    expect((tube.match(/PLANE\(/g) ?? []).length).toBe(2);
    // Every facet's ADVANCED_FACE points at the same surface entity.
    const surfRefs = [...tEnts.values()]
      .filter((e) => e.type === 'ADVANCED_FACE')
      .map((f) => f.args[2])
      .filter((s) => tEnts.get(Number(s!.replace('#', '')))?.type === 'CYLINDRICAL_SURFACE');
    expect(surfRefs).toHaveLength(55);
    expect(new Set(surfRefs).size).toBe(1);
  });

  it('drilled box: 61 faces (6 PLANE + 55 facets on 1 CYLINDRICAL_SURFACE), no CIRCLEs', () => {
    const holed = exportSTEP(facetedHoledBox());
    expect((holed.match(/ADVANCED_FACE/g) ?? []).length).toBe(61);
    expect((holed.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((holed.match(/PLANE\(/g) ?? []).length).toBe(6);
    expect((holed.match(/CIRCLE\(/g) ?? []).length).toBe(0);
    // The file carries the curved token that routes re-import through the
    // exact OCCT kernel (stepOCCT's stepNeedsExactKernel).
    expect(stepNeedsExactKernel(holed)).toBe(true);
  });

  it('hole-wall facets flip same_sense (inward normals)', () => {
    const hEnts = parseEntities(exportSTEP(facetedHoledBox()));
    const wallFaces = [...hEnts.values()].filter((e) => e.type === 'ADVANCED_FACE' && e.args[3] === '.F.');
    expect(wallFaces).toHaveLength(55); // every wall facet, no planar face
  });

  it('partial arcs keep their faceted polyline on the analytic surface (no CIRCLEs)', () => {
    const half = exportSTEP(halfBandBody());
    const hEnts = parseEntities(half);
    expect((half.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((half.match(/CIRCLE\(/g) ?? []).length).toBe(0);
    // The boundary stays the given polyline: 24 loop segments, all LINEs.
    const face = [...hEnts.values()].find((e) => e.type === 'ADVANCED_FACE')!;
    const bound = hEnts.get(Number(face.args[1]!.replace(/^\(|\)$/g, '').replace('#', '')))!;
    const loop = hEnts.get(Number(bound.args[1]!.replace('#', '')))!;
    const oeIds = loop
      .args[1]!.replace(/^\(|\)$/g, '')
      .split(',')
      .map((s) => Number(s.replace('#', '')));
    expect(oeIds).toHaveLength(24);
    for (const oeId of oeIds) {
      const oe = hEnts.get(oeId)!;
      const edge = hEnts.get(Number(oe.args[3]!.replace('#', '')))!;
      expect(hEnts.get(Number(edge.args[3]!.replace('#', '')))!.type).toBe('LINE');
    }
  });

  it('a tag that does not fit the vertices falls back to the same polyline form', () => {
    const tube = facetedTube();
    for (const f of tube.faces) {
      const src = (f as TaggedFace).source;
      if (src) src.radius = 5; // vertices sit at r = 3
    }
    const bad = exportSTEP(tube);
    expect((bad.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((bad.match(/CIRCLE\(/g) ?? []).length).toBe(0);
    const bEnts = parseEntities(bad);
    const surf = [...bEnts.values()].find((e) => e.type === 'CYLINDRICAL_SURFACE')!;
    expect(Number(surf.args[2])).toBeCloseTo(5, 6); // the tagged radius, honoured
  });
});

describe('exportSTEP: vertex identity alignment (audit P3)', () => {
  it('drops loop repeats at 1e-7 — no zero-length LINE survives dedup', () => {
    // The second vertex repeats the first 4e-8 later: below the old 1e-9
    // dedup threshold's reach but inside the entity key's 1e-7 grid, so the
    // pre-alignment writer emitted a zero-magnitude VECTOR/LINE between two
    // distinct loop positions that mapped to one VERTEX_POINT.
    const face: Face = {
      id: 'quad',
      normal: { x: 0, y: 0, z: 1 },
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 4e-8, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ],
    };
    const step = exportSTEP(bodyOf('P3', [face]));
    const mags = [...step.matchAll(/VECTOR\('',#(\d+),([\d.eE+-]+)\);/g)].map((m) => Number(m[2]));
    expect(mags).toHaveLength(3); // the quad collapsed to a clean triangle
    expect(mags.every((m) => m > 1e-9)).toBe(true); // no zero-length edges
  });

  it('keeps vertices 3e-7 apart as distinct entities (identity scale = 1e-7)', () => {
    // Above the aligned 1e-7 scale the two triangles must NOT share a
    // VERTEX_POINT (the old 1e-6 key merged them).
    const t1: Face = {
      id: 't1',
      normal: { x: 0, y: 0, z: 1 },
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
    };
    const t2: Face = {
      id: 't2',
      normal: { x: 0, y: 0, z: 1 },
      vertices: [{ x: 3e-7, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
    };
    const step = exportSTEP(bodyOf('P3b', [t1, t2]));
    // The two exactly-shared corners collapse to one VERTEX_POINT each; only
    // the 3e-7-apart pair stays distinct: 3 + 3 − 2 = 4 vertices, 5 unique edges.
    expect((step.match(/VERTEX_POINT/g) ?? []).length).toBe(4);
    expect((step.match(/EDGE_CURVE/g) ?? []).length).toBe(5);
  });
});

describe('exportSTEP: analytic bands and the real boolean pipeline', () => {
  beforeAll(async () => {
    await warmUpBooleanEngine();
  });

  it('the tube form shrinks an isolated band ≥5× vs its faceted export', () => {
    // Same body twice; only the source tag differs. Faceted: 110 rim/vertical
    // LINE edges + 110 VERTEX_POINTs. Analytic: 2 CIRCLEs + 1 seam + 2
    // vertices. (For drilled solids with caps the rims are shared and the
    // writer keeps the chord boundary — the shrink there is the surface
    // dedup only.)
    const tagged = exportSTEP(isolatedBand());
    const plain = isolatedBand();
    for (const f of plain.faces) delete (f as TaggedFace).source;
    const faceted = exportSTEP(plain);
    // Measured: 31,540 bytes faceted vs 2,729 bytes analytic — 11.6×. (For
    // drilled solids with caps the rims are shared and the writer keeps the
    // chord boundary, so the shrink there is the shared-surface dedup only.)
    expect(
      faceted.length / tagged.length,
      `faceted ${faceted.length} bytes vs analytic ${tagged.length} bytes`,
    ).toBeGreaterThanOrEqual(5);
  });

  it('a real Manifold drilled box exports one shared analytic surface per hole', () => {
    // The classifier's intent (tagCylinderSources tags every wall facet);
    // simulated per-facet here because the landed classifier's eigen rank
    // check currently rejects cylinder groups (their WIP, not this writer's).
    const box = createBox(20, 20, 20);
    const hole = createCylinder(3, 22); // spans y∈[0,22] ⊇ the box — through cut
    const raw = booleanOpManifold(box, hole, 'difference');
    expect(raw).not.toBeNull();
    let taggedCount = 0;
    for (const f of raw!.faces) {
      if (Math.abs(f.normal.y) < 0.1 && f.vertices.every((v) => Math.abs(Math.hypot(v.x, v.z) - 3) < 0.01)) {
        (f as TaggedFace).source = cylSource(3);
        taggedCount++;
      }
    }
    expect(taggedCount).toBeGreaterThan(3);
    const text = exportSTEP(raw!);
    expect((text.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1); // shared
    expect((text.match(/CIRCLE\(/g) ?? []).length).toBe(0); // rims shared with caps
    // Every LINE boundary survives the faceted importer with the exact volume.
    const back = importSTEP(text);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(raw!), 2);
  });
});
