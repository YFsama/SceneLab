import { describe, it, expect, beforeAll } from 'vitest';
import { exportSTEP } from './step';
import { importSTEP } from './stepImport';
import {
  createBox,
  createCone,
  createCylinder,
  createSphere,
  buildEdgesFromFaces,
  adaptiveSegments,
  computeVolume,
} from '../geometry/brep';
import { warmUpBooleanEngine, booleanOpManifold } from '../geometry/booleanManifold';
import { translateBody } from '../geometry/operations';
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

// ---------------------------------------------------------------------------
// Analytic cone / sphere / torus faces (the P2a FaceSource extension). Cone
// bands mirror the cylinder contract: isolated two-rim bands collapse to the
// CIRCLE tube form on a CONICAL_SURFACE (rim radius r(t) = t·tan θ from the
// apex, the seam a generator LINE); shared rims keep the chord boundary on
// one shared surface. Sphere/torus tags have no classifier producer yet —
// these tests hand-construct faces to prove the writer format.
// ---------------------------------------------------------------------------

/** Local widening of Face carrying the extended `source` tag. */
type TaggedSource = NonNullable<Face['source']>;

/** Ring of the frustum at height y: r(y) = (30 − y)/3 (⌀20 → ⌀10 over 15). */
function coneRingPoints(y: number, count: number): Vec3[] {
  const r = (30 - y) / 3;
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r });
  }
  return pts;
}

/** The ⌀20→⌀10 frustum's exact cone tag: r(t) = t/3 degenerates at t = 30. */
const frustumSource = (): TaggedSource => ({
  kind: 'cone',
  apex: { x: 0, y: 30, z: 0 },
  axis: { x: 0, y: -1, z: 0 },
  halfAngle: Math.atan(1 / 3),
});

/** An ISOLATED frustum wall band (no face shares its rims) → tube form. */
function isolatedConeBand(): SolidBody {
  const n = adaptiveSegments(20);
  const wall: Face & { source?: TaggedSource } = {
    id: 'coneWall',
    vertices: [...coneRingPoints(0, n), ...coneRingPoints(15, n)],
    normal: { x: 1, y: 0, z: 0 },
    source: frustumSource(),
  };
  return bodyOf('ConeBand', [wall]);
}

/** A capped frustum solid the way the classifier shapes it: n tagged wall
 *  quads + 2 plane caps that share the rim vertices (chord boundary form). */
function facetedFrustum(): SolidBody {
  const n = adaptiveSegments(20);
  const p = (a: number, y: number): Vec3 => {
    const r = (30 - y) / 3;
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  };
  const c = Math.cos(Math.atan(1 / 3));
  const s = Math.sin(Math.atan(1 / 3));
  const wall: Array<Face & { source?: TaggedSource }> = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    // Outward facet normal of the cone: radial·cos θ + ŷ·sin θ (widens down).
    wall.push({
      id: `coneFacet_${i}`,
      vertices: [p(a0, 0), p(a1, 0), p(a1, 15), p(a0, 15)],
      normal: { x: c * Math.cos(mid), y: s, z: c * Math.sin(mid) },
      source: frustumSource(),
    });
  }
  const capB: Face = { id: 'capB', vertices: [...coneRingPoints(0, n)].reverse(), normal: { x: 0, y: -1, z: 0 } };
  const capT: Face = { id: 'capT', vertices: coneRingPoints(15, n), normal: { x: 0, y: 1, z: 0 } };
  return bodyOf('Frustum', [...wall, capB, capT]);
}

/** Two quads on a r=5 sphere around +Y, tagged sphere (hand-set). */
function spherePatchBody(inward = false): SolidBody {
  const sp = (theta: number, phi: number): Vec3 => {
    const st = Math.sin(theta);
    return { x: 5 * st * Math.cos(phi), y: 5 * Math.cos(theta), z: 5 * st * Math.sin(phi) };
  };
  const quad = (t0: number, t1: number, f0: number, f1: number, tagId: string): Face & { source?: TaggedSource } => {
    const mid = sp((t0 + t1) / 2, (f0 + f1) / 2);
    const len = Math.hypot(mid.x, mid.y, mid.z);
    const s = inward ? -1 : 1;
    return {
      id: tagId,
      vertices: [sp(t0, f0), sp(t0, f1), sp(t1, f1), sp(t1, f0)],
      normal: { x: (s * mid.x) / len, y: (s * mid.y) / len, z: (s * mid.z) / len },
      source: { kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 5 },
    };
  };
  const d = Math.PI / 12;
  return bodyOf(inward ? 'SphereCavity' : 'SpherePatch', [
    quad(Math.PI / 2 - d, Math.PI / 2, 0, d, 'sq0'),
    quad(Math.PI / 2 - d, Math.PI / 2, d, 2 * d, 'sq1'),
  ]);
}

/** One quad on a torus (major 10, minor 2, axis +Y), tagged torus (hand-set). */
function torusPatchBody(): SolidBody {
  const tp = (u: number, v: number): Vec3 => ({
    x: (10 + 2 * Math.cos(v)) * Math.cos(u),
    y: 2 * Math.sin(v),
    z: (10 + 2 * Math.cos(v)) * Math.sin(u),
  });
  const midU = Math.PI / 36;
  const patch: Face & { source?: TaggedSource } = {
    id: 'torusPatch',
    vertices: [tp(0, 0), tp(Math.PI / 18, 0), tp(Math.PI / 18, Math.PI / 8), tp(0, Math.PI / 8)],
    normal: { x: Math.cos(midU), y: 0, z: Math.sin(midU) },
    source: { kind: 'torus', center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, majorRadius: 10, minorRadius: 2 },
  };
  return bodyOf('TorusPatch', [patch]);
}

describe('exportSTEP: analytic cone faces (Face.source kind:"cone")', () => {
  const text = exportSTEP(isolatedConeBand());
  const ents = parseEntities(text);

  it('an isolated frustum band becomes 1 face + 2 CIRCLE rims + 1 CONICAL_SURFACE', () => {
    expect((text.match(/ADVANCED_FACE/g) ?? []).length).toBe(1);
    expect((text.match(/CONICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((text.match(/CIRCLE\(/g) ?? []).length).toBe(2);
    expect([...ents.values()].filter((e) => e.type === 'EDGE_CURVE')).toHaveLength(3); // 2 circles + 1 seam
    expect((text.match(/VERTEX_POINT/g) ?? []).length).toBe(2); // the two seam points
    // Routes re-import through the exact OCCT kernel.
    expect(stepNeedsExactKernel(text)).toBe(true);
  });

  it('CIRCLE radii follow the section law r(t) = t·tan θ (10 at y=0, 5 at y=15)', () => {
    const circles = [...ents.values()].filter((e) => e.type === 'CIRCLE');
    const radii = circles.map((c) => Number(c.args[2])).sort((a, b) => a - b);
    expect(radii).toEqual([5, 10]);
    // Each circle's placement centre sits on the axis at its rim height.
    for (const c of circles) {
      const placement = ents.get(Number(c.args[1]!.replace('#', '')))!;
      const pt = ents.get(Number(placement.args[1]!.replace('#', '')))!;
      const coords = pt.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
      expect(coords[0]).toBeCloseTo(0, 5);
      expect(coords[2]).toBeCloseTo(0, 5);
      expect([0, 15]).toContain(Math.round(coords[1]!));
    }
  });

  it('CONICAL_SURFACE carries the tag half angle and a tag-derived placement', () => {
    const surf = [...ents.values()].find((e) => e.type === 'CONICAL_SURFACE')!;
    expect(Number(surf.args[2])).toBeCloseTo(Math.tan(Math.atan(1 / 3)), 6); // radius at t = 1 from apex
    expect(Number(surf.args[3])).toBeCloseTo(Math.atan(1 / 3), 6); // semi angle, radians (num() prints 6 decimals)
    // Placement: apex + axis·1 = (0, 29, 0); axis direction = the cone axis.
    const placement = ents.get(Number(surf.args[1]!.replace('#', '')))!;
    const pt = ents.get(Number(placement.args[1]!.replace('#', '')))!;
    const coords = pt.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
    expect(coords[0]).toBeCloseTo(0, 5);
    expect(coords[1]).toBeCloseTo(29, 5);
    expect(coords[2]).toBeCloseTo(0, 5);
    const dir = ents.get(Number(placement.args[2]!.replace('#', '')))!;
    const d = dir.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
    expect(d[1]).toBeCloseTo(-1, 5);
  });

  it('the seam LINE runs along a generator (slanted, not axial)', () => {
    // Seam endpoints are the seam points of the two rims: (10,0,0) → (5,15,0)
    // on the ref-direction ray — the LINE's VECTOR magnitude must be the
    // generator length √(5² + 15²), not the axial 15.
    const lines = [...ents.values()].filter((e) => e.type === 'LINE');
    expect(lines).toHaveLength(1);
    const vec = ents.get(Number(lines[0]!.args[2]!.replace('#', '')))!;
    expect(Number(vec.args[2])).toBeCloseTo(Math.hypot(5, 15), 4);
  });

  it('shared rims (capped frustum) keep the chord boundary on ONE shared surface', () => {
    const solid = facetedFrustum();
    const frustum = exportSTEP(solid);
    const n = adaptiveSegments(20);
    expect((frustum.match(/ADVANCED_FACE/g) ?? []).length).toBe(n + 2);
    expect((frustum.match(/CONICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((frustum.match(/CIRCLE\(/g) ?? []).length).toBe(0); // rims shared with caps
    expect((frustum.match(/PLANE\(/g) ?? []).length).toBe(2);
    // All wall facets share the one surface entity.
    const fEnts = parseEntities(frustum);
    const surfRefs = [...fEnts.values()]
      .filter((e) => e.type === 'ADVANCED_FACE')
      .map((f) => f.args[2])
      .filter((s) => fEnts.get(Number(s!.replace('#', '')))?.type === 'CONICAL_SURFACE');
    expect(surfRefs).toHaveLength(n);
    expect(new Set(surfRefs).size).toBe(1);
    // Faceted round trip through our own importer: exact volume, same faces.
    const back = importSTEP(frustum);
    expect(back.faces).toHaveLength(solid.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(solid), 3);
    // Control: the same solid with tags stripped is unaffected.
    for (const f of solid.faces) delete (f as { source?: TaggedSource }).source;
    const plain = importSTEP(exportSTEP(solid));
    expect(computeVolume(plain)).toBeCloseTo(computeVolume(back), 3);
  });

  it('the real classifier pipeline tags a boolean frustum and exports it analytically', async () => {
    await warmUpBooleanEngine();
    const box = translateBody(createBox(24, 19, 24), { x: 0, y: -2, z: 0 });
    const body = booleanOpManifold(createCone(10, 5, 15), box, 'intersect')!;
    const coneFaces = body.faces.filter((f) => f.source?.kind === 'cone');
    expect(coneFaces.length).toBeGreaterThanOrEqual(24);
    const text = exportSTEP(body);
    expect((text.match(/CONICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((text.match(/CIRCLE\(/g) ?? []).length).toBe(0); // caps share the rims
    expect(stepNeedsExactKernel(text)).toBe(true);
    const back = importSTEP(text);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(body), 2);
  });
});

describe('exportSTEP: analytic sphere and torus faces (hand-set tags)', () => {
  it('sphere-tagged facets share one SPHERICAL_SURFACE with the tag radius', () => {
    const text = exportSTEP(spherePatchBody());
    const ents = parseEntities(text);
    expect((text.match(/SPHERICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((text.match(/ADVANCED_FACE/g) ?? []).length).toBe(2);
    const surf = [...ents.values()].find((e) => e.type === 'SPHERICAL_SURFACE')!;
    expect(Number(surf.args[2])).toBeCloseTo(5, 6);
    const placement = ents.get(Number(surf.args[1]!.replace('#', '')))!;
    const pt = ents.get(Number(placement.args[1]!.replace('#', '')))!;
    const coords = pt.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
    expect(coords).toEqual([0, 0, 0]);
    // Both faces sit on the shared surface, outward → same_sense .T.
    const surfRefs = [...ents.values()]
      .filter((e) => e.type === 'ADVANCED_FACE')
      .map((f) => f.args[2]);
    expect(new Set(surfRefs).size).toBe(1);
    for (const f of ents.values()) {
      if (f.type === 'ADVANCED_FACE') expect(f.args[3]).toBe('.T.');
    }
    expect(stepNeedsExactKernel(text)).toBe(true);
  });

  it('an inward sphere cavity flips same_sense', () => {
    const ents = parseEntities(exportSTEP(spherePatchBody(true)));
    const faces = [...ents.values()].filter((e) => e.type === 'ADVANCED_FACE');
    expect(faces).toHaveLength(2);
    for (const f of faces) expect(f.args[3]).toBe('.F.');
  });

  it('torus-tagged facets emit a TOROIDAL_SURFACE with major/minor radii', () => {
    const text = exportSTEP(torusPatchBody());
    const ents = parseEntities(text);
    expect((text.match(/TOROIDAL_SURFACE/g) ?? []).length).toBe(1);
    const surf = [...ents.values()].find((e) => e.type === 'TOROIDAL_SURFACE')!;
    expect(Number(surf.args[2])).toBeCloseTo(10, 6);
    expect(Number(surf.args[3])).toBeCloseTo(2, 6);
    // Placement axis = the torus axis (+Y).
    const placement = ents.get(Number(surf.args[1]!.replace('#', '')))!;
    const dir = ents.get(Number(placement.args[2]!.replace('#', '')))!;
    const d = dir.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
    expect(d[1]).toBeCloseTo(1, 5);
    expect(d[0]).toBeCloseTo(0, 5);
    expect(stepNeedsExactKernel(text)).toBe(true);
  });
});
